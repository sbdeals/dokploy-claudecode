/**
 * Concrete deployment operations the agent can perform, layered on the existing
 * server-only Dokploy lib. Safe operations run immediately; the four destructive
 * ones are executed here only when the user approves a staged change
 * (`applyStaged`). Everything reuses `dokploy.ts` — the handful of procedures it
 * doesn't yet wrap (templates, compose domains, domain/mount deletion) go
 * through the exported low-level `request`.
 */
import "server-only";
import {
  loadWorkspace,
  listProjects,
  createProject,
  createApplication,
  setAppDockerSource,
  setAppGitSource,
  applicationAction,
  saveApplicationEnvironment,
  createDatabase,
  databaseAction,
  saveEnvironment,
  composeAction,
  request,
  ENGINES,
  type Service,
  type Engine,
} from "@/lib/dokploy";
import { readRecentLogs, runExec, sampleStatsOnce, type Sample } from "@/lib/docker";
import { randomServiceName, randomPassword } from "@/lib/names";
import { ENGINE_META } from "@/lib/engines";
import type { StagedChange } from "./store";

function isEngine(v: string): v is Engine {
  return (ENGINES as readonly string[]).includes(v);
}

/** Resolve a target environment id, creating a default project if none exist. */
async function resolveTargetEnv(environmentId?: string): Promise<string> {
  if (environmentId) return environmentId;
  const envs = (await listProjects()).flatMap((p) => p.environments);
  if (envs.length > 0) return envs[0].environmentId;
  await createProject("My Project");
  const after = (await listProjects()).flatMap((p) => p.environments);
  if (after.length === 0) throw new Error("Could not create a default environment.");
  return after[0].environmentId;
}

/** Find a service by exact id, then by (case-insensitive) name or appName. */
export async function resolveService(idOrName: string): Promise<Service | null> {
  const { services } = await loadWorkspace();
  const needle = idOrName.trim().toLowerCase();
  return (
    services.find((s) => s.id === idOrName) ??
    services.find(
      (s) => s.name.toLowerCase() === needle || s.appName.toLowerCase() === needle
    ) ??
    services.find((s) => s.name.toLowerCase().includes(needle)) ??
    null
  );
}

/** Compact workspace listing for the model. */
export async function workspaceSummary() {
  const { services, projects } = await loadWorkspace();
  return {
    projects: projects.map((p) => ({
      name: p.name,
      environments: p.environments.map((e) => ({ id: e.environmentId, name: e.name })),
    })),
    services: services.map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.kind,
      status: s.status,
      appName: s.appName,
      project: s.projectName,
      environment: s.environmentName,
      image: s.dockerImage,
      ...(s.kind === "application" ? { domains: s.domains.map((d) => d.host) } : {}),
    })),
  };
}

// --- domains (not yet wrapped in dokploy.ts) --------------------------------

function certFor(host: string): { https: boolean; certificateType: string } {
  // Local *.localhost hosts can't answer a Let's Encrypt challenge.
  return host.trim().toLowerCase().endsWith(".localhost")
    ? { https: false, certificateType: "none" }
    : { https: true, certificateType: "letsencrypt" };
}

async function createAppDomain(applicationId: string, host: string, port: number): Promise<void> {
  await request("domain.create", {
    method: "POST",
    body: { applicationId, host, port, path: "/", ...certFor(host) },
  });
}

async function createComposeDomainOp(
  composeId: string,
  serviceName: string,
  host: string,
  port: number
): Promise<void> {
  await request("domain.create", {
    method: "POST",
    body: {
      composeId,
      serviceName,
      host,
      port,
      path: "/",
      domainType: "compose",
      ...certFor(host),
    },
  });
}

// --- templates (compose catalog) --------------------------------------------

interface DokployTemplate {
  id: string;
  name: string;
  description?: string;
}

async function findTemplate(query: string): Promise<DokployTemplate | null> {
  const raw = await request<DokployTemplate[]>("compose.templates");
  const list = raw ?? [];
  const needle = query.trim().toLowerCase();
  return (
    list.find((t) => t.id.toLowerCase() === needle || t.name.toLowerCase() === needle) ??
    list.find((t) => t.name.toLowerCase().includes(needle) || t.id.toLowerCase().includes(needle)) ??
    null
  );
}

// --- safe operations (executed immediately) ---------------------------------

export async function deployDockerImage(
  image: string,
  name?: string,
  environmentId?: string
): Promise<{ id: string; name: string }> {
  const trimmed = image.trim();
  if (!trimmed) throw new Error("Image is required.");
  const derived = trimmed.split("/").pop()!.split(":")[0];
  const finalName = name?.trim() || randomServiceName(derived);
  const id = await createApplication(finalName, await resolveTargetEnv(environmentId));
  await setAppDockerSource(id, trimmed);
  await applicationAction(id, "deploy");
  return { id, name: finalName };
}

export async function deployGitRepo(
  repoUrl: string,
  branch?: string,
  environmentId?: string
): Promise<{ id: string; name: string }> {
  const url = repoUrl.trim();
  if (!url) throw new Error("Repository URL is required.");
  const derived = url.replace(/\.git$/, "").split("/").filter(Boolean).pop() || "app";
  const finalName = randomServiceName(derived);
  const id = await createApplication(finalName, await resolveTargetEnv(environmentId));
  await setAppGitSource(id, url, branch?.trim() || "main");
  await applicationAction(id, "deploy");
  return { id, name: finalName };
}

