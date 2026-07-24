/**
 * Server-only client for the Dokploy API.
 *
 * Auth model: the dashboard is a backend-for-frontend with a PER-USER login.
 * Each user signs in with their OWN Dokploy account (`/login`); we hold their
 * Dokploy session cookie inside a sealed Switchyard session cookie and use it
 * for every request THAT user makes (`request()` -> `userCookie()`, read from
 * next/headers). The raw Dokploy cookie never reaches the browser. On a Dokploy
 * 401 we bounce the user to /login rather than escalating privilege.
 *
 * The env admin credentials (`DOKPLOY_EMAIL`/`DOKPLOY_PASSWORD`) survive for a
 * SINGLE purpose: the system self-probe `ping()` behind /api/health?deep=1,
 * which the installer uses to prove the container -> Dokploy path. That admin
 * session is never used to serve user requests.
 *
 * Dokploy models a database as a service nested under project -> environment.
 * `project.all` returns the tree but trims nested service objects down to their
 * IDs, so we enrich each database via `<engine>.one`.
 */
import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { SESSION_COOKIE, openSession } from "./session";
import { randomServiceName } from "./names";
import { rewriteDataBindsToVolumes } from "./template-volumes";
import {
  deriveComposeRuntime,
  deriveSwarmRuntime,
  listRuntimeStates,
  type ServiceRuntime,
} from "./docker";

export type { RuntimeHealth, ServiceRuntime } from "./docker";

const BASE = process.env.DOKPLOY_URL ?? "http://localhost:3000";
// Origin header for better-auth's CSRF check. Which origins Dokploy trusts
// changed across versions: older builds accept only host-facing origins
// (http://localhost:3000) while current builds accept the origin matching the
// URL the request actually hits (http://dokploy:3000 over service DNS) and
// 403 INVALID_ORIGIN on anything else — verified live on Docker Desktop.
// Probe the candidates on auth calls and remember the first one accepted.
// DOKPLOY_AUTH_ORIGIN pins it explicitly for proxied setups.
const ORIGIN_CANDIDATES = [
  ...(process.env.DOKPLOY_AUTH_ORIGIN ? [process.env.DOKPLOY_AUTH_ORIGIN] : []),
  BASE,
  ...(process.env.DOKPLOY_ORIGIN ? [process.env.DOKPLOY_ORIGIN] : []),
].filter((origin, i, all) => all.indexOf(origin) === i);
let workingOrigin = ORIGIN_CANDIDATES[0];
/** Candidates to try, current winner first. */
const originCandidates = () => [
  workingOrigin,
  ...ORIGIN_CANDIDATES.filter((o) => o !== workingOrigin),
];
const isInvalidOrigin = async (res: Response) =>
  res.status === 403 && /INVALID_ORIGIN/i.test(await res.clone().text());
const EMAIL = process.env.DOKPLOY_EMAIL ?? "";
const PASSWORD = process.env.DOKPLOY_PASSWORD ?? "";

// Ceiling for a single Dokploy API request. These calls enqueue async work and
// return quickly, so a generous bound never trips normal use but stops an
// unresponsive backend from hanging the caller forever. Override via env.
const DOKPLOY_TIMEOUT_MS = Number(process.env.DOKPLOY_TIMEOUT_MS) || 30_000;

// Host-facing base for URLs that leave the server: Dokploy's own deploy
// webhook (`/api/deploy/<token>`) and links opened in the user's browser. The
// BFF reaches Dokploy over service DNS (DOKPLOY_URL), which neither a Git
// host nor a browser can resolve, so prefer the host-facing origin
// (DOKPLOY_ORIGIN, set by the CLI/desktop installers). Even so, if Dokploy
// sits behind a public domain the user must swap this host — surfaced as a
// note in the Deploys tab. Trailing slashes trimmed so URL joins stay clean.
const HOST_ORIGIN = (process.env.DOKPLOY_ORIGIN ?? BASE).replace(/\/+$/, "");

export const ENGINES = ["postgres", "mysql", "mariadb", "mongo", "redis"] as const;
export type Engine = (typeof ENGINES)[number];

/** The id query/body key each engine uses, e.g. postgres -> postgresId. */
const idKey = (engine: Engine) => `${engine}Id` as const;

/** A deployable unit's lifecycle status (shared by all service kinds). */
export type ServiceStatus = "idle" | "running" | "done" | "error";
export type DatabaseStatus = ServiceStatus;

export type ServiceKind = "database" | "application" | "compose";

/** Fields common to every service kind — what the canvas/grid/drawer render. */
export interface ServiceBase {
  kind: ServiceKind;
  id: string;
  name: string;
  appName: string;
  status: ServiceStatus;
  projectId: string;
  projectName: string;
  environmentId: string;
  environmentName: string;
  dockerImage: string | null;
  /** Raw env block ("KEY=value\n..."). */
  env: string | null;
  createdAt: string | null;
  // Dokploy stores resource limits as Docker-format strings (e.g. "256m", "0.5").
  cpuLimit: string | null;
  memoryLimit: string | null;
  replicas: number | null;
  /**
   * Engine truth: what is actually running for this service right now.
   * `status` above is only the last DEPLOY result — after a Docker Desktop VM
   * reset it still reads "done" (Running) with zero containers on the engine.
   * Undefined when the Docker socket wasn't reachable at load time.
   */
  runtime?: ServiceRuntime;
}

export interface Database extends ServiceBase {
  kind: "database";
  engine: Engine;
  databaseName: string | null;
  databaseUser: string | null;
  databasePassword: string | null;
  externalPort: number | null;
  command: string | null;
}

export type AppSource = "github" | "gitlab" | "bitbucket" | "gitea" | "git" | "docker";

/** Build strategies Dokploy supports (the `buildType` pgEnum). */
export const BUILD_TYPES = [
  "nixpacks",
  "dockerfile",
  "railpack",
  "static",
  "heroku_buildpacks",
  "paketo_buildpacks",
] as const;
export type BuildType = (typeof BUILD_TYPES)[number];

/** Dokploy's certificate strategy for a domain (schema enum in shared.ts). */
export type CertificateType = "none" | "letsencrypt" | "custom";

export interface AppDomain {
  domainId: string;
  host: string;
  https: boolean;
  port: number | null;
  path: string | null;
  certificateType: CertificateType;
  /** For compose domains: the compose service the domain routes to. Null for apps. */
  serviceName: string | null;
}

export interface AppDeployment {
  deploymentId: string;
  status: string;
  title: string;
  createdAt: string;
  /**
   * Non-null when this deployment produced a restorable image snapshot
   * (Dokploy only records these when the app deploys to a registry). Feeds
   * the Deploys-tab rollback control; see `rollbackToDeployment`.
   */
  rollbackId: string | null;
}

/**
 * Docker Swarm HealthConfig, verified against Dokploy's `healthCheckSwarm`
 * column (`.strict()` zod, nullable). Interval/Timeout/StartPeriod are in
 * **nanoseconds** (Docker's int64 duration); Retries is a plain count. `Test`
 * is Docker's health-check array, e.g. ["CMD-SHELL", "curl -f http://.../ok"].
 */
export interface HealthCheckSwarm {
  Test?: string[];
  Interval?: number;
  Timeout?: number;
  StartPeriod?: number;
  Retries?: number;
}

export type RestartCondition = "none" | "on-failure" | "any";

/**
 * Docker Swarm RestartPolicy, verified against Dokploy's `restartPolicySwarm`
 * column (`.strict()` zod, nullable). Delay/Window are in **nanoseconds**;
 * MaxAttempts is a plain count; Condition is one of none|on-failure|any.
 */
export interface RestartPolicySwarm {
  Condition?: RestartCondition;
  Delay?: number;
  MaxAttempts?: number;
  Window?: number;
}

/** A path-rewrite rule applied at the proxy (Dokploy `redirects`). */
export interface AppRedirect {
  redirectId: string;
  regex: string;
  replacement: string;
  permanent: boolean;
}

/** A published port mapping, publishedPort -> targetPort (Dokploy `ports`). */
export interface AppPort {
  portId: string;
  publishedPort: number;
  targetPort: number;
  protocol: "tcp" | "udp";
  publishMode: "host" | "ingress";
}

/**
 * An HTTP basic-auth credential guarding the app (Dokploy `security`). We
 * surface only the username — the stored password is a secret we never echo.
 */
export interface AppSecurity {
  securityId: string;
  username: string;
}

export interface Application extends ServiceBase {
  kind: "application";
  sourceType: AppSource | null;
  buildType: BuildType | null;
  description: string | null;
  /** Source repo/image reference for display (git URL or owner/repo). */
  repository: string | null;
  // Build configuration (used to prefill the Build settings tab).
  dockerfile: string | null;
  dockerContextPath: string | null;
  dockerBuildStage: string | null;
  /** Custom start/run command appended to the container's entrypoint. */
  command: string | null;
  /** Registry host for docker-image apps (credentials are never read back). */
  registryUrl: string | null;
  domains: AppDomain[];
  redirects: AppRedirect[];
  ports: AppPort[];
  security: AppSecurity[];
  deployments: AppDeployment[];
  // Docker Swarm soft resource reservations (Docker-format strings, like the limits).
  cpuReservation: string | null;
  memoryReservation: string | null;
  // Swarm deploy config (applied on next deploy). null = unset.
  healthCheckSwarm: HealthCheckSwarm | null;
  restartPolicySwarm: RestartPolicySwarm | null;
  // --- push-to-deploy config (custom-git source); see setAppGitSource ---------
  /** When true, hitting the deploy webhook redeploys the app. */
  autoDeploy: boolean;
  /** Branch the webhook must match to trigger a deploy (customGitBranch). */
  branch: string | null;
  /** Build path within the repo (customGitBuildPath). */
  buildPath: string | null;
  /** Raw clone URL for a custom-git source (customGitUrl), else null. */
  gitUrl: string | null;
  /** Sub-paths that gate a webhook deploy; empty means "any change". */
  watchPaths: string[];
  /**
   * Dokploy's own per-app deploy webhook to wire into a Git host, or null if
   * the app has no refresh token. This is a Dokploy route, not a Switchyard
   * one, so it is reachable independently of any dashboard auth.
   */
  webhookUrl: string | null;
}

