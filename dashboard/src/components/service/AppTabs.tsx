"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import {
  Globe,
  ExternalLink,
  Plus,
  Loader2,
  GitBranch,
  Webhook,
  RotateCcw,
  Eye,
  EyeOff,
  Play,
  Trash2,
  Pencil,
  Power,
  Clock,
  X,
} from "lucide-react";
import type {
  Application,
  AppDomain,
  AppDeployment,
  ApplicationPatch,
  BuildType,
  BuildTypePatch,
  CertificateType,
  DomainInput,
  HealthCheckSwarm,
  RestartCondition,
  RestartPolicySwarm,
  Schedule,
} from "@/lib/dokploy";
import {
  appLifecycleAction,
  updateApplicationAction,
  saveAppBuildTypeAction,
  setAppDockerSourceAction,
  createDomainAction,
  generateDomainAction,
  updateDomainAction,
  deleteDomainAction,
  updateGitDeployAction,
  rollbackDeploymentAction,
  listSchedulesAction,
  createScheduleAction,
  updateScheduleAction,
  deleteScheduleAction,
  runScheduleAction,
} from "@/app/actions";
import {
  inputCls,
  Field,
  Info,
  CopyButton,
  LifecycleButtons,
  SaveRow,
  DangerZone,
  PublicUrlBar,
  PrivateNetwork,
  GenerateUrlBtn,
  useLifecycle,
  useSavedFlash,
} from "@/components/service/primitives";
import { cn } from "@/lib/utils";

/** Human labels for Dokploy's build strategies. */
const BUILD_TYPE_LABELS: Record<BuildType, string> = {
  nixpacks: "Nixpacks (auto-detect)",
  dockerfile: "Dockerfile",
  railpack: "Railpack",
  static: "Static site",
  heroku_buildpacks: "Heroku buildpacks",
  paketo_buildpacks: "Paketo buildpacks",
};

// Client-safe list of build types (dokploy.ts is server-only, so we can't import
// its BUILD_TYPES value into this client component — derive it from the labels).
const BUILD_TYPES = Object.keys(BUILD_TYPE_LABELS) as BuildType[];

const CERT_TYPES: CertificateType[] = ["none", "letsencrypt", "custom"];

const useAppLifecycle = (app: Application) =>
  useLifecycle((action) => appLifecycleAction(app.id, action));

export function AppOverviewTab({ app }: { app: Application }) {
  const { pending, error, run } = useAppLifecycle(app);

  return (
    <div className="space-y-5">
      <PublicUrlBar domains={app.domains} status={app.status} />

      <LifecycleButtons status={app.status} pending={pending} error={error} run={run} />

      <PrivateNetwork host={app.appName} />

      <div className="grid grid-cols-2 gap-3">
        <Info label="Source" value={app.sourceType ?? "—"} />
        <Info
          label={app.sourceType === "docker" ? "Image" : "Repository"}
          value={app.dockerImage ?? app.repository ?? "—"}
          mono
        />
        {app.sourceType !== "docker" && app.branch && (
          <Info label="Branch" value={app.branch} mono />
        )}
        {app.sourceType !== "docker" && app.sourceType && (
          <Info label="Auto-deploy" value={app.autoDeploy ? "on push" : "off"} />
        )}
        <Info label="Build" value={app.buildType ?? "—"} />
        <Info label="Replicas" value={String(app.replicas ?? 1)} />
      </div>
    </div>
  );
}

