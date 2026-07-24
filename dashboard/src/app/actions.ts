"use server";

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import {
  createDatabase,
  databaseAction,
  createProject,
  renameProject,
  removeProject,
  createEnvironment,
  renameEnvironment,
  removeEnvironment,
  listProjects,
  saveEnvironment,
  updateDatabase,
  reloadDatabase,
  createApplication,
  setAppDockerSource,
  setAppGitSource,
  setAppAutoDeploy,
  rollbackToDeployment,
  setAppGithubSource,
  listGithubProviders,
  listGithubRepositories,
  listGithubBranches,
  githubConnectUrl,
  type GithubProvider,
  type GithubRepository,
  type GithubBranch,
  applicationAction,
  updateApplication,
  saveAppBuildType,
  saveApplicationEnvironment,
  createDomain,
  createComposeDomain,
  ensureAutoDomain,
  generateHostFor,
  updateDomain,
  deleteDomain,
  createRedirect,
  deleteRedirect,
  createPort,
  deletePort,
  createSecurity,
  deleteSecurity,
  createCompose,
  composeAction,
  updateComposeFile,
  saveComposeEnvironment,
  listTemplates,
  deployTemplate,
  listSchedules,
  createSchedule,
  updateSchedule,
  deleteSchedule,
  runSchedule,
  listMounts,
  createMount,
  updateMount,
  removeMount,
  type Action,
  type DatabasePatch,
  type ApplicationPatch,
  type BuildTypePatch,
  type DomainInput,
  type Engine,
  type DokployTemplate,
  type Schedule,
  type CreateScheduleInput,
  type UpdateScheduleInput,
  type Mount,
  type MountServiceType,
  type CreateMountInput,
  type MountPatch,
} from "@/lib/dokploy";
// Backups: S3 destinations + scheduled database backups (see the "backups"
// section below). Kept as a separate import to reduce merge churn.
import {
  listDestinations,
  createDestination,
  testDestination,
  removeDestination,
  listDatabaseBackups,
  createDatabaseBackup,
  updateDatabaseBackup,
  removeDatabaseBackup,
  runDatabaseBackup,
  listBackupFiles,
  restoreBackup,
  type BackupEngine,
  type S3Destination,
  type DatabaseBackup,
  type BackupFile,
  type CreateDestinationInput,
  type CreateBackupInput,
  type UpdateBackupInput,
  type RestoreBackupInput,
} from "@/lib/dokploy";
import { ENGINE_META } from "@/lib/engines";
import { randomPassword, randomServiceName } from "@/lib/names";

export type ActionResult = { ok: true } | { ok: false; error: string };
export type QuickDeployResult = { ok: true; id: string } | { ok: false; error: string };
/** Result of the "Generate URL" action: the freshly-attached host on success. */
export type GenerateUrlResult = { ok: true; host: string } | { ok: false; error: string };

function fail(e: unknown): { ok: false; error: string } {
  return { ok: false, error: e instanceof Error ? e.message : String(e) };
}

/** Run a mutation, revalidate the page, normalize errors into the result. */
async function wrap(fn: () => Promise<unknown>): Promise<ActionResult> {
  try {
    await fn();
    revalidatePath("/");
    return { ok: true };
  } catch (e) {
    unstable_rethrow(e); // let a /login redirect on an expired session through
    return fail(e);
  }
}

/** Like `wrap`, but returns the created id so the UI can open its drawer. */
async function wrapId(fn: () => Promise<string>): Promise<QuickDeployResult> {
  try {
    const id = await fn();
    revalidatePath("/");
    return { ok: true, id };
  } catch (e) {
    unstable_rethrow(e); // let a /login redirect on an expired session through
    return fail(e);
  }
}

/** Like `wrap`, but returns the generated host so the UI can surface it. */
async function wrapHost(fn: () => Promise<string>): Promise<GenerateUrlResult> {
  try {
    const host = await fn();
    revalidatePath("/");
    return { ok: true, host };
  } catch (e) {
    unstable_rethrow(e); // let a /login redirect on an expired session through
    return fail(e);
  }
}