export interface ComposeService extends ServiceBase {
  kind: "compose";
  composeFile: string | null;
  composeType: string | null;
  /** Public domains routed to the stack's services (Dokploy `domains`). */
  domains: AppDomain[];
  /** Deploy history for the stack (Dokploy `deployments`). */
  deployments: AppDeployment[];
}

/** Any deployable service rendered in the dashboard. */
export type Service = Database | Application | ComposeService;

/** A directed connection between two services, inferred from env references. */
export interface ServiceEdge {
  source: string; // service id
  target: string; // service id
}

export interface EnvironmentNode {
  environmentId: string;
  name: string;
}
export interface ProjectNode {
  projectId: string;
  name: string;
  environments: EnvironmentNode[];
}

// --- session handling -------------------------------------------------------

/**
 * Sign into Dokploy and return the session cookie as a "name=value; ..." string
 * (attributes like Path/HttpOnly stripped). Shared by the per-user login flow
 * (src/app/login/actions.ts) and the admin system probe below.
 */
/** better-auth POST that walks the origin candidates on INVALID_ORIGIN. */
async function authFetch(path: string, payload: unknown): Promise<Response> {
  let res: Response | null = null;
  for (const origin of originCandidates()) {
    res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify(payload),
      cache: "no-store",
    });
    if (await isInvalidOrigin(res)) continue;
    workingOrigin = origin;
    break;
  }
  // Non-null: ORIGIN_CANDIDATES always contains at least BASE.
  return res!;
}

export async function signInToDokploy(email: string, password: string): Promise<string> {
  const res = await authFetch("/api/auth/sign-in/email", { email, password });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Dokploy sign-in failed (${res.status}): ${body.slice(0, 200)}`);
  }
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("Dokploy sign-in returned no session cookie");
  // Keep just the cookie name=value pairs (drop attributes like Path/HttpOnly).
  return setCookie
    .split(/,(?=[^;]+=[^;]+)/)
    .map((c) => c.split(";")[0].trim())
    .join("; ");
}

/**
 * Register a Dokploy account (better-auth sign-up) — the same call the CLI's
 * terminal-guided registration makes (cli/src/core/dokploy-api.ts). On a fresh
 * install the first sign-up becomes the admin; Dokploy rejects the call once
 * registration is closed.
 */
export async function signUpToDokploy(
  name: string,
  email: string,
  password: string
): Promise<void> {
  const res = await authFetch("/api/auth/sign-up/email", { name, email, password });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Dokploy sign-up failed (${res.status}): ${body.slice(0, 200)}`);
  }
}

/**
 * The CURRENT user's Dokploy cookie, read from the sealed Switchyard session.
 * The proxy blocks anonymous requests up front, so reaching here without a
 * valid session means the cookie is forged/expired -> send them to /login.
 * `redirect()` throws NEXT_REDIRECT (never returns), so the return type holds.
 */
async function userCookie(): Promise<string> {
  const store = await cookies();
  const session = openSession(store.get(SESSION_COOKIE)?.value);
  if (!session) redirect("/login");
  return session.dokployCookie;
}

type ReqInit = { method?: "GET" | "POST"; body?: unknown };

/**
 * User-serving Dokploy request. Threads the per-user cookie via next/headers so
 * the call signature stays `request(path, init)` for every existing caller. On
 * a Dokploy 401 the user's session has expired -> redirect to /login (we do NOT
 * silently fall back to the admin session).
 *
 * Exported so the embedded agent module (`lib/agent/`) can reach Dokploy
 * procedures this file does not yet wrap without duplicating the per-user auth
 * logic. Prefer the typed helpers where they exist.
 */
export async function request<T>(path: string, init: ReqInit = {}): Promise<T> {
  const cookie = await userCookie();
  let res: Response;
  try {
    // Walk the origin candidates like authFetch: after a dashboard restart the
    // first cookie'd call may come before any sign-in re-probes the origin.
    const candidates = originCandidates();
    let attempt: Response | null = null;
    for (const origin of candidates) {
      attempt = await fetch(`${BASE}/api/${path}`, {
        method: init.method ?? "GET",
        headers: {
          "Content-Type": "application/json",
          Origin: origin,
          Cookie: cookie,
        },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        cache: "no-store",
        // Bound the call so an unresponsive Dokploy backend can't hang the caller
        // indefinitely (e.g. the agent's tool loop, which awaits each tool inline).
        signal: AbortSignal.timeout(DOKPLOY_TIMEOUT_MS),
      });
      if (await isInvalidOrigin(attempt)) continue;
      workingOrigin = origin;
      break;
    }
    res = attempt!;
  } catch (e) {
    if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) {
      throw new Error(`Dokploy ${path} timed out after ${DOKPLOY_TIMEOUT_MS}ms.`);
    }
    throw e;
  }
  if (res.status === 401) redirect("/login");
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Dokploy ${path} failed (${res.status}): ${body.slice(0, 300)}`);
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

// --- system probe (admin session) -------------------------------------------
// The ONLY consumer of the env admin credentials. Kept fully separate from the
// user-serving path above so an anonymous /api/health?deep=1 probe still works.

let adminCookieCache: string | null = null;

async function adminSignIn(): Promise<string> {
  adminCookieCache = await signInToDokploy(EMAIL, PASSWORD);
  return adminCookieCache;
}

/**
 * Cheapest end-to-end probe: admin sign-in (when uncached) + list projects.
 * Used by /api/health?deep=1 so the installer can verify the container ->
 * Dokploy path without parsing the workspace or needing a logged-in user.
 */
export async function ping(): Promise<void> {
  const doFetch = (cookie: string) =>
    fetch(`${BASE}/api/project.all`, {
      method: "GET",
      headers: { "Content-Type": "application/json", Origin: workingOrigin, Cookie: cookie },
      cache: "no-store",
    });
  let res = await doFetch(adminCookieCache ?? (await adminSignIn()));
  if (res.status === 401) {
    adminCookieCache = null;
    res = await doFetch(await adminSignIn());
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Dokploy project.all failed (${res.status}): ${body.slice(0, 300)}`);
  }
}

// --- projects ---------------------------------------------------------------

// The raw project.all tree (only the parts we use).
interface RawEnvironment {
  environmentId: string;
  name: string;
  postgres: { postgresId: string }[];
  mysql: { mysqlId: string }[];
  mariadb: { mariadbId: string }[];
  mongo: { mongoId: string }[];
  redis: { redisId: string }[];
  applications: { applicationId: string }[];
  compose: { composeId: string }[];
}
interface RawProject {
  projectId: string;
  name: string;
  environments: RawEnvironment[];
}

async function rawTree(): Promise<RawProject[]> {
  return request<RawProject[]>("project.all");
}

/** The project/environment scope every service carries. */
type Scope = Pick<
  ServiceBase,
  "projectId" | "projectName" | "environmentId" | "environmentName"
>;

/** Flatten the tree into per-service refs: one {id + scope} per extracted id. */
function collectIds(
  tree: RawProject[],
  ids: (env: RawEnvironment) => string[]
): ({ id: string } & Scope)[] {
  const out: ({ id: string } & Scope)[] = [];
  for (const p of tree) {
    for (const env of p.environments) {
      for (const id of ids(env)) {
        out.push({
          id,
          projectId: p.projectId,
          projectName: p.name,
          environmentId: env.environmentId,
          environmentName: env.name,
        });
      }
    }
  }
  return out;
}

function projectsFromTree(tree: RawProject[]): ProjectNode[] {
  return tree.map((p) => ({
    projectId: p.projectId,
    name: p.name,
    environments: p.environments.map((e) => ({
      environmentId: e.environmentId,
      name: e.name,
    })),
  }));
}

export async function listProjects(): Promise<ProjectNode[]> {
  return projectsFromTree(await rawTree());
}

export async function createProject(name: string): Promise<void> {
  await request("project.create", { method: "POST", body: { name } });
}

export async function renameProject(projectId: string, name: string): Promise<void> {
  await request("project.update", { method: "POST", body: { projectId, name } });
}

export async function removeProject(projectId: string): Promise<void> {
  await request("project.remove", { method: "POST", body: { projectId } });
}

export async function createEnvironment(projectId: string, name: string): Promise<void> {
  await request("environment.create", { method: "POST", body: { projectId, name } });
}

export async function renameEnvironment(environmentId: string, name: string): Promise<void> {
  await request("environment.update", { method: "POST", body: { environmentId, name } });
}

export async function removeEnvironment(environmentId: string): Promise<void> {
  await request("environment.remove", { method: "POST", body: { environmentId } });
}

// --- databases --------------------------------------------------------------

interface RawDatabaseDetail {
  name?: string;
  appName?: string;
  applicationStatus?: DatabaseStatus;
  dockerImage?: string | null;
  databaseName?: string | null;
  databaseUser?: string | null;
  databasePassword?: string | null;
  externalPort?: number | null;
  createdAt?: string | null;
  env?: string | null;
  cpuLimit?: string | null;
  memoryLimit?: string | null;
  command?: string | null;
  replicas?: number | null;
}

async function getDetail(engine: Engine, id: string): Promise<RawDatabaseDetail> {
  return request<RawDatabaseDetail>(`${engine}.one?${idKey(engine)}=${encodeURIComponent(id)}`);
}