/** Shared host/port/https/cert-type editor used by the add form and edit rows. */
function DomainFields({
  value,
  onChange,
}: {
  value: DomainInput;
  onChange: (patch: Partial<DomainInput>) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <Field label="Host">
            <input
              value={value.host}
              onChange={(e) => onChange({ host: e.target.value })}
              placeholder="app.example.com"
              className={inputCls}
            />
          </Field>
        </div>
        <div className="w-24">
          <Field label="Container port">
            <input
              value={String(value.port)}
              onChange={(e) => onChange({ port: Number(e.target.value.replace(/[^0-9]/g, "")) || 0 })}
              className={inputCls}
            />
          </Field>
        </div>
      </div>
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <Field label="Certificate">
            <select
              value={value.certificateType}
              onChange={(e) => onChange({ certificateType: e.target.value as CertificateType })}
              className={inputCls}
            >
              {CERT_TYPES.map((c) => (
                <option key={c} value={c}>
                  {c === "letsencrypt" ? "Let's Encrypt" : c === "none" ? "None (HTTP)" : "Custom"}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <label className="flex h-9 cursor-pointer items-center gap-2 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 text-xs text-[var(--color-fg-muted)]">
          <input
            type="checkbox"
            checked={value.https}
            onChange={(e) => onChange({ https: e.target.checked })}
          />
          HTTPS
        </label>
      </div>
    </div>
  );
}

function toInput(d: AppDomain): DomainInput {
  return {
    host: d.host,
    port: d.port ?? 80,
    https: d.https,
    certificateType: d.certificateType,
    path: d.path ?? "/",
  };
}

/** One attached domain: display row that expands into an inline editor. */
function DomainRow({ d }: { d: AppDomain }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<DomainInput>(() => toInput(d));
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function save() {
    if (!draft.host.trim()) return;
    setError(null);
    start(async () => {
      const res = await updateDomainAction(d.domainId, draft);
      if (res.ok) setEditing(false);
      else setError(res.error);
    });
  }

  function remove() {
    if (!confirm(`Remove domain "${d.host}"?`)) return;
    setError(null);
    start(async () => {
      const res = await deleteDomainAction(d.domainId);
      if (!res.ok) setError(res.error);
    });
  }

  if (editing) {
    return (
      <div className="space-y-3 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] p-3">
        <DomainFields value={draft} onChange={(patch) => setDraft((v) => ({ ...v, ...patch }))} />
        {error && <p role="alert" className="text-xs text-[var(--color-danger)]">{error}</p>}
        <div className="flex items-center justify-end gap-2">
          <button
            onClick={() => {
              setDraft(toInput(d));
              setEditing(false);
              setError(null);
            }}
            disabled={pending}
            className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--color-border-strong)] px-3 py-2 text-xs font-medium text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)] disabled:opacity-40"
          >
            <X className="size-3.5" /> Cancel
          </button>
          <button
            onClick={save}
            disabled={pending || !draft.host.trim()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--color-brand-strong)] px-3.5 py-2 text-xs font-semibold text-white hover:bg-[var(--color-brand-deep)] disabled:opacity-40"
          >
            {pending && <Loader2 className="size-4 animate-spin" />}
            Save
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm">
      <Globe className="size-3.5 shrink-0 text-[var(--color-brand)]" />
      <a
        href={`${d.https ? "https" : "http"}://${d.host}`}
        target="_blank"
        rel="noreferrer"
        className="flex min-w-0 flex-1 items-center gap-1.5 truncate hover:underline"
      >
        <span className="truncate">{d.host}</span>
        {d.port && <span className="text-xs text-[var(--color-fg-subtle)]">:{d.port}</span>}
        <ExternalLink className="size-3 shrink-0 text-[var(--color-fg-subtle)]" />
      </a>
      <span className="shrink-0 rounded-full border border-[var(--color-border)] px-1.5 py-0.5 text-[10px] text-[var(--color-fg-subtle)]">
        {d.certificateType === "letsencrypt" ? "LE" : d.https ? "HTTPS" : "HTTP"}
      </span>
      <button
        onClick={() => {
          setDraft(toInput(d));
          setEditing(true);
        }}
        disabled={pending}
        className="shrink-0 rounded-md p-1 text-[var(--color-fg-subtle)] hover:text-[var(--color-fg)] disabled:opacity-40"
        title="Edit domain"
        aria-label="Edit domain"
        aria-expanded={editing}
      >
        <Pencil className="size-3.5" />
      </button>
      <button
        onClick={remove}
        disabled={pending}
        className="shrink-0 rounded-md p-1 text-[var(--color-fg-subtle)] hover:text-[var(--color-danger)] disabled:opacity-40"
        title="Remove domain"
        aria-label="Remove domain"
      >
        {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
      </button>
      {error && <span role="alert" className="text-xs text-[var(--color-danger)]">{error}</span>}
    </div>
  );
}

const NEW_DOMAIN: DomainInput = {
  host: "",
  port: 80,
  https: true,
  certificateType: "letsencrypt",
  path: "/",
};

export function DomainsTab({ app }: { app: Application }) {
  const [draft, setDraft] = useState<DomainInput>(NEW_DOMAIN);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [generated, setGenerated] = useState<string | null>(null);

  function add() {
    if (!draft.host.trim()) return;
    setError(null);
    setGenerated(null);
    start(async () => {
      const res = await createDomainAction(app.id, draft);
      if (res.ok) setDraft(NEW_DOMAIN);
      else setError(res.error);
    });
  }

  // Attach a random routable host with no typing, on the form's current port.
  function generate() {
    setError(null);
    setGenerated(null);
    start(async () => {
      const res = await generateDomainAction(app.id, app.appName, draft.port);
      if (res.ok) setGenerated(res.host);
      else setError(res.error);
    });
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-[var(--color-fg-muted)]">
        Attach a domain and point its DNS at this server. Let&apos;s Encrypt needs the host to
        answer on ports 80/443 — for local/no-ingress setups choose certificate &ldquo;None&rdquo;
        and untick HTTPS.
      </p>

      {app.domains.length > 0 ? (
        <div className="space-y-2">
          {app.domains.map((d) => (
            <DomainRow key={d.domainId} d={d} />
          ))}
        </div>
      ) : (
        <p className="text-xs text-[var(--color-fg-subtle)]">No domains attached.</p>
      )}

      <div className="space-y-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-3">
        <div className="text-xs font-medium text-[var(--color-fg-muted)]">Add a domain</div>
        <DomainFields value={draft} onChange={(patch) => setDraft((v) => ({ ...v, ...patch }))} />
        <div className="flex items-center justify-between gap-2">
          <GenerateUrlBtn pending={pending} onClick={generate} />
          <button
            onClick={add}
            disabled={pending || !draft.host.trim()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--color-brand-strong)] px-3 py-2 text-xs font-semibold text-white hover:bg-[var(--color-brand-deep)] disabled:opacity-40"
          >
            {pending ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
            Add
          </button>
        </div>
        <p className="text-[10px] text-[var(--color-fg-subtle)]">
          Generate URL attaches a random host on port {draft.port} — no typing needed.
        </p>
      </div>
      {generated && (
        <p role="status" className="text-xs text-[var(--color-ok)]">
          Attached {generated} — it appears in the list above.
        </p>
      )}
      {error && <p role="alert" className="text-xs text-[var(--color-danger)]">{error}</p>}
    </div>
  );
}

export function DeploymentsTab({ app }: { app: Application }) {
  return (
    <div className="space-y-6">
      {app.sourceType === "git" && <AutoDeployPanel app={app} />}
      <DeploymentHistory deployments={app.deployments} />
    </div>
  );
}

/**
 * Push-to-deploy config for a custom-git app: the copyable Dokploy deploy
 * webhook to wire into a Git host, plus branch / watch-paths / auto-deploy.
 */