/** Resolve a target environment, creating a default project/env if none exist. */
async function resolveTargetEnv(environmentId?: string): Promise<string> {
  if (environmentId) return environmentId;
  const envs = (await listProjects()).flatMap((p) => p.environments);
  if (envs.length > 0) return envs[0].environmentId;
  // No project yet — create one (Dokploy auto-creates a default environment).
  await createProject("My Project");
  const after = (await listProjects()).flatMap((p) => p.environments);
  if (after.length === 0) throw new Error("Could not create a default environment.");
  return after[0].environmentId;
}

// --- databases ----------------------------------------------------------------

/**
 * One-click: provision a database with a random name + password and the latest
 * version, then deploy it.
 */
export async function quickDeployDatabaseAction(
  engine: Engine,
  environmentId?: string
): Promise<QuickDeployResult> {
  return wrapId(async () => {
    const meta = ENGINE_META[engine];
    const id = await createDatabase({
      engine,
      name: randomServiceName(engine),
      environmentId: await resolveTargetEnv(environmentId),
      databasePassword: randomPassword(),
      dockerImage: `${meta.image}:${meta.versions[0]}`,
    });
    await databaseAction(engine, id, "deploy");
    return id;
  });
}

export async function lifecycleAction(
  engine: Engine,
  id: string,
  action: Action
): Promise<ActionResult> {
  return wrap(() => databaseAction(engine, id, action));
}

/**
 * Patch a database's settings. Image/resource/port changes are applied to the
 * running container with a reload.
 */
export async function updateDatabaseAction(
  engine: Engine,
  id: string,
  appName: string,
  patch: DatabasePatch
): Promise<ActionResult> {
  return wrap(async () => {
    await updateDatabase(engine, id, patch);
    const needsReload =
      patch.dockerImage !== undefined ||
      patch.cpuLimit !== undefined ||
      patch.memoryLimit !== undefined ||
      patch.externalPort !== undefined;
    if (needsReload) await reloadDatabase(engine, id, appName);
  });
}

export async function saveEnvironmentAction(
  engine: Engine,
  id: string,
  env: string
): Promise<ActionResult> {
  return wrap(() => saveEnvironment(engine, id, env));
}

// --- projects & environments ------------------------------------------------

export async function createProjectAction(name: string): Promise<ActionResult> {
  return wrap(() => createProject(name));
}
export async function renameProjectAction(id: string, name: string): Promise<ActionResult> {
  return wrap(() => renameProject(id, name));
}
export async function removeProjectAction(id: string): Promise<ActionResult> {
  return wrap(() => removeProject(id));
}
export async function createEnvironmentAction(
  projectId: string,
  name: string
): Promise<ActionResult> {
  return wrap(() => createEnvironment(projectId, name));
}
export async function renameEnvironmentAction(id: string, name: string): Promise<ActionResult> {
  return wrap(() => renameEnvironment(id, name));
}
export async function removeEnvironmentAction(id: string): Promise<ActionResult> {
  return wrap(() => removeEnvironment(id));
}

// --- applications -----------------------------------------------------------

/** One-click: create an application from a Docker image and deploy it. */
export async function quickDeployImageAction(
  image: string,
  name?: string,
  environmentId?: string
): Promise<QuickDeployResult> {
  return wrapId(async () => {
    const trimmed = image.trim();
    if (!trimmed) throw new Error("Image is required.");
    // Derive a friendly name from the image (e.g. "nginx:alpine" -> "nginx").
    const derived = trimmed.split("/").pop()!.split(":")[0];
    const id = await createApplication(
      name?.trim() || randomServiceName(derived),
      await resolveTargetEnv(environmentId)
    );
    await setAppDockerSource(id, trimmed);
    await applicationAction(id, "deploy");
    await mintAutoDomain(id);
    return id;
  });
}