/** List every database in the tree, enriched with detail. */
async function listDatabases(tree: RawProject[]): Promise<Database[]> {
  const summaries = ENGINES.flatMap((engine) =>
    collectIds(tree, (env) =>
      ((env[engine] ?? []) as Record<string, string>[]).map((item) => item[idKey(engine)])
    ).map((ref) => ({ ...ref, engine }))
  );
  const detailed = await Promise.all(
    summaries.map(async (s) => {
      const d = await getDetail(s.engine, s.id);
      return {
        ...s,
        kind: "database",
        name: d.name ?? s.id,
        appName: d.appName ?? "",
        status: d.applicationStatus ?? "idle",
        dockerImage: d.dockerImage ?? null,
        databaseName: d.databaseName ?? null,
        databaseUser: d.databaseUser ?? null,
        databasePassword: d.databasePassword ?? null,
        externalPort: d.externalPort ?? null,
        createdAt: d.createdAt ?? null,
        env: d.env ?? null,
        cpuLimit: d.cpuLimit ?? null,
        memoryLimit: d.memoryLimit ?? null,
        command: d.command ?? null,
        replicas: d.replicas ?? null,
      } satisfies Database;
    })
  );
  return detailed.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Infer connections between services: if service A's env references service B's
 * appName or name (e.g. a host in a connection string), draw A -> B. Dokploy has
 * no native connection concept, so this is the closest signal available.
 * Comment lines are ignored — template envs mention other products in prose
 * (supabase's stock env says "…for S3/MinIO" and drew a phantom minio edge).
 */
export function inferEdges(services: Service[]): ServiceEdge[] {
  const edges: ServiceEdge[] = [];
  const seen = new Set<string>();
  for (const a of services) {
    const haystack = (a.env ?? "")
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n")
      .toLowerCase();
    if (!haystack) continue;
    for (const b of services) {
      if (a.id === b.id) continue;
      const needles = [b.appName, b.name].filter(Boolean).map((s) => s.toLowerCase());
      if (needles.some((n) => n.length > 2 && haystack.includes(n))) {
        const key = `${a.id}->${b.id}`;
        if (!seen.has(key)) {
          seen.add(key);
          edges.push({ source: a.id, target: b.id });
        }
      }
    }
  }
  return edges;
}

/** Replace a database's environment variables (raw "KEY=value" block). */
export async function saveEnvironment(engine: Engine, id: string, env: string): Promise<void> {
  await request(`${engine}.saveEnvironment`, {
    method: "POST",
    body: { [idKey(engine)]: id, env },
  });
}

export interface CreateDatabaseInput {
  engine: Engine;
  name: string;
  environmentId: string;
  databaseName?: string;
  databaseUser?: string;
  databasePassword: string;
  dockerImage?: string;
}

/** Create a database record. Returns the new id. Field set depends on the engine. */
export async function createDatabase(input: CreateDatabaseInput): Promise<string> {
  const { engine, name, environmentId, databasePassword, dockerImage } = input;
  const body: Record<string, unknown> = { name, environmentId, databasePassword };
  if (dockerImage) body.dockerImage = dockerImage;
  // redis has no databaseName/User; mongo has no databaseName.
  if (engine !== "redis") body.databaseUser = input.databaseUser ?? "admin";
  if (engine !== "redis" && engine !== "mongo")
    body.databaseName = input.databaseName ?? name;
  const created = await request<Record<string, string>>(`${engine}.create`, {
    method: "POST",
    body,
  });
  return created[idKey(engine)];
}

/** Lifecycle actions shared by every service kind. */
export type Action = "deploy" | "start" | "stop" | "remove";

/** Run a lifecycle action against a database. */
export async function databaseAction(engine: Engine, id: string, action: Action): Promise<void> {
  await request(`${engine}.${action}`, {
    method: "POST",
    body: { [idKey(engine)]: id },
  });
}

/** Editable settings on a database (verified accepted by `<engine>.update`). */
export interface DatabasePatch {
  name?: string;
  dockerImage?: string;
  externalPort?: number | null;
  cpuLimit?: string | null;
  memoryLimit?: string | null;
}

/** Patch a database's settings. Image/resource changes need a reload to apply. */
export async function updateDatabase(
  engine: Engine,
  id: string,
  patch: DatabasePatch
): Promise<void> {
  const { externalPort, ...rest } = patch;
  await request(`${engine}.update`, {
    method: "POST",
    body: { [idKey(engine)]: id, ...rest },
  });
  // External port lives on a dedicated endpoint.
  if (externalPort !== undefined) {
    await request(`${engine}.saveExternalPort`, {
      method: "POST",
      body: { [idKey(engine)]: id, externalPort },
    });
  }
}

/** Re-apply a database's config to its running container. */
export async function reloadDatabase(engine: Engine, id: string, appName: string): Promise<void> {
  await request(`${engine}.reload`, {
    method: "POST",
    body: { [idKey(engine)]: id, appName },
  });
}

// --- applications -----------------------------------------------------------

interface RawApplicationDetail {
  name?: string;
  appName?: string;
  applicationStatus?: ServiceStatus;
  sourceType?: AppSource | null;
  buildType?: BuildType | null;
  description?: string | null;
  customGitUrl?: string | null;
  customGitBranch?: string | null;
  customGitBuildPath?: string | null;
  watchPaths?: string[] | null;
  autoDeploy?: boolean | null;
  refreshToken?: string | null;
  owner?: string | null;
  repository?: string | null;
  branch?: string | null;
  dockerImage?: string | null;
  dockerfile?: string | null;
  dockerContextPath?: string | null;
  dockerBuildStage?: string | null;
  command?: string | null;
  registryUrl?: string | null;
  env?: string | null;
  createdAt?: string | null;
  cpuLimit?: string | null;
  memoryLimit?: string | null;
  cpuReservation?: string | null;
  memoryReservation?: string | null;
  replicas?: number | null;
  healthCheckSwarm?: HealthCheckSwarm | null;
  restartPolicySwarm?: RestartPolicySwarm | null;
  domains?: RawDomain[];
  redirects?: {
    redirectId: string;
    regex?: string;
    replacement?: string;
    permanent?: boolean;
  }[];
  ports?: {
    portId: string;
    publishedPort?: number;
    targetPort?: number;
    protocol?: string;
    publishMode?: string;
  }[];
  security?: { securityId: string; username?: string }[];
  deployments?: RawDeployment[];
}

/** Domain shape returned nested under `application.one` / `compose.one`. */
interface RawDomain {
  domainId: string;
  host: string;
  https?: boolean;
  port?: number | null;
  path?: string | null;
  certificateType?: CertificateType | null;
  serviceName?: string | null;
}

/** Deployment shape returned nested under `application.one` / `compose.one`. */
interface RawDeployment {
  deploymentId: string;
  status?: string;
  title?: string;
  createdAt?: string;
  rollbackId?: string | null;
}

/** Normalize a nested domains array (shared by applications and compose). */
function mapDomains(domains: RawDomain[] | undefined): AppDomain[] {
  return (domains ?? []).map((dm) => ({
    domainId: dm.domainId,
    host: dm.host,
    https: dm.https ?? false,
    port: dm.port ?? null,
    path: dm.path ?? null,
    certificateType: dm.certificateType ?? "none",
    serviceName: dm.serviceName ?? null,
  }));
}

/** Normalize a nested deployments array (shared by applications and compose). */
function mapDeployments(deployments: RawDeployment[] | undefined): AppDeployment[] {
  return (deployments ?? []).map((dp) => ({
    deploymentId: dp.deploymentId,
    status: dp.status ?? "idle",
    title: dp.title ?? "Deployment",
    createdAt: dp.createdAt ?? "",
    rollbackId: dp.rollbackId ?? null,
  }));
}

/** List every application in the tree, enriched with detail. */
async function listApplications(tree: RawProject[]): Promise<Application[]> {
  const refs = collectIds(tree, (env) => (env.applications ?? []).map((a) => a.applicationId));
  return Promise.all(
    refs.map(async ({ id, ...scope }) => {
      const d = await request<RawApplicationDetail>(
        `application.one?applicationId=${encodeURIComponent(id)}`
      );
      return {
        ...scope,
        kind: "application",
        id,
        name: d.name ?? id,
        appName: d.appName ?? "",
        status: d.applicationStatus ?? "idle",
        sourceType: d.sourceType ?? null,
        buildType: d.buildType ?? null,
        description: d.description ?? null,
        repository:
          d.customGitUrl ?? (d.owner && d.repository ? `${d.owner}/${d.repository}` : null),
        dockerImage: d.dockerImage ?? null,
        dockerfile: d.dockerfile ?? null,
        dockerContextPath: d.dockerContextPath ?? null,
        dockerBuildStage: d.dockerBuildStage ?? null,
        command: d.command ?? null,
        registryUrl: d.registryUrl ?? null,
        env: d.env ?? null,
        createdAt: d.createdAt ?? null,
        cpuLimit: d.cpuLimit ?? null,
        memoryLimit: d.memoryLimit ?? null,
        cpuReservation: d.cpuReservation ?? null,
        memoryReservation: d.memoryReservation ?? null,
        replicas: d.replicas ?? null,
        healthCheckSwarm: d.healthCheckSwarm ?? null,
        restartPolicySwarm: d.restartPolicySwarm ?? null,
        domains: mapDomains(d.domains),
        redirects: (d.redirects ?? []).map((r) => ({
          redirectId: r.redirectId,
          regex: r.regex ?? "",
          replacement: r.replacement ?? "",
          permanent: r.permanent ?? false,
        })),
        ports: (d.ports ?? []).map((p) => ({
          portId: p.portId,
          publishedPort: p.publishedPort ?? 0,
          targetPort: p.targetPort ?? 0,
          protocol: p.protocol === "udp" ? "udp" : "tcp",
          publishMode: p.publishMode === "ingress" ? "ingress" : "host",
        })),
        security: (d.security ?? []).map((s) => ({
          securityId: s.securityId,
          username: s.username ?? "",
        })),
        deployments: mapDeployments(d.deployments),
        autoDeploy: d.autoDeploy ?? false,
        branch: d.branch ?? d.customGitBranch ?? null,
        buildPath: d.customGitBuildPath ?? null,
        gitUrl: d.customGitUrl ?? null,
        watchPaths: d.watchPaths ?? [],
        webhookUrl: d.refreshToken
          ? `${HOST_ORIGIN}/api/deploy/${d.refreshToken}`
          : null,
      } satisfies Application;
    })
  );
}

/** Create an empty application. Returns the new id. */
export async function createApplication(name: string, environmentId: string): Promise<string> {
  const created = await request<{ applicationId: string }>("application.create", {
    method: "POST",
    body: { name, environmentId },
  });
  return created.applicationId;
}

/** Point an application at a public/private Docker image. */
export async function setAppDockerSource(
  applicationId: string,
  dockerImage: string,
  registry?: { username: string; password: string; registryUrl: string }
): Promise<void> {
  await request("application.saveDockerProvider", {
    method: "POST",
    body: {
      applicationId,
      dockerImage,
      username: registry?.username ?? null,
      password: registry?.password ?? null,
      registryUrl: registry?.registryUrl ?? null,
    },
  });
}

/**
 * Point an application at a public Git repository (built with Nixpacks, the
 * default build type). No OAuth needed — uses a plain clone URL.
 *
 * `watchPaths` is additive/defaulted so existing call sites are unaffected: an
 * empty list means the deploy webhook fires on any change; a non-empty list
 * restricts it to matching sub-paths (Dokploy's `watchPaths` semantics).
 */
export async function setAppGitSource(
  applicationId: string,
  url: string,
  branch = "main",
  buildPath = "/",
  watchPaths: string[] = []
): Promise<void> {
  await request("application.saveGitProvider", {
    method: "POST",
    body: {
      applicationId,
      customGitUrl: url,
      customGitBranch: branch,
      customGitBuildPath: buildPath,
      watchPaths,
    },
  });
}

// --- push-to-deploy + rollback ----------------------------------------------
// (Added for the Deploys tab. Kept in their own section so the existing
//  application exports above stay untouched.)

/**
 * Enable/disable auto-deploy for an application. When enabled, Dokploy's deploy
 * webhook (`webhookUrl`) triggers a redeploy on push; when disabled the webhook
 * returns 400. `autoDeploy` rides on `application.update` (verified accepted by
 * the `apiUpdateApplication` schema).
 */
export async function setAppAutoDeploy(
  applicationId: string,
  autoDeploy: boolean
): Promise<void> {
  await request("application.update", {
    method: "POST",
    body: { applicationId, autoDeploy },
  });
}

/**
 * Roll an application back to a previous deployment's image snapshot.
 *
 * Dokploy rollbacks are image-based: a deployment only has a `rollbackId` when
 * it was pushed to a registry (rollbacks must be enabled with a registry on the
 * app). This calls Dokploy's `rollback.rollback`, which restores the recorded
 * image for that snapshot. There is no git/commit-level rollback in Dokploy —
 * for Nixpacks apps without a registry, `rollbackId` is null and nothing is
 * rollbackable.
 */
export async function rollbackToDeployment(rollbackId: string): Promise<void> {
  await request("rollback.rollback", {
    method: "POST",
    body: { rollbackId },
  });
}

// --- github app (private repos) ---------------------------------------------

/**
 * A configured Dokploy GitHub App connection (one per installation). Dokploy's
 * `github.githubProviders` returns installed providers only, each shaped as
 * `{ githubId, gitProvider: { name, ... } }`. `githubId` is the handle every
 * downstream call keys off; `name` is the connection's display label.
 */
export interface GithubProvider {
  githubId: string;
  name: string;
}

/** A repository reachable through a GitHub App installation. */
export interface GithubRepository {
  /** Repo owner login (org or user) — the `owner` saveGithubProvider expects. */
  owner: string;
  /** Repo short name — the `repository` saveGithubProvider expects. */
  name: string;
  url: string;
  isPrivate: boolean;
  defaultBranch: string | null;
}

export interface GithubBranch {
  name: string;
}

// Raw shapes from Dokploy / Octokit passthrough (only the fields we read).
interface RawGithubProvider {
  githubId: string;
  gitProvider?: { name?: string | null } | null;
}
interface RawGithubRepo {
  name: string;
  url?: string | null;
  html_url?: string | null;
  private?: boolean;
  default_branch?: string | null;
  owner?: { login?: string | null } | null;
}
interface RawGithubBranch {
  name: string;
}

/** List configured GitHub App connections (installed providers only). */
export async function listGithubProviders(): Promise<GithubProvider[]> {
  const raw = await request<RawGithubProvider[]>("github.githubProviders");
  return (raw ?? []).map((p) => ({
    githubId: p.githubId,
    name: p.gitProvider?.name ?? "GitHub App",
  }));
}

/** List repositories reachable through a GitHub App installation. */
export async function listGithubRepositories(githubId: string): Promise<GithubRepository[]> {
  const raw = await request<RawGithubRepo[]>(
    `github.getGithubRepositories?githubId=${encodeURIComponent(githubId)}`
  );
  return (raw ?? [])
    .map((r) => ({
      owner: r.owner?.login ?? "",
      name: r.name,
      url: r.url ?? r.html_url ?? "",
      isPrivate: r.private ?? false,
      defaultBranch: r.default_branch ?? null,
    }))
    .filter((r) => r.owner && r.name)
    .sort((a, b) => `${a.owner}/${a.name}`.localeCompare(`${b.owner}/${b.name}`));
}

/** List branches of a repository reachable through an installation. */
export async function listGithubBranches(
  githubId: string,
  owner: string,
  repo: string
): Promise<GithubBranch[]> {
  const qs = new URLSearchParams({ githubId, owner, repo }).toString();
  const raw = await request<RawGithubBranch[]>(`github.getGithubBranches?${qs}`);
  return (raw ?? []).map((b) => ({ name: b.name }));
}

export interface GithubSourceInput {
  githubId: string;
  owner: string;
  repository: string;
  branch: string;
  buildPath?: string;
}

/**
 * Point an application at a repo through a Dokploy GitHub App installation.
 * Private repos work because Dokploy clones through the App installation, and
 * the App's push webhook drives auto-deploy: `triggerType: "push"` together
 * with the application's `autoDeploy` flag redeploy on a push to `branch`.
 * `autoDeploy` defaults to true on freshly-created apps; we still set it
 * explicitly (it rides on `application.update`, which accepts every application
 * column) so the behavior holds however the app was created. The save payload
 * mirrors Dokploy's own save-github-provider form.
 */
export async function setAppGithubSource(
  applicationId: string,
  input: GithubSourceInput
): Promise<void> {
  await request("application.saveGithubProvider", {
    method: "POST",
    body: {
      applicationId,
      githubId: input.githubId,
      owner: input.owner,
      repository: input.repository,
      branch: input.branch,
      buildPath: input.buildPath ?? "/",
      triggerType: "push",
      enableSubmodules: false,
      watchPaths: [],
    },
  });
  await request("application.update", {
    method: "POST",
    body: { applicationId, autoDeploy: true },
  });
}

/**
 * Dokploy hosts the GitHub App creation + installation flow (an app-manifest
 * exchange that needs a public callback — not something the BFF can proxy).
 * Surface a deep link to that settings page so the user completes it there,
 * then returns to pick an installation. Uses HOST_ORIGIN — the link opens in
 * the user's browser, which cannot resolve the service-DNS URL.
 */
export function githubConnectUrl(): string {
  return `${HOST_ORIGIN}/dashboard/settings/git-providers`;
}

export interface ApplicationPatch {
  name?: string;
  description?: string;
  cpuLimit?: string | null;
  memoryLimit?: string | null;
  cpuReservation?: string | null;
  memoryReservation?: string | null;
  command?: string | null;
  // Swarm deploy settings. All accepted top-level by `application.update`
  // (createSchema.partial()). The swarm objects are `.strict()` — only send
  // their known keys; pass null to clear the whole object.
  replicas?: number;
  healthCheckSwarm?: HealthCheckSwarm | null;
  restartPolicySwarm?: RestartPolicySwarm | null;
}

export async function updateApplication(id: string, patch: ApplicationPatch): Promise<void> {
  await request("application.update", { method: "POST", body: { applicationId: id, ...patch } });
}

/** Build-strategy settings applied by `application.saveBuildType`. */
export interface BuildTypePatch {
  buildType: BuildType;
  /** Dockerfile-build fields (ignored by other strategies). */
  dockerfile?: string;
  dockerContextPath?: string | null;
  dockerBuildStage?: string | null;
  railpackVersion?: string;
  herokuVersion?: string;
  publishDirectory?: string | null;
  isStaticSpa?: boolean;
}

/**
 * Set an application's build strategy (Nixpacks / Dockerfile / Railpack / …).
 * `application.saveBuildType` requires the Dockerfile and version fields on every
 * call (apiSaveBuildType marks them required), so we fill Dokploy's own defaults
 * for whatever the caller omits. Takes effect on the next deploy.
 */
export async function saveAppBuildType(id: string, patch: BuildTypePatch): Promise<void> {
  const body: Record<string, unknown> = {
    applicationId: id,
    buildType: patch.buildType,
    dockerfile: patch.dockerfile?.trim() || "Dockerfile",
    dockerContextPath: patch.dockerContextPath ?? null,
    dockerBuildStage: patch.dockerBuildStage ?? null,
    herokuVersion: patch.herokuVersion ?? "24",
    railpackVersion: patch.railpackVersion ?? "0.15.4",
  };
  // publishDirectory/isStaticSpa are optional strings/booleans — omit when unset
  // (null would fail their non-nullable zod schema).
  if (patch.publishDirectory != null) body.publishDirectory = patch.publishDirectory;
  if (patch.isStaticSpa !== undefined) body.isStaticSpa = patch.isStaticSpa;
  await request("application.saveBuildType", { method: "POST", body });
}

export async function saveApplicationEnvironment(id: string, env: string): Promise<void> {
  // application.saveEnvironment also accepts build args/secrets; send empty.
  await request("application.saveEnvironment", {
    method: "POST",
    body: { applicationId: id, env, buildArgs: "", buildSecrets: "", createEnvFile: false },
  });
}

export async function applicationAction(id: string, action: Action): Promise<void> {
  // Like compose, applications use delete instead of remove (application.remove
  // does not exist — it 404s, which used to break the Destroy button).
  const proc = action === "remove" ? "delete" : action;
  await request(`application.${proc}`, { method: "POST", body: { applicationId: id } });
}

export interface DomainInput {
  host: string;
  port: number;
  https: boolean;
  certificateType: CertificateType;
  path?: string;
}

/**
 * Create a domain (public URL) for an application. HTTPS + certificateType are
 * caller-controlled: Let's Encrypt needs the host to answer on 80/443, so a
 * local/no-ingress setup should pass https:false + certificateType:"none".
 */
export async function createDomain(
  applicationId: string,
  input: DomainInput,
): Promise<void> {
  await request("domain.create", {
    method: "POST",
    body: {
      applicationId,
      host: input.host,
      port: input.port,
      https: input.https,
      certificateType: input.certificateType,
      path: input.path ?? "/",
    },
  });
}

/**
 * Update an existing domain. `domain.update` (apiUpdateDomain) takes the same
 * fields as create plus the required domainId.
 */
export async function updateDomain(domainId: string, input: DomainInput): Promise<void> {
  await request("domain.update", {
    method: "POST",
    body: {
      domainId,
      host: input.host,
      port: input.port,
      https: input.https,
      certificateType: input.certificateType,
      path: input.path ?? "/",
    },
  });
}

/** Remove a domain. `domain.delete` (apiFindDomain) takes just the domainId. */
export async function deleteDomain(domainId: string): Promise<void> {
  await request("domain.delete", { method: "POST", body: { domainId } });
}

/**
 * Create a domain (public URL) for a service inside a compose stack. Unlike an
 * application domain, Dokploy routes on the compose id plus the name of the
 * compose service to target (`serviceName`, e.g. "kong" in Supabase) and needs
 * an explicit `domainType: "compose"` (the create procedure branches on it).
 */
export async function createComposeDomain(
  composeId: string,
  serviceName: string,
  host: string,
  port = 80,
  opts?: { https?: boolean; certificateType?: CertificateType }
): Promise<void> {
  await request("domain.create", {
    method: "POST",
    body: {
      composeId,
      serviceName,
      host,
      port,
      https: opts?.https ?? true,
      certificateType: opts?.certificateType ?? "letsencrypt",
      domainType: "compose",
    },
  });
}

// Redirects / ports / security: routing config that applies on next deploy.
// Payload shapes verified against Dokploy v0.29.x (redirects/port/security
// routers). All three arrays ride along on `application.one`.

/** Add a proxy path-rewrite redirect to an application. */
export async function createRedirect(
  applicationId: string,
  input: { regex: string; replacement: string; permanent: boolean }
): Promise<void> {
  await request("redirects.create", { method: "POST", body: { applicationId, ...input } });
}

export async function deleteRedirect(redirectId: string): Promise<void> {
  await request("redirects.delete", { method: "POST", body: { redirectId } });
}

/** Publish a container port (publishedPort -> targetPort) for an application. */
export async function createPort(
  applicationId: string,
  input: {
    publishedPort: number;
    targetPort: number;
    protocol: "tcp" | "udp";
    publishMode: "host" | "ingress";
  }
): Promise<void> {
  await request("port.create", { method: "POST", body: { applicationId, ...input } });
}

export async function deletePort(portId: string): Promise<void> {
  await request("port.delete", { method: "POST", body: { portId } });
}

/** Add an HTTP basic-auth credential guarding an application. */
export async function createSecurity(
  applicationId: string,
  input: { username: string; password: string }
): Promise<void> {
  await request("security.create", { method: "POST", body: { applicationId, ...input } });
}

export async function deleteSecurity(securityId: string): Promise<void> {
  await request("security.delete", { method: "POST", body: { securityId } });
}

// --- auto-URL: mint a reachable public URL on deploy ------------------------
//
// On the Linux path Dokploy runs Traefik on 80/443 and can route a wildcard
// host that resolves to the host IP with no DNS setup. We prefer Dokploy's
// built-in `domain.generateDomain`, which returns a `*.traefik.me` host
// (`<appName>-<rand>.<hostIP>.traefik.me`). traefik.me domains are served over
// a shared cert, so they are created with certificateType "none" (a Let's
// Encrypt request for traefik.me just hits rate limits and fails). When Dokploy
// can't produce a usable host (e.g. it couldn't detect the server IP) we fall
// back to `<appName>.<SWITCHYARD_HOST_IP>.sslip.io` — the CLI hands us the
// host's advertise IP — and request a real Let's Encrypt cert for it.
//
// The whole feature is gated on SWITCHYARD_HOST_IP, which the CLI sets only on
// the Linux platform (where Traefik is managed). On Docker Desktop and in dev
// mode it is unset, so auto-URL is a no-op and a deploy simply leaves the app
// without a domain.

/** Container port auto-domains route to (Nixpacks/Node apps default here). */
const AUTO_DOMAIN_PORT = 3000;

/** True for hosts we mint automatically (traefik.me / sslip.io wildcards). */
export function isAutoDomainHost(host: string): boolean {
  return /\.traefik\.me$|\.sslip\.io$/i.test(host.trim());
}

/** A generated host is usable only if it carries a real, routable IP. */
function usableGeneratedHost(host: string): boolean {
  const h = host.trim();
  if (!h || !h.includes(".") || h.includes("..")) return false;
  // Reject a loopback/empty IP segment — Dokploy failed to detect the server IP.
  return !/\.(127\.0\.0\.1|0\.0\.0\.0|localhost)\./i.test(h);
}

/**
 * Ask Dokploy for a generated `*.traefik.me` host for `appName`. Returns the
 * bare hostname, or null when the procedure is unavailable / returns nothing
 * usable. `domain.generateDomain` only computes a host string — it does not
 * persist a domain, so the caller still creates one.
 */
async function generateTraefikMeHost(appName: string): Promise<string | null> {
  try {
    const res = await request<unknown>("domain.generateDomain", {
      method: "POST",
      body: { appName },
    });
    const host =
      typeof res === "string"
        ? res
        : ((res as { domain?: string; host?: string } | null)?.domain ??
          (res as { host?: string } | null)?.host ??
          null);
    return host && usableGeneratedHost(host) ? host.trim() : null;
  } catch {
    return null;
  }
}

/** Create a domain with an explicit cert type (used by the auto-URL variants). */
async function createDomainRecord(
  applicationId: string,
  host: string,
  certificateType: "none" | "letsencrypt"
): Promise<void> {
  await request("domain.create", {
    method: "POST",
    body: { applicationId, host, port: AUTO_DOMAIN_PORT, https: true, certificateType },
  });
}

/**
 * Mint a public URL for a freshly-deployed application and return its host, or
 * null when auto-URL isn't available (no SWITCHYARD_HOST_IP → Docker Desktop /
 * dev). Idempotent: if the app already carries an auto-domain the existing host
 * is returned without creating a second one.
 */
export async function ensureAutoDomain(applicationId: string): Promise<string | null> {
  const hostIp = process.env.SWITCHYARD_HOST_IP?.trim();
  if (!hostIp) return null; // Docker Desktop / dev: Traefik unmanaged, no-op.

  // One call gives us both the appName (for the generator / sslip.io host) and
  // the current domains (so redeploys don't stack duplicate auto-domains).
  const detail = await request<RawApplicationDetail>(
    `application.one?applicationId=${encodeURIComponent(applicationId)}`
  );
  const appName = detail.appName ?? "";
  if (!appName) return null;
  const existing = (detail.domains ?? []).find((d) => isAutoDomainHost(d.host));
  if (existing) return existing.host;

  const generated = await generateTraefikMeHost(appName);
  if (generated) {
    await createDomainRecord(applicationId, generated, "none");
    return generated;
  }
  const host = `${appName}.${hostIp}.sslip.io`;
  await createDomainRecord(applicationId, host, "letsencrypt");
  return host;
}

/** A host + cert profile the "Generate URL" button attaches to a service. */
export interface GeneratedHost {
  host: string;
  https: boolean;
  certificateType: "none" | "letsencrypt";
}

/** Lowercase, DNS-label-safe slug for the host prefix; never empty. */
function domainSlug(name: string): string {
  const s = (name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "app";
}

/**
 * Compute (but do NOT persist) a host for the "Generate URL" button. The caller
 * attaches it with the form's own port/service selection. Two modes, matching
 * the auto-URL conventions above:
 *
 *  - Docker Desktop / dev (no SWITCHYARD_HOST_IP): `<slug>-<rand>.localhost`,
 *    which the local Traefik ingress routes over plain HTTP — so https:false and
 *    certificateType "none" (Let's Encrypt can't issue for `.localhost`).
 *  - Linux / hostIp: reuse Dokploy's `domain.generateDomain` for a routable
 *    `*.traefik.me` host (shared cert → "none"); if that's unavailable fall back
 *    to `<slug>.<hostIp>.sslip.io` with a real Let's Encrypt cert.
 */
export async function generateHostFor(name: string): Promise<GeneratedHost> {
  const slug = domainSlug(name);
  const hostIp = process.env.SWITCHYARD_HOST_IP?.trim();
  if (!hostIp) {
    // randomServiceName(slug) → "<slug>-<4 chars>"; append the routable suffix.
    return { host: `${randomServiceName(slug)}.localhost`, https: false, certificateType: "none" };
  }
  const generated = await generateTraefikMeHost(slug);
  if (generated) return { host: generated, https: true, certificateType: "none" };
  return { host: `${slug}.${hostIp}.sslip.io`, https: true, certificateType: "letsencrypt" };
}

// --- schedules --------------------------------------------------------------

/** Which shell Dokploy runs the scheduled command with (docker exec <shell> -c). */
export type ShellType = "bash" | "sh";

/**
 * A cron job attached to an application. Dokploy runs `command` inside the
 * app's running container on `cronExpression`. (Dokploy also supports compose/
 * server schedules; we only surface application schedules.)
 */
export interface Schedule {
  scheduleId: string;
  name: string;
  cronExpression: string;
  command: string;
  shellType: ShellType;
  enabled: boolean;
  timezone: string | null;
  createdAt: string | null;
}

interface RawSchedule {
  scheduleId: string;
  name?: string;
  cronExpression?: string;
  command?: string;
  shellType?: ShellType;
  enabled?: boolean;
  timezone?: string | null;
  createdAt?: string | null;
}

function toSchedule(r: RawSchedule): Schedule {
  return {
    scheduleId: r.scheduleId,
    name: r.name ?? "",
    cronExpression: r.cronExpression ?? "",
    command: r.command ?? "",
    shellType: r.shellType ?? "bash",
    enabled: r.enabled ?? true,
    timezone: r.timezone ?? null,
    createdAt: r.createdAt ?? null,
  };
}

/** List an application's schedules (oldest first, as Dokploy returns them). */
export async function listSchedules(applicationId: string): Promise<Schedule[]> {
  const raw = await request<RawSchedule[]>(
    `schedule.list?id=${encodeURIComponent(applicationId)}&scheduleType=application`
  );
  return (raw ?? []).map(toSchedule);
}

export interface CreateScheduleInput {
  applicationId: string;
  name: string;
  cronExpression: string;
  command: string;
  shellType?: ShellType;
  enabled?: boolean;
}

/** Create a cron job that runs a command inside an application's container. */
export async function createSchedule(input: CreateScheduleInput): Promise<void> {
  await request("schedule.create", {
    method: "POST",
    body: {
      scheduleType: "application",
      applicationId: input.applicationId,
      name: input.name,
      cronExpression: input.cronExpression,
      command: input.command,
      shellType: input.shellType ?? "bash",
      enabled: input.enabled ?? true,
    },
  });
}

/**
 * Full editable field set for an update. Dokploy's `schedule.update` reuses the
 * create schema, so name/cronExpression/command are required on every call —
 * even an enable/disable toggle must resend them.
 */
export interface UpdateScheduleInput {
  name: string;
  cronExpression: string;
  command: string;
  shellType: ShellType;
  enabled: boolean;
}

export async function updateSchedule(
  scheduleId: string,
  input: UpdateScheduleInput
): Promise<void> {
  await request("schedule.update", { method: "POST", body: { scheduleId, ...input } });
}

export async function deleteSchedule(scheduleId: string): Promise<void> {
  await request("schedule.delete", { method: "POST", body: { scheduleId } });
}

/** Trigger a schedule immediately (run-now); the container must be running. */
export async function runSchedule(scheduleId: string): Promise<void> {
  await request("schedule.runManually", { method: "POST", body: { scheduleId } });
}

// --- mounts (persistent volumes) --------------------------------------------

/** Dokploy's mount kinds. `file` writes inline content into the container. */
export type MountType = "volume" | "bind" | "file";
/** The `serviceType` a service is addressed by in the mounts API (superset of our kinds). */
export type MountServiceType = Engine | "application" | "compose";

export interface Mount {
  mountId: string;
  type: MountType;
  /** Path inside the container the mount is exposed at. */
  mountPath: string;
  /** Named Docker volume (type=volume). */
  volumeName: string | null;
  /** Host path bind-mounted in (type=bind). */
  hostPath: string | null;
  /** File name written from `content` (type=file). */
  filePath: string | null;
  /** Inline file contents (type=file). */
  content: string | null;
}

interface RawMount {
  mountId: string;
  type?: MountType;
  mountPath?: string | null;
  volumeName?: string | null;
  hostPath?: string | null;
  filePath?: string | null;
  content?: string | null;
}

/** List the mounts attached to a service. */
export async function listMounts(
  serviceType: MountServiceType,
  serviceId: string
): Promise<Mount[]> {
  const raw = await request<RawMount[]>(
    `mounts.listByServiceId?serviceType=${serviceType}&serviceId=${encodeURIComponent(serviceId)}`
  );
  return (raw ?? []).map((m) => ({
    mountId: m.mountId,
    type: m.type ?? "volume",
    mountPath: m.mountPath ?? "",
    volumeName: m.volumeName ?? null,
    hostPath: m.hostPath ?? null,
    filePath: m.filePath ?? null,
    content: m.content ?? null,
  }));
}

export interface CreateMountInput {
  serviceType: MountServiceType;
  serviceId: string;
  type: MountType;
  mountPath: string;
  volumeName?: string;
  hostPath?: string;
  filePath?: string;
  content?: string;
}

/** Attach a new mount. The service must be redeployed for it to take effect. */
export async function createMount(input: CreateMountInput): Promise<void> {
  await request("mounts.create", { method: "POST", body: input });
}

export interface MountPatch {
  type?: MountType;
  mountPath?: string;
  volumeName?: string;
  hostPath?: string;
  filePath?: string;
  content?: string;
}

/** Edit an existing mount. Changes need a redeploy to reach the container. */
export async function updateMount(mountId: string, patch: MountPatch): Promise<void> {
  await request("mounts.update", { method: "POST", body: { mountId, ...patch } });
}

export async function removeMount(mountId: string): Promise<void> {
  await request("mounts.remove", { method: "POST", body: { mountId } });
}

// --- compose ----------------------------------------------------------------

interface RawComposeDetail {
  name?: string;
  appName?: string;
  composeStatus?: ServiceStatus;
  composeType?: string | null;
  composeFile?: string | null;
  env?: string | null;
  createdAt?: string | null;
  domains?: RawDomain[];
  deployments?: RawDeployment[];
}

export const STARTER_COMPOSE = `services:
  web:
    image: nginx:alpine
    ports:
      - 8080:80
`;

/** List every compose stack in the tree, enriched with detail. */
async function listCompose(tree: RawProject[]): Promise<ComposeService[]> {
  const refs = collectIds(tree, (env) => (env.compose ?? []).map((c) => c.composeId));
  return Promise.all(
    refs.map(async ({ id, ...scope }) => {
      const d = await request<RawComposeDetail>(
        `compose.one?composeId=${encodeURIComponent(id)}`
      );
      return {
        ...scope,
        kind: "compose",
        id,
        name: d.name ?? id,
        appName: d.appName ?? "",
        status: d.composeStatus ?? "idle",
        dockerImage: null,
        env: d.env ?? null,
        createdAt: d.createdAt ?? null,
        cpuLimit: null,
        memoryLimit: null,
        replicas: null,
        composeFile: d.composeFile ?? null,
        composeType: d.composeType ?? null,
        domains: mapDomains(d.domains),
        deployments: mapDeployments(d.deployments),
      } satisfies ComposeService;
    })
  );
}

/** Create a raw docker-compose stack and seed its file. Returns the new id. */
export async function createCompose(
  name: string,
  environmentId: string,
  composeFile = STARTER_COMPOSE
): Promise<string> {
  const created = await request<{ composeId: string }>("compose.create", {
    method: "POST",
    body: { name, environmentId },
  });
  await request("compose.update", {
    method: "POST",
    body: { composeId: created.composeId, sourceType: "raw", composeFile },
  });
  return created.composeId;
}

export async function updateComposeFile(id: string, composeFile: string): Promise<void> {
  await request("compose.update", { method: "POST", body: { composeId: id, composeFile } });
}

/**
 * Replace a compose stack's environment variables (raw "KEY=value" block).
 * `env` is not part of `compose.update`'s input schema — it has a dedicated
 * `compose.saveEnvironment` procedure (mirrors application/database env saves).
 */
export async function saveComposeEnvironment(id: string, env: string): Promise<void> {
  await request("compose.saveEnvironment", {
    method: "POST",
    body: { composeId: id, env },
  });
}

export async function composeAction(id: string, action: Action): Promise<void> {
  // compose uses delete instead of remove.
  const proc = action === "remove" ? "delete" : action;
  await request(`compose.${proc}`, { method: "POST", body: { composeId: id } });
}

// --- backups (S3 destinations + scheduled database backups) -----------------
//
// Dokploy models offsite backups in two layers:
//   1. S3 "destinations" — org-wide bucket credentials (`destination.*`).
//   2. per-database "backups" — a cron schedule + prefix pointed at a
//      destination, plus a manual "run now" and a restore.
//
// Everything here rides the same OpenAPI REST layer (`/api/<procedure>`,
// plain JSON) as the rest of this file — EXCEPT restore. Dokploy exposes
// restore ONLY as a tRPC *subscription* (`backup.restoreBackupWithLogs`, with
// its OpenAPI mapping explicitly disabled); see restoreBackup() below.
//
// Backups apply to the four dumpable engines only — Dokploy's `databaseType`
// enum has no `redis` (Redis is not backed up this way).

export type BackupEngine = Exclude<Engine, "redis">;

/** Dokploy's per-engine "manual backup" procedure names (note the casing). */
const MANUAL_BACKUP_PROC: Record<BackupEngine, string> = {
  postgres: "manualBackupPostgres",
  mysql: "manualBackupMySql",
  mariadb: "manualBackupMariadb",
  mongo: "manualBackupMongo",
};

export interface S3Destination {
  destinationId: string;
  name: string;
  provider: string | null;
  bucket: string;
  region: string;
  endpoint: string;
}

interface RawDestination {
  destinationId: string;
  name: string;
  provider?: string | null;
  bucket?: string;
  region?: string;
  endpoint?: string;
}

/** List the org's configured S3 destinations (credentials omitted). */
export async function listDestinations(): Promise<S3Destination[]> {
  const raw = await request<RawDestination[]>("destination.all");
  return (raw ?? []).map((d) => ({
    destinationId: d.destinationId,
    name: d.name,
    provider: d.provider ?? null,
    bucket: d.bucket ?? "",
    region: d.region ?? "",
    endpoint: d.endpoint ?? "",
  }));
}

export interface CreateDestinationInput {
  name: string;
  /** S3 access key id. Entered by the operator; passed straight to Dokploy. */
  accessKey: string;
  /** S3 secret access key. Never logged or returned to the client. */
  secretAccessKey: string;
  bucket: string;
  region: string;
  endpoint: string;
  provider?: string;
}

function destinationBody(input: CreateDestinationInput): Record<string, unknown> {
  return {
    name: input.name,
    provider: input.provider ?? "",
    accessKey: input.accessKey,
    secretAccessKey: input.secretAccessKey,
    bucket: input.bucket,
    region: input.region,
    endpoint: input.endpoint,
    additionalFlags: [],
  };
}

/** Dry-run a destination's credentials without persisting it. */
export async function testDestination(input: CreateDestinationInput): Promise<void> {
  await request("destination.testConnection", { method: "POST", body: destinationBody(input) });
}

/** Persist a new S3 destination for the org. */
export async function createDestination(input: CreateDestinationInput): Promise<void> {
  await request("destination.create", { method: "POST", body: destinationBody(input) });
}

export async function removeDestination(destinationId: string): Promise<void> {
  await request("destination.remove", { method: "POST", body: { destinationId } });
}

export interface DatabaseBackup {
  backupId: string;
  schedule: string;
  enabled: boolean;
  /** The database name this backup dumps. */
  database: string;
  /** S3 key prefix the dumps are written under. */
  prefix: string;
  keepLatestCount: number | null;
  destinationId: string;
  destinationName: string | null;
}

interface RawBackup {
  backupId: string;
  schedule: string;
  enabled?: boolean | null;
  database: string;
  prefix: string;
  keepLatestCount?: number | null;
  destinationId: string;
  destination?: { name?: string } | null;
}
interface RawDbWithBackups {
  backups?: RawBackup[];
}

/** List a database's configured backups (read from its `<engine>.one` detail). */
export async function listDatabaseBackups(
  engine: BackupEngine,
  id: string
): Promise<DatabaseBackup[]> {
  const detail = await request<RawDbWithBackups>(
    `${engine}.one?${idKey(engine)}=${encodeURIComponent(id)}`
  );
  return (detail.backups ?? []).map((b) => ({
    backupId: b.backupId,
    schedule: b.schedule,
    enabled: b.enabled ?? false,
    database: b.database,
    prefix: b.prefix,
    keepLatestCount: b.keepLatestCount ?? null,
    destinationId: b.destinationId,
    destinationName: b.destination?.name ?? null,
  }));
}

export interface CreateBackupInput {
  engine: BackupEngine;
  databaseId: string;
  destinationId: string;
  /** Database name to dump. */
  database: string;
  /** Cron expression. */
  schedule: string;
  /** S3 key prefix. */
  prefix: string;
  enabled: boolean;
  keepLatestCount?: number | null;
}

/** Create a scheduled backup for a database. */
export async function createDatabaseBackup(input: CreateBackupInput): Promise<void> {
  await request("backup.create", {
    method: "POST",
    body: {
      [idKey(input.engine)]: input.databaseId,
      // For these four engines the `databaseType` enum equals the engine name.
      databaseType: input.engine,
      backupType: "database",
      destinationId: input.destinationId,
      database: input.database,
      schedule: input.schedule,
      prefix: input.prefix,
      enabled: input.enabled,
      keepLatestCount: input.keepLatestCount ?? undefined,
    },
  });
}

export interface UpdateBackupInput {
  backupId: string;
  engine: BackupEngine;
  destinationId: string;
  database: string;
  schedule: string;
  prefix: string;
  enabled: boolean;
  keepLatestCount?: number | null;
}

/** Update an existing backup (used e.g. to toggle `enabled` or change schedule). */
export async function updateDatabaseBackup(input: UpdateBackupInput): Promise<void> {
  // `apiUpdateBackup` marks every picked field required, including the nullable
  // `serviceName`/`metadata` (compose-only) — send explicit nulls for those.
  await request("backup.update", {
    method: "POST",
    body: {
      backupId: input.backupId,
      databaseType: input.engine,
      destinationId: input.destinationId,
      database: input.database,
      schedule: input.schedule,
      prefix: input.prefix,
      enabled: input.enabled,
      keepLatestCount: input.keepLatestCount ?? 0,
      serviceName: null,
      metadata: null,
    },
  });
}

export async function removeDatabaseBackup(backupId: string): Promise<void> {
  await request("backup.remove", { method: "POST", body: { backupId } });
}

/** Trigger an immediate ("back up now") run of a configured backup. */
export async function runDatabaseBackup(engine: BackupEngine, backupId: string): Promise<void> {
  await request(`backup.${MANUAL_BACKUP_PROC[engine]}`, {
    method: "POST",
    body: { backupId },
  });
}

export interface BackupFile {
  path: string;
  name: string;
  size: number;
  isDir: boolean;
}

interface RawRcloneFile {
  Path: string;
  Name: string;
  Size: number;
  IsDir: boolean;
}

/** List objects in a destination's bucket (for picking a file to restore). */
export async function listBackupFiles(
  destinationId: string,
  search = ""
): Promise<BackupFile[]> {
  const raw = await request<RawRcloneFile[]>(
    `backup.listBackupFiles?destinationId=${encodeURIComponent(destinationId)}&search=${encodeURIComponent(search)}`
  );
  return (raw ?? []).map((f) => ({
    path: f.Path,
    name: f.Name,
    size: f.Size,
    isDir: f.IsDir,
  }));
}

export interface RestoreBackupInput {
  engine: BackupEngine;
  /** Id of the database to restore INTO. */
  databaseId: string;
  /** Target database name to restore into. */
  databaseName: string;
  /** S3 object path (from listBackupFiles) to restore from. */
  backupFile: string;
  destinationId: string;
  metadata?: Record<string, unknown>;
}

/**
 * Restore a backup into a database.
 *
 * IMPORTANT: Dokploy exposes restore ONLY as a tRPC *subscription*
 * (`backup.restoreBackupWithLogs`) whose OpenAPI/REST mapping is explicitly
 * disabled — there is no plain REST mutation. Dokploy's own UI drives it over a
 * WebSocket (`/drawer-logs`, superjson-encoded). To avoid adding a WebSocket
 * client, we consume the SAME procedure over tRPC v11's SSE transport on the
 * standard `/api/trpc` handler, reusing this BFF's cookie auth, and read the
 * stream to completion (the restore executes server-side as we drain it). The
 * subscription generator prepends `Error: ...` to the log stream on failure,
 * which we surface. This path is unverified against a live Dokploy; if the SSE
 * transport is rejected, a `ws` client against `/drawer-logs` is the fallback.
 */
export async function restoreBackup(input: RestoreBackupInput): Promise<void> {
  const payload = {
    databaseId: input.databaseId,
    databaseType: input.engine,
    backupType: "database",
    databaseName: input.databaseName,
    backupFile: input.backupFile,
    destinationId: input.destinationId,
    ...(input.metadata ? { metadata: input.metadata } : {}),
  };
  // tRPC applies superjson to subscription inputs; for this all-plain payload
  // the superjson envelope is simply `{ json: payload }` (no `meta`).
  const inputParam = encodeURIComponent(JSON.stringify({ json: payload }));
  const url = `${BASE}/api/trpc/backup.restoreBackupWithLogs?input=${inputParam}`;
  const res = await fetch(url, {
    method: "GET",
    headers: { Accept: "text/event-stream", Origin: workingOrigin, Cookie: await userCookie() },
    cache: "no-store",
  });
  if (res.status === 401) redirect("/login");
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Dokploy restore failed (${res.status}): ${body.slice(0, 300)}`);
  }
  // Drain the stream to EOF — the subscription closes when the restore finishes.
  const text = await res.text();
  const err = text.match(/Error:\s*([^"\\\n]+)/);
  if (err) throw new Error(err[1].trim().slice(0, 300));
}

// --- templates (one-click catalog) ------------------------------------------

/**
 * A catalog entry from Dokploy's open-source template library (Plausible, n8n,
 * Postgres+app bundles, ...). Each template is a bundled docker-compose stack.
 * Shape mirrors Dokploy's `compose.templates` result (its template meta.json),
 * except `logo` is resolved to a full URL (see listTemplates).
 */
export interface DokployTemplate {
  id: string;
  name: string;
  description: string;
  version: string;
  /** Absolute logo URL, or "" when the template has none. */
  logo: string;
  tags: string[];
  links: { github: string; website?: string; docs?: string };
}

// Base for template assets. meta.json lists each `logo` as a bare filename
// (e.g. "logo.png"); the real asset lives at <base>/blueprints/<id>/<logo>.
// Matches Dokploy's default template source (`compose.templates` baseUrl).
const TEMPLATE_BASE = "https://templates.dokploy.com";

/**
 * List the available one-click templates via Dokploy's `compose.templates`.
 * Dokploy fetches this list from its templates repo (templates.dokploy.com) at
 * request time, so this needs outbound internet from the Dokploy host; Dokploy
 * returns an empty array when that upstream fetch fails.
 *
 * `logo` comes back as a bare filename, so we resolve it to the absolute
 * blueprint asset URL here (a relative src would 404 against the dashboard's
 * own origin — the cause of blank catalog icons).
 */
export async function listTemplates(): Promise<DokployTemplate[]> {
  const raw = await request<DokployTemplate[]>("compose.templates");
  return (raw ?? []).map((t) => ({ ...t, logo: resolveTemplateLogo(t.id, t.logo) }));
}

/** Turn a template's bare `logo` filename into an absolute URL (or "" if none). */
function resolveTemplateLogo(id: string, logo: string | null | undefined): string {
  const name = (logo ?? "").trim();
  if (!name) return "";
  if (/^https?:\/\//i.test(name)) return name; // already absolute — leave it
  return `${TEMPLATE_BASE}/blueprints/${encodeURIComponent(id)}/${name}`;
}

/**
 * Provision a catalog template into an environment. Dokploy's
 * `compose.deployTemplate` creates a compose stack from the template's bundled
 * docker-compose + generated env (and any mounts/domains) but does not start
 * it, so callers deploy the returned compose id separately. Returns the new
 * compose service id.
 */
export async function deployTemplate(
  templateId: string,
  environmentId: string
): Promise<string> {
  const created = await request<{ composeId: string }>("compose.deployTemplate", {
    method: "POST",
    body: { id: templateId, environmentId },
  });
  // Templates default to isolatedDeployment:true, which puts every service on a
  // per-stack network only — never dokploy-network, where Traefik lives. Any
  // domain attached to the stack then 404s (correct labels, unreachable
  // backend). Verified live: flipping this before the first deploy joins the
  // stack to dokploy-network and label routing works.
  await request("compose.update", {
    method: "POST",
    body: { composeId: created.composeId, isolatedDeployment: false },
  });
  // Keep database data out of ../files host binds (= /etc/dokploy/..., which
  // on Docker Desktop lives inside the VM and dies with VM resets): rewrite
  // known data-dir binds to named volumes before the first deploy. Best-effort
  // — a template the rewriter doesn't recognize deploys unchanged.
  try {
    const detail = await request<{ composeFile?: string | null }>(
      `compose.one?composeId=${encodeURIComponent(created.composeId)}`
    );
    const rewrite = rewriteDataBindsToVolumes(detail.composeFile ?? "");
    if (rewrite.rewritten.length > 0) {
      await request("compose.update", {
        method: "POST",
        body: { composeId: created.composeId, composeFile: rewrite.compose },
      });
    }
  } catch {
    // Non-fatal: the stack still deploys with the template's stock binds.
  }
  return created.composeId;
}

// --- unified service listing ------------------------------------------------

/**
 * Everything the workspace page needs, from a single `project.all` fetch:
 * services of all kinds (enriched with per-service detail) plus the
 * project/environment tree.
 */
export async function loadWorkspace(): Promise<{
  services: Service[];
  projects: ProjectNode[];
}> {
  const tree = await rawTree();
  const [databases, applications, compose] = await Promise.all([
    listDatabases(tree),
    listApplications(tree),
    listCompose(tree),
  ]);
  const services = [...databases, ...applications, ...compose].sort((a, b) =>
    a.name.localeCompare(b.name)
  );
  // Attach engine truth: one `docker ps -a` sweep, grouped by the labels that
  // tie containers to services (compose project / swarm service name — both
  // equal the service's appName). Best-effort: with no reachable Docker
  // socket every badge falls back to the deploy status alone.
  try {
    const runtime = await listRuntimeStates();
    for (const s of services) {
      s.runtime =
        s.kind === "compose"
          ? deriveComposeRuntime(runtime.compose.get(s.appName) ?? [])
          : deriveSwarmRuntime(runtime.swarm.get(s.appName) ?? []);
    }
  } catch {
    // dockerode unavailable in this deployment — leave runtime undefined.
  }
  return { services, projects: projectsFromTree(tree) };
}

/**
 * The set of Swarm `appName`s the CURRENT user's Dokploy workspace manages.
 * The logs/metrics routes validate the requested `?app=` against this before
 * attaching to a container, so an authed user can't tail arbitrary host
 * containers by name. Uses the per-user session (via `request()`).
 */
// Briefly cached so metrics-style routes that poll every ~20s don't re-walk
// the whole Dokploy tree on each request.
let appNamesCache: { at: number; names: Set<string> } | null = null;
const APP_NAMES_TTL_MS = 30_000;

export async function knownAppNames(): Promise<Set<string>> {
  const now = Date.now();
  if (appNamesCache && now - appNamesCache.at < APP_NAMES_TTL_MS) {
    return appNamesCache.names;
  }
  const { services } = await loadWorkspace();
  const names = new Set(services.map((s) => s.appName).filter((n): n is string => Boolean(n)));
  appNamesCache = { at: now, names };
  return names;
}

// ============================================================================
// Notifications (added for observability alerts — see lib/collector.ts).
//
// Switchyard does not stand up its own notification infra: it reuses whatever
// channel the operator already configured in Dokploy. `notification.all`
// returns each channel with its nested provider config (webhook URL / token),
// and we deliver an alert by POSTing to that same webhook. The `test*`
// procedures only send a fixed "Hi, From Dokploy" message, so they can't carry
// a crash-loop payload — hence the direct webhook post.
// (Confirmed against Dokploy's notification router: `notification.all` includes
//  { slack, telegram, discord, custom, mattermost, lark, teams, ... }.)
// ============================================================================

interface SlackConfig { webhookUrl: string; channel?: string | null }
interface DiscordConfig { webhookUrl: string }
interface TelegramConfig { botToken: string; chatId: string; messageThreadId?: string | null }
interface WebhookConfig { webhookUrl: string; channel?: string | null; username?: string | null }
interface CustomConfig { endpoint: string; headers?: unknown }

export interface DokployNotification {
  notificationId: string;
  name: string;
  notificationType?: string;
  slack?: SlackConfig | null;
  discord?: DiscordConfig | null;
  telegram?: TelegramConfig | null;
  mattermost?: WebhookConfig | null;
  lark?: WebhookConfig | null;
  teams?: WebhookConfig | null;
  custom?: CustomConfig | null;
}

/** All notification channels configured in Dokploy for the active org. */
export async function listNotifications(): Promise<DokployNotification[]> {
  return request<DokployNotification[]>("notification.all");
}

/** Parse Dokploy custom-webhook headers (stored as JSON string, array, or map). */
function customHeaders(raw: unknown): Record<string, string> {
  const out: Record<string, string> = { "Content-Type": "application/json" };
  let val = raw;
  if (typeof val === "string") {
    try {
      val = JSON.parse(val);
    } catch {
      return out;
    }
  }
  if (Array.isArray(val)) {
    for (const h of val as { name?: string; value?: string }[]) {
      if (h?.name) out[h.name] = String(h.value ?? "");
    }
  } else if (val && typeof val === "object") {
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) out[k] = String(v);
  }
  return out;
}

async function postJson(url: string, body: unknown, headers?: Record<string, string>): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: headers ?? { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`webhook ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

/** Deliver `text` to one configured channel. Returns the channel type used. */
async function deliver(n: DokployNotification, text: string): Promise<string> {
  if (n.slack?.webhookUrl) {
    await postJson(n.slack.webhookUrl, { text, channel: n.slack.channel ?? undefined });
    return "slack";
  }
  if (n.discord?.webhookUrl) {
    await postJson(n.discord.webhookUrl, { content: text });
    return "discord";
  }
  if (n.telegram?.botToken && n.telegram.chatId) {
    await postJson(`https://api.telegram.org/bot${n.telegram.botToken}/sendMessage`, {
      chat_id: n.telegram.chatId,
      text,
      message_thread_id: n.telegram.messageThreadId ?? undefined,
    });
    return "telegram";
  }
  if (n.mattermost?.webhookUrl) {
    await postJson(n.mattermost.webhookUrl, {
      text,
      channel: n.mattermost.channel ?? undefined,
      username: n.mattermost.username ?? undefined,
    });
    return "mattermost";
  }
  if (n.lark?.webhookUrl) {
    await postJson(n.lark.webhookUrl, { msg_type: "text", content: { text } });
    return "lark";
  }
  if (n.teams?.webhookUrl) {
    await postJson(n.teams.webhookUrl, { text });
    return "teams";
  }
  if (n.custom?.endpoint) {
    await postJson(n.custom.endpoint, { title: "Switchyard alert", message: text, text }, customHeaders(n.custom.headers));
    return "custom";
  }
  throw new Error(`notification "${n.name}" has no webhook-deliverable channel`);
}

export type NotifyResult =
  | { sent: true; channel: string; name: string }
  | { sent: false; reason: string };

/**
 * Send `text` through a Dokploy-configured channel. `selector` (name or id)
 * picks a specific channel; otherwise the first webhook-deliverable one is used.
 */
export async function notifyThroughDokploy(text: string, selector?: string): Promise<NotifyResult> {
  let all: DokployNotification[];
  try {
    all = await listNotifications();
  } catch (e) {
    return { sent: false, reason: `could not list Dokploy notifications: ${e instanceof Error ? e.message : e}` };
  }
  if (all.length === 0) return { sent: false, reason: "no Dokploy notification channels configured" };

  const wanted = selector?.trim().toLowerCase();
  const ordered = wanted
    ? all.filter((n) => n.name.toLowerCase() === wanted || n.notificationId === selector)
    : all;
  if (ordered.length === 0) return { sent: false, reason: `no Dokploy channel matches "${selector}"` };

  let lastErr = "";
  for (const n of ordered) {
    try {
      const channel = await deliver(n, text);
      return { sent: true, channel, name: n.name };
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
  }
  return { sent: false, reason: lastErr || "delivery failed" };
}
