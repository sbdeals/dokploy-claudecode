"use client";

import { useCallback, useEffect, useId, useRef, useState, useTransition } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useDialogFocus } from "@/components/use-focus-trap";
import {
  X,
  Database as DatabaseIcon,
  Rocket,
  Cpu,
  ScrollText,
  Settings2,
  SlidersHorizontal,
  KeyRound,
  Eye,
  EyeOff,
  Box,
  Globe,
  Layers,
  FileCode,
  Archive,
  Hammer,
  Clock,
  HardDrive,
  Server,
  TerminalSquare,
  Table2,
} from "lucide-react";
import type { Database, DatabasePatch, Service } from "@/lib/dokploy";
import { ENGINE_META } from "@/lib/engines";
import { LAST_DEPLOY_LABEL, serviceAccent, serviceLabel } from "@/lib/service-meta";
import { connectionString } from "@/lib/connection";
import { lifecycleAction, updateDatabaseAction } from "@/app/actions";
import { StatusBadge } from "@/components/StatusBadge";
import { VariablesTab } from "@/components/service/VariablesTab";
import { BackupsTab } from "@/components/service/BackupsTab";
import { VolumesTab } from "@/components/service/VolumesTab";
import { MetricsTab } from "@/components/service/MetricsTab";
import { LogsTab } from "@/components/service/LogsTab";
import { ConsoleTab } from "@/components/service/ConsoleTab";
import { DataTab } from "@/components/service/DataTab";
import {
  AppOverviewTab,
  AppBuildTab,
  AppDeployTab,
  AppSettingsTab,
  DeploymentsTab,
  DeploymentHistory,
  SchedulesTab,
} from "@/components/service/AppTabs";
import { NetworkingTab } from "@/components/service/networking";
import {
  ComposeOverviewTab,
  ComposeEditorTab,
  ComposeDomainsTab,
  ComposeSettingsTab,
} from "@/components/service/ComposeTabs";
import {
  inputCls,
  Field,
  Info,
  CopyButton,
  LifecycleButtons,
  SaveRow,
  DangerZone,
  useLifecycle,
  useSavedFlash,
} from "@/components/service/primitives";
import { cn } from "@/lib/utils";

type TabId =
  | "overview"
  | "variables"
  | "data"
  | "deploy"
  | "build"
  | "domains"
  | "deployments"
  | "schedules"
  | "editor"
  | "volumes"
  | "metrics"
  | "logs"
  | "console"
  | "backups"
  | "settings";
const TAB_META: Record<TabId, { label: string; icon: React.ReactNode }> = {
  overview: { label: "Overview", icon: <SlidersHorizontal className="size-4" /> },
  variables: { label: "Variables", icon: <KeyRound className="size-4" /> },
  data: { label: "Data", icon: <Table2 className="size-4" /> },
  deploy: { label: "Deploy", icon: <Server className="size-4" /> },
  build: { label: "Build", icon: <Hammer className="size-4" /> },
  domains: { label: "Networking", icon: <Globe className="size-4" /> },
  deployments: { label: "Deploys", icon: <Rocket className="size-4" /> },
  schedules: { label: "Schedules", icon: <Clock className="size-4" /> },
  editor: { label: "Compose", icon: <FileCode className="size-4" /> },
  volumes: { label: "Volumes", icon: <HardDrive className="size-4" /> },
  metrics: { label: "Metrics", icon: <Cpu className="size-4" /> },
  logs: { label: "Logs", icon: <ScrollText className="size-4" /> },
  console: { label: "Console", icon: <TerminalSquare className="size-4" /> },
  backups: { label: "Backups", icon: <Archive className="size-4" /> },
  settings: { label: "Settings", icon: <Settings2 className="size-4" /> },
};
const DB_TABS: TabId[] = [
  "overview",
  "variables",
  "volumes",
  "metrics",
  "logs",
  "console",
  "backups",
  "settings",
];
const APP_TABS: TabId[] = [
  "overview",
  "variables",
  "deploy",
  "build",
  "domains",
  "deployments",
  "schedules",
  "volumes",
  "metrics",
  "logs",
  "console",
  "settings",
];
const COMPOSE_TABS: TabId[] = [
  "overview",
  "variables",
  "domains",
  "deployments",
  "editor",
  "volumes",
  "metrics",
  "logs",
  "console",
  "settings",
];