/** Deploy an application from a public Git repository (Nixpacks build). */
export async function quickDeployRepoAction(
  repoUrl: string,
  branch?: string,
  environmentId?: string
): Promise<QuickDeployResult> {
  return wrapId(async () => {
    const url = repoUrl.trim();
    if (!url) throw new Error("Repository URL is required.");
    // Derive a name from the repo (".../my-app.git" -> "my-app").
    const derived = url.replace(/\.git$/, "").split("/").filter(Boolean).pop() || "app";
    const id = await createApplication(
      randomServiceName(derived),
      await resolveTargetEnv(environmentId)
    );
    await setAppGitSource(id, url, branch?.trim() || "main");
    await applicationAction(id, "deploy");
    await mintAutoDomain(id);
    return id;
  });
}

/**
 * Best-effort: give a freshly-deployed app a public URL (no-op off the
 * Linux/Traefik path — see `ensureAutoDomain`). Never fails the deploy over
 * domain creation; the user can always add one in the Domains tab.
 */
async function mintAutoDomain(applicationId: string): Promise<void> {
  try {
    await ensureAutoDomain(applicationId);
  } catch {
    /* leave the app domain-less rather than failing the deploy */
  }
}

// --- github app (private repos) ---------------------------------------------

export type ListResult<T> = { ok: true; data: T } | { ok: false; error: string };

function listOk<T>(data: T): ListResult<T> {
  return { ok: true, data };
}

/** Configured GitHub App connections + the Dokploy URL to add a new one. */
export async function githubConnectionsAction(): Promise<
  ListResult<{ providers: GithubProvider[]; connectUrl: string }>
> {
  try {
    const providers = await listGithubProviders();
    return listOk({ providers, connectUrl: githubConnectUrl() });
  } catch (e) {
    return fail(e);
  }
}

export async function githubRepositoriesAction(
  githubId: string
): Promise<ListResult<GithubRepository[]>> {
  try {
    return listOk(await listGithubRepositories(githubId));
  } catch (e) {
    return fail(e);
  }
}

export async function githubBranchesAction(
  githubId: string,
  owner: string,
  repo: string
): Promise<ListResult<GithubBranch[]>> {
  try {
    return listOk(await listGithubBranches(githubId, owner, repo));
  } catch (e) {
    return fail(e);
  }
}

/**
 * One-click: create an application pointed at a private repo through a GitHub
 * App installation, then deploy it. A push to `branch` auto-deploys thereafter.
 */
export async function quickDeployGithubAction(input: {
  githubId: string;
  owner: string;
  repository: string;
  branch: string;
  environmentId?: string;
}): Promise<QuickDeployResult> {
  return wrapId(async () => {
    const { githubId, owner, repository, branch } = input;
    if (!githubId || !owner || !repository || !branch)
      throw new Error("Installation, repository and branch are required.");
    const id = await createApplication(
      randomServiceName(repository),
      await resolveTargetEnv(input.environmentId)
    );
    await setAppGithubSource(id, { githubId, owner, repository, branch });
    await applicationAction(id, "deploy");
    await mintAutoDomain(id);
    return id;
  });
}

export async function appLifecycleAction(id: string, action: Action): Promise<ActionResult> {
  return wrap(() => applicationAction(id, action));
}

export async function updateApplicationAction(
  id: string,
  patch: ApplicationPatch,
  redeploy = false
): Promise<ActionResult> {
  return wrap(async () => {
    await updateApplication(id, patch);
    if (redeploy) await applicationAction(id, "deploy");
  });
}

export async function saveApplicationEnvAction(id: string, env: string): Promise<ActionResult> {
  return wrap(() => saveApplicationEnvironment(id, env));
}

/** Set an application's build strategy (Nixpacks / Dockerfile / Railpack / …). */
export async function saveAppBuildTypeAction(
  id: string,
  patch: BuildTypePatch,
  redeploy = false
): Promise<ActionResult> {
  return wrap(async () => {
    await saveAppBuildType(id, patch);
    if (redeploy) await applicationAction(id, "deploy");
  });
}

/**
 * Point a docker-image application at an image, optionally with private
 * registry credentials. Empty credentials mean a public image.
 */