export async function deployTemplate(
  query: string,
  environmentId?: string
): Promise<{ id: string; name: string }> {
  const tpl = await findTemplate(query);
  if (!tpl) throw new Error(`No template matched "${query}".`);
  const env = await resolveTargetEnv(environmentId);
  const created = await request<{ composeId: string }>("compose.deployTemplate", {
    method: "POST",
    body: { id: tpl.id, environmentId: env },
  });
  // Templates default to isolatedDeployment:true (per-stack network only), which
  // makes any attached domain 404. Join dokploy-network so routing works.
  await request("compose.update", {
    method: "POST",
    body: { composeId: created.composeId, isolatedDeployment: false },
  });
  await composeAction(created.composeId, "deploy");
  return { id: created.composeId, name: tpl.name };
}

export async function createDatabaseOp(
  engine: string,
  name?: string,
  environmentId?: string
): Promise<{ id: string; name: string }> {
  if (!isEngine(engine)) throw new Error(`Unknown engine "${engine}".`);
  const meta = ENGINE_META[engine];
  const finalName = name?.trim() || randomServiceName(engine);
  const id = await createDatabase({
    engine,
    name: finalName,
    environmentId: await resolveTargetEnv(environmentId),
    databasePassword: randomPassword(),
    dockerImage: `${meta.image}:${meta.versions[0]}`,
  });
  await databaseAction(engine, id, "deploy");
  return { id, name: finalName };
}

export async function saveServiceEnvironment(svc: Service, env: string): Promise<void> {
  if (svc.kind === "application") return saveApplicationEnvironment(svc.id, env);
  if (svc.kind === "database") return saveEnvironment(svc.engine, svc.id, env);
  // compose: dedicated saveEnvironment procedure.
  await request("compose.saveEnvironment", { method: "POST", body: { composeId: svc.id, env } });
}

export async function createDomainForService(
  svc: Service,
  host: string,
  port: number,
  serviceName?: string
): Promise<void> {
  if (svc.kind === "compose") {
    if (!serviceName) throw new Error("A compose domain needs the target service name.");
    return createComposeDomainOp(svc.id, serviceName, host, port);
  }
  if (svc.kind === "application") return createAppDomain(svc.id, host, port);
  throw new Error("Domains can only be attached to applications or compose stacks.");
}

export async function lifecycle(
  svc: Service,
  action: "start" | "deploy" | "redeploy"
): Promise<void> {
  const act = action === "redeploy" ? "deploy" : action;
  if (svc.kind === "application") return applicationAction(svc.id, act);
  if (svc.kind === "database") return databaseAction(svc.engine, svc.id, act);
  return composeAction(svc.id, act);
}

export async function recentLogs(svc: Service, tail = 100) {
  return readRecentLogs(svc.appName, Math.min(tail, 300));
}

/**
 * Run one command inside a service's running container and return its captured
 * output — the diagnostic power behind "why is this deployment broken?". Same
 * mechanism (and 15s/1MB caps) as the dashboard's Console tab; the container is
 * resolved by the service's own appName, so the agent can only reach services
 * it can already see. For a compose stack this hits the first matching
 * container; target a specific one by passing its full container name as the
 * service (it resolves by name prefix).
 */
export async function execInService(
  svc: Service,
  command: string
): Promise<{ stdout: string; stderr: string; exitCode: number | null; truncated: boolean } | null> {
  return runExec(svc.appName, command);
}

/** One CPU/memory sample for a running service (null if it isn't running). */
export async function serviceMetrics(svc: Service): Promise<Sample | null> {
  return sampleStatsOnce(svc.appName);
}

export async function updateApplicationOp(
  svc: Service,
  patch: { replicas?: number; cpuLimit?: string | null; memoryLimit?: string | null }
): Promise<void> {
  if (svc.kind !== "application") throw new Error("update_application only applies to applications.");
  const body: Record<string, unknown> = { applicationId: svc.id };
  if (patch.replicas !== undefined) body.replicas = patch.replicas;
  if (patch.cpuLimit !== undefined) body.cpuLimit = patch.cpuLimit;
  if (patch.memoryLimit !== undefined) body.memoryLimit = patch.memoryLimit;
  await request("application.update", { method: "POST", body });
}

// --- destructive operations (executed only on approval) ---------------------

async function deleteService(kind: string, id: string, engine?: string): Promise<void> {
  if (kind === "application") return applicationAction(id, "remove");
  if (kind === "compose") return composeAction(id, "remove");
  if (kind === "database" && engine && isEngine(engine)) return databaseAction(engine, id, "remove");
  throw new Error("Could not resolve the service to delete.");
}

async function stopService(kind: string, id: string, engine?: string): Promise<void> {
  if (kind === "application") return applicationAction(id, "stop");
  if (kind === "compose") return composeAction(id, "stop");
  if (kind === "database" && engine && isEngine(engine)) return databaseAction(engine, id, "stop");
  throw new Error("Could not resolve the service to stop.");
}

/** Execute a previously-staged destructive change after user approval. */
export async function applyStaged(change: StagedChange): Promise<void> {
  const p = change.params as Record<string, string>;
  switch (change.kind) {
    case "delete_service":
      return deleteService(p.kind, p.id, p.engine);
    case "stop_service":
      return stopService(p.kind, p.id, p.engine);
    case "delete_domain":
      await request("domain.delete", { method: "POST", body: { domainId: p.domainId } });
      return;
    case "delete_mount":
      await request("mounts.remove", { method: "POST", body: { mountId: p.mountId } });
      return;
  }
}