/**
 * Whether to show the Postgres "Data" tab for a service. Covers the two data
 * models the tab supports: a Dokploy-managed Postgres database, and a compose
 * stack that declares a postgres-imaged service. Both signals are static (no
 * runtime container query) so the tab list can render synchronously; the tab
 * itself resolves the actual running container(s) server-side.
 */
function isPostgresService(s: Service): boolean {
  if (s.kind === "database") return s.engine === "postgres" || /postgres/i.test(s.dockerImage ?? "");
  if (s.kind === "compose") return composeMentionsPostgres(s.composeFile);
  return false;
}

/** True when a compose file has a service whose `image:` references postgres. */
function composeMentionsPostgres(file: string | null): boolean {
  if (!file) return false;
  return /^[ \t]*image:[ \t]*["']?[^\n#"']*postgres/im.test(file);
}

/** Insert the Data tab right after Overview. */
function withDataTab(base: TabId[]): TabId[] {
  const out = [...base];
  const i = out.indexOf("overview");
  out.splice(i + 1, 0, "data");
  return out;
}

/**
 * Resizable-drawer width, persisted per browser.
 *
 * The drawer is docked to the right, so its width is driven by dragging the
 * LEFT edge: drag the handle left → wider, right → narrower. The default
 * (`DEFAULT_WIDTH`) matches the old fixed `max-w-xl` (36rem / 576px) so nothing
 * shifts for users who never resize. Width is clamped to [MIN_WIDTH, 90vw] and
 * the upper bound tracks the viewport, so the drawer stays usable on small
 * windows (where 90vw can fall below MIN_WIDTH, the viewport cap wins).
 */
const DRAWER_WIDTH_KEY = "switchyard:drawer-width";
const DEFAULT_WIDTH = 576; // 36rem, == the previous max-w-xl
const MIN_WIDTH = 360;
const WIDTH_STEP = 24; // keyboard arrow increment (px)
const WIDTH_STEP_LARGE = 96; // PageUp/PageDown increment (px)

/** Largest allowed width for the current viewport (90vw). */
function maxDrawerWidth(): number {
  if (typeof window === "undefined") return DEFAULT_WIDTH;
  return Math.round(window.innerWidth * 0.9);
}

/** Clamp to [min(MIN_WIDTH, 90vw), 90vw] — the viewport cap wins on tiny windows. */
function clampWidth(w: number): number {
  const max = maxDrawerWidth();
  const min = Math.min(MIN_WIDTH, max);
  return Math.round(Math.min(Math.max(w, min), max));
}

function loadWidth(): number {
  if (typeof window === "undefined") return DEFAULT_WIDTH;
  try {
    const raw = localStorage.getItem(DRAWER_WIDTH_KEY);
    if (raw == null) return DEFAULT_WIDTH;
    const n = Number(raw);
    return Number.isFinite(n) ? clampWidth(n) : DEFAULT_WIDTH;
  } catch {
    return DEFAULT_WIDTH;
  }
}

function saveWidth(w: number) {
  try {
    localStorage.setItem(DRAWER_WIDTH_KEY, String(w));
  } catch {
    /* ignore (private mode / disabled storage) */
  }
}

/** State + persistence for the drawer width. */
function useDrawerWidth() {
  const [width, setWidth] = useState<number>(() => loadWidth());

  const apply = useCallback((next: number) => {
    const clamped = clampWidth(next);
    setWidth(clamped);
    saveWidth(clamped);
    return clamped;
  }, []);

  const reset = useCallback(() => apply(DEFAULT_WIDTH), [apply]);

  // Keep the drawer within 90vw when the window shrinks. Only the live value is
  // re-clamped (not persisted), so restoring the window keeps the user's pick.
  useEffect(() => {
    const onResize = () => setWidth((w) => clampWidth(w));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  return { width, apply, reset };
}

/**
 * Drag handle on the drawer's left edge. Pointer-drag resizes; it is also a
 * focusable `separator` so keyboard users can resize with the arrow keys
 * (Left/Up = wider, Right/Down = narrower, Home = min, End = max, PageUp/Down =
 * big step). Double-click / Enter / Space resets to the default width. The
 * live width is mirrored into aria-valuenow so assistive tech announces it.
 */
function ResizeHandle({
  width,
  apply,
  reset,
}: {
  width: number;
  apply: (n: number) => number;
  reset: () => void;
}) {
  const dragging = useRef(false);
  const start = useRef({ x: 0, w: 0 });

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // Only the primary button drags; ignore right/middle clicks.
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragging.current = true;
    start.current = { x: e.clientX, w: width };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    // Drawer is right-docked: leftward drag (smaller clientX) → wider.
    apply(start.current.w + (start.current.x - e.clientX));
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    dragging.current = false;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* pointer already released */
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    let handled = true;
    switch (e.key) {
      case "ArrowLeft":
      case "ArrowUp":
        apply(width + WIDTH_STEP);
        break;
      case "ArrowRight":
      case "ArrowDown":
        apply(width - WIDTH_STEP);
        break;
      case "PageUp":
        apply(width + WIDTH_STEP_LARGE);
        break;
      case "PageDown":
        apply(width - WIDTH_STEP_LARGE);
        break;
      case "Home":
        apply(MIN_WIDTH);
        break;
      case "End":
        apply(maxDrawerWidth());
        break;
      case "Enter":
      case " ":
        reset();
        break;
      default:
        handled = false;
    }
    if (handled) e.preventDefault();
  };

  const max = maxDrawerWidth();
  const min = Math.min(MIN_WIDTH, max);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize panel (arrow keys resize, double-click resets)"
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={reset}
      onKeyDown={onKeyDown}
      className="group absolute inset-y-0 left-0 z-10 flex w-2 -translate-x-1/2 cursor-col-resize touch-none items-center justify-center outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand)]/60"
    >
      {/* Visible grip: subtle by default, brightens on hover/focus. */}
      <span
        aria-hidden
        className="h-16 w-1 rounded-full bg-[var(--color-border-strong)] transition-colors group-hover:bg-[var(--color-brand)] group-focus-visible:bg-[var(--color-brand)]"
      />
    </div>
  );
}

export function ServiceDrawer({ service, onClose }: { service: Service | null; onClose: () => void }) {
  const [tab, setTab] = useState<TabId>("overview");
  const titleId = useId();
  const dialogRef = useDialogFocus<HTMLElement>(onClose);
  const { width, apply: applyWidth, reset: resetWidth } = useDrawerWidth();
  // Reset to Overview when a different service is opened (adjust state during
  // render — the React-recommended alternative to a resetting effect).
  const [shownId, setShownId] = useState<string | null>(null);
  if (service && service.id !== shownId) {
    setShownId(service.id);
    setTab("overview");
  }
  const baseTabs =
    service?.kind === "application"
      ? APP_TABS
      : service?.kind === "compose"
        ? COMPOSE_TABS
        : DB_TABS;
  const tabs = service && isPostgresService(service) ? withDataTab(baseTabs) : baseTabs;

  return (
    <AnimatePresence>
      {service && (
        <>
          <motion.div
            className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
          />
          <motion.aside
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ type: "spring", stiffness: 320, damping: 34 }}
            // Width is a layout property; the slide-in animates `x` (transform),
            // so resizing and the framer-motion animation never fight. maxWidth
            // is a CSS backstop for the same 90vw cap the JS clamp enforces.
            style={{ width, maxWidth: "90vw" }}
            className="fixed inset-y-0 right-0 z-50 flex flex-col border-l border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] shadow-2xl"
          >
            <ResizeHandle width={width} apply={applyWidth} reset={resetWidth} />
            <Header service={service} onClose={onClose} titleId={titleId} />
            <nav
              role="tablist"
              aria-label="Service sections"
              onKeyDown={(e) => {
                const idx = tabs.indexOf(tab);
                let next: number | null = null;
                if (e.key === "ArrowRight") next = (idx + 1) % tabs.length;
                else if (e.key === "ArrowLeft") next = (idx - 1 + tabs.length) % tabs.length;
                else if (e.key === "Home") next = 0;
                else if (e.key === "End") next = tabs.length - 1;
                if (next === null) return;
                e.preventDefault();
                setTab(tabs[next]);
                const el = e.currentTarget.querySelector<HTMLElement>(
                  `#drawer-tab-${tabs[next]}`
                );
                el?.focus();
              }}
              className="flex gap-1 overflow-x-auto border-b border-[var(--color-border)] px-4 [scrollbar-width:thin]"
            >
              {tabs.map((id) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  id={`drawer-tab-${id}`}
                  aria-selected={tab === id}
                  aria-controls="drawer-tabpanel"
                  tabIndex={tab === id ? 0 : -1}
                  onClick={() => setTab(id)}
                  className={cn(
                    "flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2.5 text-xs font-medium transition-colors",
                    tab === id
                      ? "border-[var(--color-brand)] text-[var(--color-fg)]"
                      : "border-transparent text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
                  )}
                >
                  {TAB_META[id].icon}
                  {TAB_META[id].label}
                </button>
              ))}
            </nav>

            <div
              id="drawer-tabpanel"
              role="tabpanel"
              aria-labelledby={`drawer-tab-${tab}`}
              tabIndex={0}
              className="flex-1 overflow-auto p-5"
            >
              {tab === "overview" &&
                (service.kind === "database" ? (
                  <OverviewTab db={service} />
                ) : service.kind === "compose" ? (
                  <ComposeOverviewTab compose={service} />
                ) : (
                  <AppOverviewTab app={service} />
                ))}
              {tab === "variables" && <VariablesTab service={service} />}
              {tab === "data" && <DataTab key={service.id} service={service} />}
              {tab === "deploy" && service.kind === "application" && <AppDeployTab app={service} />}
              {tab === "build" && service.kind === "application" && <AppBuildTab app={service} />}
              {tab === "domains" && service.kind === "application" && (
                <NetworkingTab app={service} />
              )}
              {tab === "domains" && service.kind === "compose" && (
                <ComposeDomainsTab compose={service} />
              )}
              {tab === "deployments" && service.kind === "application" && (
                <DeploymentsTab app={service} />
              )}
              {tab === "deployments" && service.kind === "compose" && (
                <DeploymentHistory deployments={service.deployments} />
              )}
              {tab === "schedules" && service.kind === "application" && (
                <SchedulesTab app={service} />
              )}
              {tab === "editor" && service.kind === "compose" && (
                <ComposeEditorTab compose={service} />
              )}
              {tab === "volumes" && <VolumesTab key={service.id} service={service} />}
              {tab === "metrics" && <MetricsTab key={service.appName} appName={service.appName} active />}
              {tab === "logs" && <LogsTab key={service.appName} appName={service.appName} active />}
              {tab === "console" && <ConsoleTab key={service.appName} appName={service.appName} />}
              {tab === "backups" && service.kind === "database" && <BackupsTab db={service} />}
              {tab === "settings" &&
                (service.kind === "database" ? (
                  <SettingsTab db={service} onClose={onClose} />
                ) : service.kind === "compose" ? (
                  <ComposeSettingsTab compose={service} onClose={onClose} />
                ) : (
                  <AppSettingsTab app={service} onClose={onClose} />
                ))}
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}

function Header({
  service,
  onClose,
  titleId,
}: {
  service: Service;
  onClose: () => void;
  titleId: string;
}) {
  const accent = serviceAccent(service);
  const Icon = service.kind === "database" ? DatabaseIcon : service.kind === "compose" ? Layers : Box;
  return (
    <div className="flex items-start justify-between gap-3 border-b border-[var(--color-border)] p-4">
      <div className="flex items-center gap-3">
        <div
          className="flex size-11 items-center justify-center rounded-xl"
          style={{ backgroundColor: `${accent}1a`, color: accent }}
        >
          <Icon className="size-5.5" />
        </div>
        <div>
          <div className="flex items-center gap-2">
            <h2 id={titleId} className="font-semibold">
              {service.name}
            </h2>
            <StatusBadge status={service.status} runtime={service.runtime} />
          </div>
          <div className="text-xs text-[var(--color-fg-muted)]">
            {serviceLabel(service)} · {service.projectName} / {service.environmentName}
          </div>
          <div className="text-[11px] text-[var(--color-fg-subtle)]">
            Last deploy: {LAST_DEPLOY_LABEL[service.status] ?? service.status}
          </div>
        </div>
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close service details"
        className="rounded-md p-1 text-[var(--color-fg-subtle)] hover:bg-[var(--color-surface)] hover:text-[var(--color-fg)]"
      >
        <X className="size-4" />
      </button>
    </div>
  );
}

const useDbLifecycle = (db: Database) =>
  useLifecycle((action) => lifecycleAction(db.engine, db.id, action));

function OverviewTab({ db }: { db: Database }) {
  const meta = ENGINE_META[db.engine];
  const { pending, error, run } = useDbLifecycle(db);
  const conn = connectionString(db);

  return (
    <div className="space-y-5">
      <LifecycleButtons status={db.status} pending={pending} error={error} run={run} />

      {conn && (
        <Field label="Connection string">
          <div className="flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[#0b0b10] p-2.5">
            <code className="flex-1 truncate font-mono text-[11px] text-[var(--color-fg-muted)]">
              {conn}
            </code>
            <CopyButton text={conn} />
          </div>
        </Field>
      )}

      <div className="grid grid-cols-2 gap-3">
        <Info label="Image" value={db.dockerImage ?? "—"} mono />
        <Info label="Internal port" value={String(meta.defaultPort)} />
        <Info label="Replicas" value={String(db.replicas ?? 1)} />
        <Info label="Database" value={db.databaseName ?? "—"} mono />
        <Info label="User" value={db.databaseUser ?? "—"} mono />
        <Info
          label="Resources"
          value={
            db.cpuLimit || db.memoryLimit
              ? `${db.cpuLimit ?? "∞"} CPU · ${db.memoryLimit ?? "∞"} mem`
              : "unlimited"
          }
        />
      </div>
    </div>
  );
}

function SettingsTab({ db, onClose }: { db: Database; onClose: () => void }) {
  const { pending: lifePending, error: lifeError, run } = useDbLifecycle(db);
  const meta = ENGINE_META[db.engine];
  const currentVersion = db.dockerImage?.split(":")[1] ?? meta.versions[0];

  const [name, setName] = useState(db.name);
  const [version, setVersion] = useState(currentVersion);
  const [port, setPort] = useState(db.externalPort != null ? String(db.externalPort) : "");
  const [cpu, setCpu] = useState(db.cpuLimit ?? "");
  const [mem, setMem] = useState(db.memoryLimit ?? "");
  const [saving, startSave] = useTransition();
  const [saved, flashSaved] = useSavedFlash();
  const [saveError, setSaveError] = useState<string | null>(null);

  const dirty =
    name !== db.name ||
    version !== currentVersion ||
    port !== (db.externalPort != null ? String(db.externalPort) : "") ||
    cpu !== (db.cpuLimit ?? "") ||
    mem !== (db.memoryLimit ?? "");

  function save() {
    setSaveError(null);
    const patch: DatabasePatch = {};
    if (name !== db.name) patch.name = name.trim();
    if (version !== currentVersion) patch.dockerImage = `${meta.image}:${version}`;
    if (port !== (db.externalPort != null ? String(db.externalPort) : ""))
      patch.externalPort = port ? Number(port) : null;
    if (cpu !== (db.cpuLimit ?? "")) patch.cpuLimit = cpu || null;
    if (mem !== (db.memoryLimit ?? "")) patch.memoryLimit = mem || null;
    startSave(async () => {
      const res = await updateDatabaseAction(db.engine, db.id, db.appName, patch);
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
          <Field label="Version" hint="changing redeploys">
            <select value={version} onChange={(e) => setVersion(e.target.value)} className={inputCls}>
              {meta.versions.map((v) => (
                <option key={v} value={v}>
                  {meta.image}:{v}
                </option>
              ))}
            </select>
          </Field>
          <Field label="External port" hint="blank = internal only">
            <input
              value={port}
              onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ""))}
              placeholder="—"
              className={inputCls}
            />
          </Field>
          <Field label="CPU limit" hint='e.g. "0.5"'>
            <input value={cpu} onChange={(e) => setCpu(e.target.value)} placeholder="unlimited" className={inputCls} />
          </Field>
          <Field label="Memory limit" hint='e.g. "256m"'>
            <input value={mem} onChange={(e) => setMem(e.target.value)} placeholder="unlimited" className={inputCls} />
          </Field>
        </div>
        <SaveRow saving={saving} saved={saved} error={saveError} disabled={!dirty} onSave={save} />
      </div>

      <PasswordRow db={db} />

      <Info label="App name" value={db.appName} mono />
      <Info label="Created" value={db.createdAt ? new Date(db.createdAt).toLocaleString() : "—"} />

      <DangerZone
        name={db.name}
        message="Destroying removes the service and its container."
        pending={lifePending}
        error={lifeError}
        onDestroy={() => run("remove", onClose)}
      />
    </div>
  );
}

function PasswordRow({ db }: { db: Database }) {
  const [show, setShow] = useState(false);
  if (!db.databasePassword) return null;
  return (
    <Field label="Password" hint="rotation coming soon">
      <div className="flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[#0b0b10] p-2">
        <code className="flex-1 truncate font-mono text-xs text-[var(--color-fg-muted)]">
          {show ? db.databasePassword : "•".repeat(16)}
        </code>
        <button
          type="button"
          onClick={() => setShow((s) => !s)}
          aria-label={show ? "Hide password" : "Show password"}
          aria-pressed={show}
          className="shrink-0 rounded-md p-1 text-[var(--color-fg-subtle)] hover:text-[var(--color-fg)]"
        >
          {show ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
        </button>
        <CopyButton text={db.databasePassword} />
      </div>
    </Field>
  );
}