export async function setAppDockerSourceAction(
  id: string,
  dockerImage: string,
  registry?: { username: string; password: string; registryUrl: string },
  redeploy = false
): Promise<ActionResult> {
  return wrap(async () => {
    const image = dockerImage.trim();
    if (!image) throw new Error("Image is required.");
    const hasCreds = registry && (registry.username || registry.password || registry.registryUrl);
    await setAppDockerSource(id, image, hasCreds ? registry : undefined);
    if (redeploy) await applicationAction(id, "deploy");
  });
}

export async function createDomainAction(
  applicationId: string,
  input: DomainInput
): Promise<ActionResult> {
  return wrap(() => createDomain(applicationId, { ...input, host: input.host.trim() }));
}

export async function updateDomainAction(
  domainId: string,
  input: DomainInput
): Promise<ActionResult> {
  return wrap(() => updateDomain(domainId, { ...input, host: input.host.trim() }));
}

export async function deleteDomainAction(domainId: string): Promise<ActionResult> {
  return wrap(() => deleteDomain(domainId));
}

/**
 * Generate + attach a random public URL to an application with zero typing.
 * The host follows the install's auto-URL conventions (`.localhost` on Docker
 * Desktop, `*.traefik.me`/sslip.io on Linux); it is attached on the form's
 * currently-selected `port`. Returns the new host so the UI can highlight it.
 */
export async function generateDomainAction(
  applicationId: string,
  serviceName: string,
  port: number
): Promise<GenerateUrlResult> {
  return wrapHost(async () => {
    const g = await generateHostFor(serviceName);
    await createDomain(applicationId, {
      host: g.host,
      port,
      https: g.https,
      certificateType: g.certificateType,
      path: "/",
    });
    return g.host;
  });
}

/** Attach a domain to a compose service. `serviceName` is the compose service to route to. */
export async function createComposeDomainAction(
  composeId: string,
  serviceName: string,
  host: string,
  port: number
): Promise<ActionResult> {
  return wrap(() => createComposeDomain(composeId, serviceName.trim(), host.trim(), port));
}

/**
 * Compose analog of `generateDomainAction`: mint a random host and route it to
 * one service in the stack. `serviceName` is the compose service to target;
 * `labelName` (usually that same service name) seeds the host prefix.
 */
export async function generateComposeDomainAction(
  composeId: string,
  serviceName: string,
  labelName: string,
  port: number
): Promise<GenerateUrlResult> {
  return wrapHost(async () => {
    const g = await generateHostFor(labelName || serviceName);
    await createComposeDomain(composeId, serviceName.trim(), g.host, port, {
      https: g.https,
      certificateType: g.certificateType,
    });
    return g.host;
  });
}

// Networking config (applies on next deploy) — verified Dokploy v0.29.x shapes.

export async function createRedirectAction(
  applicationId: string,
  regex: string,
  replacement: string,
  permanent: boolean
): Promise<ActionResult> {
  return wrap(() =>
    createRedirect(applicationId, {
      regex: regex.trim(),
      replacement: replacement.trim(),
      permanent,
    })
  );
}

export async function deleteRedirectAction(redirectId: string): Promise<ActionResult> {
  return wrap(() => deleteRedirect(redirectId));
}

export async function createPortAction(
  applicationId: string,
  publishedPort: number,
  targetPort: number,
  protocol: "tcp" | "udp",
  publishMode: "host" | "ingress"
): Promise<ActionResult> {
  return wrap(() => createPort(applicationId, { publishedPort, targetPort, protocol, publishMode }));
}

export async function deletePortAction(portId: string): Promise<ActionResult> {
  return wrap(() => deletePort(portId));
}

export async function createSecurityAction(
  applicationId: string,
  username: string,
  password: string
): Promise<ActionResult> {
  return wrap(() => createSecurity(applicationId, { username: username.trim(), password }));
}

export async function deleteSecurityAction(securityId: string): Promise<ActionResult> {
  return wrap(() => deleteSecurity(securityId));
}

// --- push-to-deploy + rollback ----------------------------------------------
// (Deploys-tab actions. Kept in their own section so the application actions
//  above stay untouched.)