function AutoDeployPanel({ app }: { app: Application }) {
  const [branch, setBranch] = useState(app.branch ?? "main");
  const [autoDeploy, setAutoDeploy] = useState(app.autoDeploy);
  const [watch, setWatch] = useState(app.watchPaths.join("\n"));
  const [saving, start] = useTransition();
  const [saved, flashSaved] = useSavedFlash();
  const [error, setError] = useState<string | null>(null);

  const watchList = watch.split("\n").map((s) => s.trim()).filter(Boolean);
  const dirty =
    branch !== (app.branch ?? "main") ||
    autoDeploy !== app.autoDeploy ||
    watchList.join("\n") !== app.watchPaths.join("\n");

  function save() {
    setError(null);
    start(async () => {
      const res = await updateGitDeployAction(app.id, {
        gitUrl: app.gitUrl,
        branch,
        buildPath: app.buildPath ?? "/",
        watchPaths: watchList,
        autoDeploy,
      });
      if (res.ok) flashSaved();
      else setError(res.error);
    });
  }

  return (
    <div className="space-y-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div className="flex items-center gap-2">
        <Webhook className="size-4 text-[var(--color-brand)]" />
        <h3 className="text-sm font-semibold">Push to deploy</h3>
      </div>

      <Field label="Deploy webhook URL" hint="add to your Git host">
        {app.webhookUrl ? (
          <div className="flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[#0b0b10] p-2.5">
            <code className="flex-1 truncate font-mono text-[11px] text-[var(--color-fg-muted)]">
              {app.webhookUrl}
            </code>
            <CopyButton text={app.webhookUrl} />
          </div>
        ) : (
          <p className="text-xs text-[var(--color-fg-subtle)]">
            No webhook token yet — deploy the app once to generate one.
          </p>
        )}
      </Field>
      <p className="text-[11px] leading-relaxed text-[var(--color-fg-subtle)]">
        Add this as a push webhook in your Git host (GitHub: Settings → Webhooks,
        content type <span className="font-mono">application/json</span>). If Dokploy
        is reachable at a public domain, replace the host with that address. A push
        to <span className="font-mono">{branch || "main"}</span> then redeploys this
        app while auto-deploy is on.
      </p>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Branch">
          <div className="relative">
            <GitBranch className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-[var(--color-fg-subtle)]" />
            <input
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              placeholder="main"
              className={`${inputCls} pl-8`}
            />
          </div>
        </Field>
        <Field label="Auto-deploy" hint="webhook on/off">
          <button
            type="button"
            role="switch"
            aria-checked={autoDeploy}
            onClick={() => setAutoDeploy((v) => !v)}
            className={`inline-flex h-9 w-full items-center justify-between rounded-lg border px-3 text-xs font-medium transition-colors ${
              autoDeploy
                ? "border-[var(--color-brand)] text-[var(--color-fg)]"
                : "border-[var(--color-border-strong)] text-[var(--color-fg-muted)]"
            }`}
          >
            {autoDeploy ? "Enabled" : "Disabled"}
            <span
              className={`relative h-4 w-7 rounded-full transition-colors ${
                autoDeploy ? "bg-[var(--color-brand-strong)]" : "bg-[var(--color-idle)]"
              }`}
            >
              <span
                className={`absolute top-0.5 size-3 rounded-full bg-white transition-all ${
                  autoDeploy ? "left-3.5" : "left-0.5"
                }`}
              />
            </span>
          </button>
        </Field>
      </div>

      <Field label="Watch paths" hint="one per line · blank = any change">
        <textarea
          value={watch}
          onChange={(e) => setWatch(e.target.value)}
          placeholder="src/&#10;package.json"
          rows={2}
          className={`${inputCls} resize-y font-mono`}
        />
      </Field>

      <SaveRow saving={saving} saved={saved} error={error} disabled={!dirty} onSave={save} />
    </div>
  );
}

export function DeploymentHistory({ deployments: history }: { deployments: AppDeployment[] }) {
  const deployments = [...history].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const color = (s: string) =>
    s === "done" ? "var(--color-ok)" : s === "error" ? "var(--color-danger)" : s === "running" ? "var(--color-warn)" : "var(--color-idle)";
  return (
    <div className="space-y-2">
      <p className="mb-1 text-xs text-[var(--color-fg-muted)]">Deployment history (newest first).</p>
      {deployments.length === 0 ? (
        <p className="text-xs text-[var(--color-fg-subtle)]">No deployments yet.</p>
      ) : (
        deployments.map((d) => (
          <div
            key={d.deploymentId}
            className="flex items-center gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5"
          >
            <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: color(d.status) }} />
            {d.rollbackId && <span className="sr-only">{d.status}</span>}
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm">{d.title}</div>
              <div className="text-[11px] text-[var(--color-fg-subtle)]">
                {d.createdAt ? new Date(d.createdAt).toLocaleString() : "—"}
              </div>
            </div>
            {d.rollbackId ? (
              <RollbackButton rollbackId={d.rollbackId} title={d.title} />
            ) : (
              <span className="text-xs capitalize text-[var(--color-fg-muted)]">{d.status}</span>
            )}
          </div>
        ))
      )}
    </div>
  );
}