/**
 * Update a custom-git app's push-to-deploy config: branch, watch paths, and the
 * auto-deploy toggle that gates Dokploy's deploy webhook. `gitUrl`/`buildPath`
 * are re-sent because Dokploy's `saveGitProvider` replaces the whole git config;
 * the client passes the app's current values back. When `gitUrl` is absent the
 * git config is left untouched and only auto-deploy is changed.
 */
export async function updateGitDeployAction(
  applicationId: string,
  config: {
    gitUrl?: string | null;
    branch?: string;
    buildPath?: string;
    watchPaths?: string[];
    autoDeploy: boolean;
  }
): Promise<ActionResult> {
  return wrap(async () => {
    if (config.gitUrl) {
      await setAppGitSource(
        applicationId,
        config.gitUrl,
        config.branch?.trim() || "main",
        config.buildPath?.trim() || "/",
        (config.watchPaths ?? []).map((p) => p.trim()).filter(Boolean)
      );
    }
    await setAppAutoDeploy(applicationId, config.autoDeploy);
  });
}

/**
 * Roll an application back to a past deployment's image snapshot. `rollbackId`
 * comes from a deployment history row (non-null only when that deploy recorded
 * a registry image); see `rollbackToDeployment`.
 */
export async function rollbackDeploymentAction(rollbackId: string): Promise<ActionResult> {
  return wrap(() => rollbackToDeployment(rollbackId));
}

// --- schedules --------------------------------------------------------------

export type SchedulesResult =
  | { ok: true; schedules: Schedule[] }
  | { ok: false; error: string };

/** Load an application's cron schedules (called on demand by the drawer tab). */
export async function listSchedulesAction(applicationId: string): Promise<SchedulesResult> {
  try {
    return { ok: true, schedules: await listSchedules(applicationId) };
  } catch (e) {
    return fail(e);
  }
}

export async function createScheduleAction(input: CreateScheduleInput): Promise<ActionResult> {
  return wrap(() => createSchedule(input));
}

export async function updateScheduleAction(
  scheduleId: string,
  input: UpdateScheduleInput
): Promise<ActionResult> {
  return wrap(() => updateSchedule(scheduleId, input));
}

export async function deleteScheduleAction(scheduleId: string): Promise<ActionResult> {
  return wrap(() => deleteSchedule(scheduleId));
}

export async function runScheduleAction(scheduleId: string): Promise<ActionResult> {
  return wrap(() => runSchedule(scheduleId));
}

// --- compose ----------------------------------------------------------------

/** Create a blank compose stack (seeded with a starter file). */
export async function createComposeAction(
  name?: string,
  environmentId?: string
): Promise<QuickDeployResult> {
  return wrapId(async () =>
    createCompose(name?.trim() || randomServiceName("compose"), await resolveTargetEnv(environmentId))
  );
}

export async function composeLifecycleAction(id: string, action: Action): Promise<ActionResult> {
  return wrap(() => composeAction(id, action));
}

export async function saveComposeFileAction(
  id: string,
  composeFile: string,
  redeploy = false
): Promise<ActionResult> {
  return wrap(async () => {
    await updateComposeFile(id, composeFile);
    if (redeploy) await composeAction(id, "deploy");
  });
}

export async function saveComposeEnvAction(id: string, env: string): Promise<ActionResult> {
  return wrap(() => saveComposeEnvironment(id, env));
}

// --- backups ----------------------------------------------------------------
//
// Wraps Dokploy's S3 destinations + per-database scheduled backups. Mutations
// use the shared `wrap()`; the list/read actions return data, so they carry
// their own result shapes (mirroring `wrap`'s error normalization via `fail`).

export type DestinationsResult =
  | { ok: true; destinations: S3Destination[] }
  | { ok: false; error: string };
export type BackupsResult =
  | { ok: true; backups: DatabaseBackup[] }
  | { ok: false; error: string };
export type BackupFilesResult =
  | { ok: true; files: BackupFile[] }
  | { ok: false; error: string };