/** Restore a past deployment's image snapshot (Dokploy image-based rollback). */
function RollbackButton({ rollbackId, title }: { rollbackId: string; title: string }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  function rollback() {
    if (!confirm(`Roll back to "${title}"? This redeploys the recorded image.`)) return;
    setError(null);
    start(async () => {
      const res = await rollbackDeploymentAction(rollbackId);
      if (!res.ok) setError(res.error);
    });
  }
  return (
    <div className="flex flex-col items-end gap-1">
      <button
        onClick={rollback}
        disabled={pending}
        title="Roll back to this deployment"
        className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--color-border-strong)] px-2.5 py-1.5 text-xs font-medium text-[var(--color-fg-muted)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)] disabled:opacity-40"
      >
        {pending ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCcw className="size-3.5" />}
        Roll back
      </button>
      {error && <span role="alert" className="text-[11px] text-[var(--color-danger)]">{error}</span>}
    </div>
  );
}

/** Small "redeploy after saving" checkbox shared by the build sub-forms. */
function RedeployToggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-xs text-[var(--color-fg-muted)]">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="accent-[var(--color-brand)]"
      />
      Redeploy now to apply
    </label>
  );
}

/**
 * Build configuration: the build strategy (Nixpacks / Dockerfile / Railpack /
 * …) and Dockerfile options for source-built apps, private registry
 * credentials for docker-image apps, and the custom start command for either.
 * Build-strategy and image changes only take effect on the next deploy, so each
 * sub-form offers an optional redeploy.
 */
export function AppBuildTab({ app }: { app: Application }) {
  const isDocker = app.sourceType === "docker";
  return (
    <div className="space-y-6">
      {isDocker ? <DockerSourceForm app={app} /> : <BuildStrategyForm app={app} />}
      <StartCommandForm app={app} />
    </div>
  );
}

function BuildStrategyForm({ app }: { app: Application }) {
  const [buildType, setBuildType] = useState<BuildType>(app.buildType ?? "nixpacks");
  const [dockerfile, setDockerfile] = useState(app.dockerfile ?? "Dockerfile");
  const [contextPath, setContextPath] = useState(app.dockerContextPath ?? "");
  const [buildStage, setBuildStage] = useState(app.dockerBuildStage ?? "");
  const [redeploy, setRedeploy] = useState(false);
  const [saving, startSave] = useTransition();
  const [saved, flashSaved] = useSavedFlash();
  const [error, setError] = useState<string | null>(null);

  const dirty =
    buildType !== (app.buildType ?? "nixpacks") ||
    (buildType === "dockerfile" &&
      (dockerfile !== (app.dockerfile ?? "Dockerfile") ||
        contextPath !== (app.dockerContextPath ?? "") ||
        buildStage !== (app.dockerBuildStage ?? "")));

  function save() {
    setError(null);
    const patch: BuildTypePatch = { buildType };
    if (buildType === "dockerfile") {
      patch.dockerfile = dockerfile.trim() || "Dockerfile";
      patch.dockerContextPath = contextPath.trim() || null;
      patch.dockerBuildStage = buildStage.trim() || null;
    }
    startSave(async () => {
      const res = await saveAppBuildTypeAction(app.id, patch, redeploy);
      if (res.ok) flashSaved();
      else setError(res.error);
    });
  }

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-[var(--color-fg)]">Build strategy</h3>
      <Field label="Build type" hint="applies on next deploy">
        <select
          value={buildType}
          onChange={(e) => setBuildType(e.target.value as BuildType)}
          className={inputCls}
        >
          {BUILD_TYPES.map((bt) => (
            <option key={bt} value={bt}>
              {BUILD_TYPE_LABELS[bt]}
            </option>
          ))}
        </select>
      </Field>

      {buildType === "dockerfile" && (
        <div className="space-y-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
          <Field label="Dockerfile path" hint="relative to the repo root">
            <input
              value={dockerfile}
              onChange={(e) => setDockerfile(e.target.value)}
              placeholder="Dockerfile"
              className={inputCls}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Build context" hint="optional">
              <input
                value={contextPath}
                onChange={(e) => setContextPath(e.target.value)}
                placeholder="."
                className={inputCls}
              />
            </Field>
            <Field label="Build stage" hint="optional target">
              <input
                value={buildStage}
                onChange={(e) => setBuildStage(e.target.value)}
                placeholder="—"
                className={inputCls}
              />
            </Field>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between">
        <RedeployToggle checked={redeploy} onChange={setRedeploy} />
        <SaveRow saving={saving} saved={saved} error={error} disabled={!dirty} onSave={save} />
      </div>
    </div>
  );
}

function DockerSourceForm({ app }: { app: Application }) {
  const [image, setImage] = useState(app.dockerImage ?? "");
  const [registryUrl, setRegistryUrl] = useState(app.registryUrl ?? "");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [redeploy, setRedeploy] = useState(false);
  const [saving, startSave] = useTransition();
  const [saved, flashSaved] = useSavedFlash();
  const [error, setError] = useState<string | null>(null);

  // Credentials are never read back from Dokploy, so treat any input here (or an
  // image/registry change) as a reason to resubmit the whole docker source.
  const dirty =
    image.trim() !== (app.dockerImage ?? "") ||
    registryUrl.trim() !== (app.registryUrl ?? "") ||
    username !== "" ||
    password !== "";

  function save() {
    setError(null);
    startSave(async () => {
      const res = await setAppDockerSourceAction(
        app.id,
        image,
        { username: username.trim(), password, registryUrl: registryUrl.trim() },
        redeploy
      );
      if (res.ok) {
        setUsername("");
        setPassword("");
        flashSaved();
      } else setError(res.error);
    });
  }

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-[var(--color-fg)]">Image &amp; registry</h3>
      <Field label="Image" hint="repo:tag">
        <input
          value={image}
          onChange={(e) => setImage(e.target.value)}
          placeholder="registry.example.com/app:latest"
          className={inputCls}
        />
      </Field>
      <div className="space-y-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
        <p className="text-[11px] text-[var(--color-fg-subtle)]">
          Private registry credentials (leave blank for public images).
        </p>
        <Field label="Registry URL" hint="optional">
          <input
            value={registryUrl}
            onChange={(e) => setRegistryUrl(e.target.value)}
            placeholder="registry.example.com"
            className={inputCls}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Username">
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="off"
              className={inputCls}
            />
          </Field>
          <Field label="Password">
            <div className="relative">
              <input
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="off"
                className={inputCls}
              />
              <button
                type="button"
                onClick={() => setShowPassword((s) => !s)}
                aria-label={showPassword ? "Hide password" : "Show password"}
                aria-pressed={showPassword}
                className="absolute inset-y-0 right-2 flex items-center text-[var(--color-fg-subtle)] hover:text-[var(--color-fg)]"
              >
                {showPassword ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
              </button>
            </div>
          </Field>
        </div>
      </div>
      <div className="flex items-center justify-between">
        <RedeployToggle checked={redeploy} onChange={setRedeploy} />
        <SaveRow saving={saving} saved={saved} error={error} disabled={!dirty} onSave={save} />
      </div>
    </div>
  );
}

function StartCommandForm({ app }: { app: Application }) {
  const [command, setCommand] = useState(app.command ?? "");
  const [redeploy, setRedeploy] = useState(false);
  const [saving, startSave] = useTransition();
  const [saved, flashSaved] = useSavedFlash();
  const [error, setError] = useState<string | null>(null);

  const dirty = command !== (app.command ?? "");

  function save() {
    setError(null);
    startSave(async () => {
      const res = await updateApplicationAction(
        app.id,
        { command: command.trim() || null },
        redeploy
      );
      if (res.ok) flashSaved();
      else setError(res.error);
    });
  }

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-[var(--color-fg)]">Start command</h3>
      <Field label="Custom run command" hint="blank = image/build default">
        <input
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          placeholder="e.g. node dist/server.js"
          className={`${inputCls} font-mono`}
        />
      </Field>
      <div className="flex items-center justify-between">
        <RedeployToggle checked={redeploy} onChange={setRedeploy} />
        <SaveRow saving={saving} saved={saved} error={error} disabled={!dirty} onSave={save} />
      </div>
    </div>
  );
}