export async function listDestinationsAction(): Promise<DestinationsResult> {
  try {
    return { ok: true, destinations: await listDestinations() };
  } catch (e) {
    return fail(e);
  }
}

export async function testDestinationAction(
  input: CreateDestinationInput
): Promise<ActionResult> {
  // testConnection is a read-only probe; no revalidation needed but harmless.
  return wrap(() => testDestination(input));
}

export async function createDestinationAction(
  input: CreateDestinationInput
): Promise<ActionResult> {
  return wrap(() => createDestination(input));
}

export async function removeDestinationAction(destinationId: string): Promise<ActionResult> {
  return wrap(() => removeDestination(destinationId));
}

export async function listDatabaseBackupsAction(
  engine: BackupEngine,
  id: string
): Promise<BackupsResult> {
  try {
    return { ok: true, backups: await listDatabaseBackups(engine, id) };
  } catch (e) {
    return fail(e);
  }
}

export async function createDatabaseBackupAction(
  input: CreateBackupInput
): Promise<ActionResult> {
  return wrap(() => createDatabaseBackup(input));
}

export async function updateDatabaseBackupAction(
  input: UpdateBackupInput
): Promise<ActionResult> {
  return wrap(() => updateDatabaseBackup(input));
}

export async function removeDatabaseBackupAction(backupId: string): Promise<ActionResult> {
  return wrap(() => removeDatabaseBackup(backupId));
}

/** Trigger an immediate "back up now" run. */
export async function runDatabaseBackupAction(
  engine: BackupEngine,
  backupId: string
): Promise<ActionResult> {
  return wrap(() => runDatabaseBackup(engine, backupId));
}

export async function listBackupFilesAction(
  destinationId: string,
  search = ""
): Promise<BackupFilesResult> {
  try {
    return { ok: true, files: await listBackupFiles(destinationId, search) };
  } catch (e) {
    return fail(e);
  }
}

/** Restore a backup (destructive — the UI confirms before calling this). */
export async function restoreBackupAction(input: RestoreBackupInput): Promise<ActionResult> {
  return wrap(() => restoreBackup(input));
}

// --- templates (one-click catalog) ------------------------------------------

export type TemplateListResult =
  | { ok: true; templates: DokployTemplate[] }
  | { ok: false; error: string };

/** Fetch Dokploy's one-click template catalog for the New-service menu. */
export async function listTemplatesAction(): Promise<TemplateListResult> {
  try {
    return { ok: true, templates: await listTemplates() };
  } catch (e) {
    return fail(e);
  }
}

/**
 * One-click: provision a catalog template into an environment (Dokploy creates
 * the compose stack from the template) and deploy it, matching the other quick
 * deploys. Returns the new compose service id so the UI can open its drawer.
 */
export async function quickDeployTemplateAction(
  templateId: string,
  environmentId?: string
): Promise<QuickDeployResult> {
  return wrapId(async () => {
    const id = templateId.trim();
    if (!id) throw new Error("Template is required.");
    const composeId = await deployTemplate(id, await resolveTargetEnv(environmentId));
    await composeAction(composeId, "deploy");
    return composeId;
  });
}

// --- mounts (persistent volumes) --------------------------------------------

export type MountsResult = { ok: true; mounts: Mount[] } | { ok: false; error: string };

/** Read-only: the mounts attached to a service (fetched when the tab opens). */
export async function listMountsAction(
  serviceType: MountServiceType,
  serviceId: string
): Promise<MountsResult> {
  try {
    return { ok: true, mounts: await listMounts(serviceType, serviceId) };
  } catch (e) {
    return fail(e);
  }
}

export async function createMountAction(input: CreateMountInput): Promise<ActionResult> {
  return wrap(() => createMount(input));
}

export async function updateMountAction(
  mountId: string,
  patch: MountPatch
): Promise<ActionResult> {
  return wrap(() => updateMount(mountId, patch));
}

export async function removeMountAction(mountId: string): Promise<ActionResult> {
  return wrap(() => removeMount(mountId));
}