// --- Deploy tab (Swarm runtime settings) ------------------------------------

// Docker Swarm expresses HealthConfig/RestartPolicy durations in nanoseconds.
// We show friendly seconds in the UI and convert at the boundary.
const NS_PER_SEC = 1_000_000_000;
const secToNs = (s: string) => Math.round(Number(s) * NS_PER_SEC);
const nsToSec = (ns?: number) =>
  ns == null ? "" : String(Number((ns / NS_PER_SEC).toFixed(3)));

/** Render Docker's health-check Test array back into a plain command string. */
function decodeTest(test?: string[]): string {
  if (!test || test.length === 0) return "";
  if (test[0] === "CMD-SHELL" || test[0] === "CMD") return test.slice(1).join(" ");
  if (test[0] === "NONE") return "";
  return test.join(" ");
}

function DeploySection({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div>
        <h3 className="text-sm font-semibold text-[var(--color-fg)]">{title}</h3>
        {hint && <p className="mt-0.5 text-xs text-[var(--color-fg-subtle)]">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

/** Shared save state for a Deploy sub-form, with an opt-in redeploy toggle. */
function useDeploySave(app: Application) {
  const [redeploy, setRedeploy] = useState(false);
  const [saving, startSave] = useTransition();
  const [saved, flashSaved] = useSavedFlash();
  const [error, setError] = useState<string | null>(null);
  const save = (patch: ApplicationPatch) => {
    setError(null);
    startSave(async () => {
      const res = await updateApplicationAction(app.id, patch, redeploy);
      if (res.ok) flashSaved();
      else setError(res.error);
    });
  };
  return { redeploy, setRedeploy, saving, saved, error, save };
}

function ReplicasForm({ app }: { app: Application }) {
  const current = String(app.replicas ?? 1);
  const [replicas, setReplicas] = useState(current);
  const { redeploy, setRedeploy, saving, saved, error, save } = useDeploySave(app);
  const dirty = replicas !== "" && replicas !== current;

  return (
    <DeploySection
      title="Replicas"
      hint="Number of container instances Swarm keeps running. 0 stops all tasks without deleting the service."
    >
      <div className="w-32">
        <Field label="Instances">
          <input
            value={replicas}
            onChange={(e) => setReplicas(e.target.value.replace(/[^0-9]/g, ""))}
            inputMode="numeric"
            placeholder="1"
            className={inputCls}
          />
        </Field>
      </div>
      <div className="flex items-center justify-between gap-2">
        <RedeployToggle checked={redeploy} onChange={setRedeploy} />
        <SaveRow
          saving={saving}
          saved={saved}
          error={error}
          disabled={!dirty}
          onSave={() => save({ replicas: Number(replicas) })}
        />
      </div>
    </DeploySection>
  );
}

function RestartPolicyForm({ app }: { app: Application }) {
  const curCond = app.restartPolicySwarm?.Condition ?? "";
  const curMax =
    app.restartPolicySwarm?.MaxAttempts != null
      ? String(app.restartPolicySwarm.MaxAttempts)
      : "";
  const [condition, setCondition] = useState<string>(curCond);
  const [maxAttempts, setMaxAttempts] = useState(curMax);
  const { redeploy, setRedeploy, saving, saved, error, save } = useDeploySave(app);
  const dirty = condition !== curCond || maxAttempts !== curMax;

  function onSave() {
    // Merge over any existing policy so Delay/Window set via Dokploy's advanced
    // UI survive. The schema is `.strict()`, so only known keys may be sent.
    const base: RestartPolicySwarm = { ...(app.restartPolicySwarm ?? {}) };
    if (condition) base.Condition = condition as RestartCondition;
    else delete base.Condition;
    if (maxAttempts !== "") base.MaxAttempts = Number(maxAttempts);
    else delete base.MaxAttempts;
    save({ restartPolicySwarm: Object.keys(base).length > 0 ? base : null });
  }

  return (
    <DeploySection
      title="Restart policy"
      hint="How Swarm reacts when a task exits. Applied on the next deploy."
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="Condition">
          <select
            value={condition}
            onChange={(e) => setCondition(e.target.value)}
            className={inputCls}
          >
            <option value="">Default (any)</option>
            <option value="none">None</option>
            <option value="on-failure">On failure</option>
            <option value="any">Any</option>
          </select>
        </Field>
        <Field label="Max attempts" hint="0 = unlimited">
          <input
            value={maxAttempts}
            onChange={(e) => setMaxAttempts(e.target.value.replace(/[^0-9]/g, ""))}
            inputMode="numeric"
            placeholder="unset"
            className={inputCls}
          />
        </Field>
      </div>
      <div className="flex items-center justify-between gap-2">
        <RedeployToggle checked={redeploy} onChange={setRedeploy} />
        <SaveRow
          saving={saving}
          saved={saved}
          error={error}
          disabled={!dirty}
          onSave={onSave}
        />
      </div>
    </DeploySection>
  );
}

function HealthCheckForm({ app }: { app: Application }) {
  const hc = app.healthCheckSwarm;
  const curCmd = decodeTest(hc?.Test);
  const curInterval = nsToSec(hc?.Interval);
  const curTimeout = nsToSec(hc?.Timeout);
  const curStart = nsToSec(hc?.StartPeriod);
  const curRetries = hc?.Retries != null ? String(hc.Retries) : "";
  const [cmd, setCmd] = useState(curCmd);
  const [intervalSec, setIntervalSec] = useState(curInterval);
  const [timeoutSec, setTimeoutSec] = useState(curTimeout);
  const [startSec, setStartSec] = useState(curStart);
  const [retries, setRetries] = useState(curRetries);
  const { redeploy, setRedeploy, saving, saved, error, save } = useDeploySave(app);
  const dirty =
    cmd !== curCmd ||
    intervalSec !== curInterval ||
    timeoutSec !== curTimeout ||
    startSec !== curStart ||
    retries !== curRetries;

  const decimal = (v: string) => v.replace(/[^0-9.]/g, "");

  function onSave() {
    const next: HealthCheckSwarm = {};
    const c = cmd.trim();
    if (c) next.Test = ["CMD-SHELL", c];
    if (intervalSec !== "") next.Interval = secToNs(intervalSec);
    if (timeoutSec !== "") next.Timeout = secToNs(timeoutSec);
    if (startSec !== "") next.StartPeriod = secToNs(startSec);
    if (retries !== "") next.Retries = Number(retries);
    save({ healthCheckSwarm: Object.keys(next).length > 0 ? next : null });
  }

  return (
    <DeploySection
      title="Healthcheck"
      hint="Swarm runs this inside the container to gate traffic and rolling deploys. Applied on the next deploy."
    >
      <Field label="Test command" hint="wrapped as CMD-SHELL">
        <input
          value={cmd}
          onChange={(e) => setCmd(e.target.value)}
          placeholder="curl -f http://localhost:3000/health"
          className={inputCls}
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Interval (s)">
          <input
            value={intervalSec}
            onChange={(e) => setIntervalSec(decimal(e.target.value))}
            inputMode="decimal"
            placeholder="unset"
            className={inputCls}
          />
        </Field>
        <Field label="Timeout (s)">
          <input
            value={timeoutSec}
            onChange={(e) => setTimeoutSec(decimal(e.target.value))}
            inputMode="decimal"
            placeholder="unset"
            className={inputCls}
          />
        </Field>
        <Field label="Start period (s)">
          <input
            value={startSec}
            onChange={(e) => setStartSec(decimal(e.target.value))}
            inputMode="decimal"
            placeholder="unset"
            className={inputCls}
          />
        </Field>
        <Field label="Retries">
          <input
            value={retries}
            onChange={(e) => setRetries(e.target.value.replace(/[^0-9]/g, ""))}
            inputMode="numeric"
            placeholder="unset"
            className={inputCls}
          />
        </Field>
      </div>
      <div className="flex items-center justify-between gap-2">
        <RedeployToggle checked={redeploy} onChange={setRedeploy} />
        <SaveRow
          saving={saving}
          saved={saved}
          error={error}
          disabled={!dirty}
          onSave={onSave}
        />
      </div>
    </DeploySection>
  );
}

export function AppDeployTab({ app }: { app: Application }) {
  return (
    <div className="space-y-4">
      <p className="text-xs text-[var(--color-fg-muted)]">
        Runtime settings for the Docker Swarm service. Each card saves
        independently; toggle{" "}
        <span className="font-medium">Redeploy now</span> to apply immediately,
        otherwise changes take effect on the next deploy.
      </p>
      <ReplicasForm app={app} />
      <RestartPolicyForm app={app} />
      <HealthCheckForm app={app} />
    </div>
  );
}

export function AppSettingsTab({ app, onClose }: { app: Application; onClose: () => void }) {
  const { pending: lifePending, error: lifeError, run } = useAppLifecycle(app);
  const [name, setName] = useState(app.name);
  const [cpu, setCpu] = useState(app.cpuLimit ?? "");
  const [mem, setMem] = useState(app.memoryLimit ?? "");
  const [cpuRes, setCpuRes] = useState(app.cpuReservation ?? "");
  const [memRes, setMemRes] = useState(app.memoryReservation ?? "");
  const [saving, startSave] = useTransition();
  const [saved, flashSaved] = useSavedFlash();
  const [saveError, setSaveError] = useState<string | null>(null);

  const resourcesDirty =
    cpu !== (app.cpuLimit ?? "") ||
    mem !== (app.memoryLimit ?? "") ||
    cpuRes !== (app.cpuReservation ?? "") ||
    memRes !== (app.memoryReservation ?? "");
  const dirty = name !== app.name || resourcesDirty;

  function save() {
    setSaveError(null);
    startSave(async () => {
      const res = await updateApplicationAction(
        app.id,
        {
          name: name.trim(),
          cpuLimit: cpu || null,
          memoryLimit: mem || null,
          cpuReservation: cpuRes || null,
          memoryReservation: memRes || null,
        },
        // Resource changes only bind on redeploy.
        resourcesDirty
      );
      if (res.ok) flashSaved();
      else setSaveError(res.error);
    });
  }

  return (
    <div className="space-y-5">
      <div className="space-y-3">
        <Field label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="CPU limit" hint='e.g. "0.5"'>
            <input value={cpu} onChange={(e) => setCpu(e.target.value)} placeholder="unlimited" className={inputCls} />
          </Field>
          <Field label="Memory limit" hint='e.g. "256m"'>
            <input value={mem} onChange={(e) => setMem(e.target.value)} placeholder="unlimited" className={inputCls} />
          </Field>
          <Field label="CPU reservation" hint="soft floor">
            <input value={cpuRes} onChange={(e) => setCpuRes(e.target.value)} placeholder="none" className={inputCls} />
          </Field>
          <Field label="Memory reservation" hint="soft floor">
            <input value={memRes} onChange={(e) => setMemRes(e.target.value)} placeholder="none" className={inputCls} />
          </Field>
        </div>
        <SaveRow saving={saving} saved={saved} error={saveError} disabled={!dirty} onSave={save} />
      </div>

      <Info label="App name" value={app.appName} mono />

      <DangerZone
        name={app.name}
        message="Destroying removes the application and its container."
        pending={lifePending}
        error={lifeError}
        onDestroy={() => run("remove", onClose)}
      />
    </div>
  );
}

// --- schedules --------------------------------------------------------------

export function SchedulesTab({ app }: { app: Application }) {
  const [schedules, setSchedules] = useState<Schedule[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, startLoad] = useTransition();

  const reload = useCallback(() => {
    startLoad(async () => {
      const res = await listSchedulesAction(app.id);
      if (res.ok) {
        setSchedules(res.schedules);
        setLoadError(null);
      } else {
        setLoadError(res.error);
      }
    });
  }, [app.id]);

  useEffect(() => reload(), [reload]);

  return (
    <div className="space-y-5">
      <p className="text-xs text-[var(--color-fg-muted)]">
        Cron jobs run a command inside this app&apos;s container on a schedule (times are UTC). The
        container must be running when the job fires.
      </p>

      <CreateScheduleForm applicationId={app.id} onCreated={reload} />

      <div className="space-y-2">
        {schedules === null ? (
          <div className="flex items-center gap-2 text-xs text-[var(--color-fg-subtle)]">
            <Loader2 className="size-4 animate-spin" /> loading schedules…
          </div>
        ) : loadError ? (
          <p role="alert" className="text-xs text-[var(--color-danger)]">{loadError}</p>
        ) : schedules.length === 0 ? (
          <p className="text-xs text-[var(--color-fg-subtle)]">No schedules yet.</p>
        ) : (
          schedules.map((s) => <ScheduleRow key={s.scheduleId} schedule={s} onChanged={reload} />)
        )}
      </div>
      {loading && schedules !== null && (
        <div className="flex items-center gap-1.5 text-[10px] text-[var(--color-fg-subtle)]">
          <Loader2 className="size-3 animate-spin" /> refreshing…
        </div>
      )}
    </div>
  );
}

const CRON_PLACEHOLDER = "0 3 * * *";

function CreateScheduleForm({
  applicationId,
  onCreated,
}: {
  applicationId: string;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [cron, setCron] = useState("");
  const [command, setCommand] = useState("");
  const [shell, setShell] = useState<"bash" | "sh">("bash");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const valid = name.trim() && cron.trim() && command.trim();

  function create() {
    if (!valid) return;
    setError(null);
    start(async () => {
      const res = await createScheduleAction({
        applicationId,
        name: name.trim(),
        cronExpression: cron.trim(),
        command: command.trim(),
        shellType: shell,
      });
      if (res.ok) {
        setName("");
        setCron("");
        setCommand("");
        setShell("bash");
        onCreated();
      } else {
        setError(res.error);
      }
    });
  }

  return (
    <div className="space-y-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div className="flex items-center gap-1.5 text-xs font-medium text-[var(--color-fg-muted)]">
        <Plus className="size-3.5" /> New schedule
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Name">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="nightly-backup"
            className={inputCls}
          />
        </Field>
        <Field label="Cron expression" hint="min hour dom mon dow">
          <input
            value={cron}
            onChange={(e) => setCron(e.target.value)}
            placeholder={CRON_PLACEHOLDER}
            className={cn(inputCls, "font-mono")}
          />
        </Field>
      </div>
      <Field label="Command">
        <input
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          placeholder="node scripts/cleanup.js"
          className={cn(inputCls, "font-mono")}
        />
      </Field>
      <div className="flex items-end justify-between gap-3">
        <div className="w-28">
          <Field label="Shell">
            <select
              value={shell}
              onChange={(e) => setShell(e.target.value as "bash" | "sh")}
              className={inputCls}
            >
              <option value="bash">bash</option>
              <option value="sh">sh</option>
            </select>
          </Field>
        </div>
        <button
          onClick={create}
          disabled={pending || !valid}
          className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--color-brand-strong)] px-3 py-2 text-xs font-semibold text-white hover:bg-[var(--color-brand-deep)] disabled:opacity-40"
        >
          {pending ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
          Create
        </button>
      </div>
      {error && <p role="alert" className="text-xs text-[var(--color-danger)]">{error}</p>}
    </div>
  );
}

function ScheduleRow({ schedule, onChanged }: { schedule: Schedule; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Draft fields, initialized from the schedule; reset when the row collapses.
  const [name, setName] = useState(schedule.name);
  const [cron, setCron] = useState(schedule.cronExpression);
  const [command, setCommand] = useState(schedule.command);
  const [shell, setShell] = useState(schedule.shellType);

  function openEdit() {
    setName(schedule.name);
    setCron(schedule.cronExpression);
    setCommand(schedule.command);
    setShell(schedule.shellType);
    setError(null);
    setEditing(true);
  }

  // update reuses Dokploy's create schema, so every field is resent each time.
  function runUpdate(patch: { enabled?: boolean }, after?: () => void) {
    setError(null);
    start(async () => {
      const res = await updateScheduleAction(schedule.scheduleId, {
        name: name.trim() || schedule.name,
        cronExpression: cron.trim() || schedule.cronExpression,
        command: command.trim() || schedule.command,
        shellType: shell,
        enabled: patch.enabled ?? schedule.enabled,
      });
      if (res.ok) after?.();
      else setError(res.error);
    });
  }

  function act(fn: () => Promise<{ ok: true } | { ok: false; error: string }>) {
    setError(null);
    start(async () => {
      const res = await fn();
      if (res.ok) onChanged();
      else setError(res.error);
    });
  }

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5">
      <div className="flex items-center gap-2.5">
        <Clock
          className={cn(
            "size-3.5 shrink-0",
            schedule.enabled ? "text-[var(--color-brand)]" : "text-[var(--color-idle)]"
          )}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm">{schedule.name}</span>
            <code className="shrink-0 rounded bg-[var(--color-bg-elevated)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-fg-muted)]">
              {schedule.cronExpression}
            </code>
            {!schedule.enabled && (
              <span className="shrink-0 text-[10px] text-[var(--color-fg-subtle)]">disabled</span>
            )}
          </div>
          <code className="mt-0.5 block truncate font-mono text-[11px] text-[var(--color-fg-subtle)]">
            {schedule.shellType} -c {schedule.command}
          </code>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <IconBtn title="Run now" onClick={() => act(() => runScheduleAction(schedule.scheduleId))} disabled={busy}>
            <Play className="size-3.5" />
          </IconBtn>
          <IconBtn
            title={schedule.enabled ? "Disable" : "Enable"}
            onClick={() => runUpdate({ enabled: !schedule.enabled }, onChanged)}
            disabled={busy}
          >
            <Power className={cn("size-3.5", schedule.enabled && "text-[var(--color-ok)]")} />
          </IconBtn>
          <IconBtn title="Edit" ariaExpanded={editing} onClick={() => (editing ? setEditing(false) : openEdit())} disabled={busy}>
            <Pencil className="size-3.5" />
          </IconBtn>
          <IconBtn
            title="Delete"
            onClick={() => {
              if (confirm(`Delete schedule "${schedule.name}"?`))
                act(() => deleteScheduleAction(schedule.scheduleId));
            }}
            disabled={busy}
          >
            <Trash2 className="size-3.5 text-[var(--color-danger)]" />
          </IconBtn>
        </div>
      </div>

      {editing && (
        <div className="mt-3 space-y-3 border-t border-[var(--color-border)] pt-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Name">
              <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} />
            </Field>
            <Field label="Cron expression">
              <input
                value={cron}
                onChange={(e) => setCron(e.target.value)}
                className={cn(inputCls, "font-mono")}
              />
            </Field>
          </div>
          <Field label="Command">
            <input
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              className={cn(inputCls, "font-mono")}
            />
          </Field>
          <div className="flex items-end justify-between gap-3">
            <div className="w-28">
              <Field label="Shell">
                <select
                  value={shell}
                  onChange={(e) => setShell(e.target.value as "bash" | "sh")}
                  className={inputCls}
                >
                  <option value="bash">bash</option>
                  <option value="sh">sh</option>
                </select>
              </Field>
            </div>
            <SaveRow
              saving={busy}
              saved={false}
              error={null}
              disabled={!name.trim() || !cron.trim() || !command.trim()}
              onSave={() => runUpdate({}, () => {
                setEditing(false);
                onChanged();
              })}
            />
          </div>
        </div>
      )}

      {error && <p role="alert" className="mt-2 text-xs text-[var(--color-danger)]">{error}</p>}
    </div>
  );
}

function IconBtn({
  children,
  title,
  onClick,
  disabled,
  ariaExpanded,
}: {
  children: React.ReactNode;
  title: string;
  onClick: () => void;
  disabled?: boolean;
  ariaExpanded?: boolean;
}) {
  return (
    <button
      title={title}
      aria-label={title}
      aria-expanded={ariaExpanded}
      onClick={onClick}
      disabled={disabled}
      className="rounded-md p-1.5 text-[var(--color-fg-subtle)] hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-fg)] disabled:opacity-40"
    >
      {children}
    </button>
  );
}
