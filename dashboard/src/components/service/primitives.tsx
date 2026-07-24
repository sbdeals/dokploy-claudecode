"use client";

/**
 * Shared building blocks for the service drawer tabs. Databases, applications
 * and compose stacks render the same buttons, fields, lifecycle controls and
 * danger zone — parameterized only by which server action they call.
 */

import {
  Children,
  cloneElement,
  isValidElement,
  useId,
  useState,
  useTransition,
} from "react";
import {
  Rocket,
  Play,
  Square,
  RefreshCw,
  Trash2,
  Copy,
  Check,
  Loader2,
  Globe,
  ExternalLink,
  Network,
  Sparkles,
} from "lucide-react";
import type { Action, AppDomain, ServiceStatus } from "@/lib/dokploy";
import type { ActionResult } from "@/app/actions";
import { StatusBadge } from "@/components/StatusBadge";
import { cn } from "@/lib/utils";

export const inputCls =
  "w-full rounded-lg border border-[var(--color-border-control)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-fg)] outline-none placeholder:text-[var(--color-fg-subtle)] focus:border-[var(--color-brand)] focus-visible:ring-2 focus-visible:ring-[var(--color-brand)]/50";

// --- hooks --------------------------------------------------------------------

/** Run lifecycle actions with shared pending/error handling. */
export function useLifecycle(runAction: (action: Action) => Promise<ActionResult>) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (action: Action, after?: () => void) => {
    setError(null);
    start(async () => {
      const res = await runAction(action);
      if (!res.ok) setError(res.error);
      else after?.();
    });
  };
  return { pending, error, run };
}

/** A "Saved" indicator that shows briefly after a successful save. */
export function useSavedFlash(ms = 1800) {
  const [saved, setSaved] = useState(false);
  const flash = () => {
    setSaved(true);
    setTimeout(() => setSaved(false), ms);
  };
  return [saved, flash] as const;
}

// --- primitives ---------------------------------------------------------------

export function Btn({
  children,
  onClick,
  disabled,
  primary,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium transition-colors disabled:opacity-40",
        primary
          ? "bg-[var(--color-brand-strong)] text-white hover:bg-[var(--color-brand-deep)]"
          : "border border-[var(--color-border-strong)] text-[var(--color-fg-muted)] hover:bg-[var(--color-surface)] hover:text-[var(--color-fg)]"
      )}
    >
      {children}
    </button>
  );
}

/**
 * Secondary "Generate URL" button: attaches a random routable host to a service
 * with no typing. Kept beside the custom-host form in both the application and
 * compose Domains sections. Real button + explicit focus ring + icon & text
 * (never color-only), so it stays keyboard- and screen-reader-accessible.
 */
export function GenerateUrlBtn({
  pending,
  disabled,
  onClick,
}: {
  pending: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending || disabled}
      className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 py-2 text-xs font-semibold text-[var(--color-fg)] transition-colors hover:bg-[var(--color-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand)] disabled:opacity-40"
    >
      {pending ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
      Generate URL
    </button>
  );
}

/**
 * Wire the Field label to the first native form control among `children`
 * (searching two levels deep, so wrappers like `<div className="relative">`
 * around an input still work). Controls without an id get `generated`.
 */
function labelTarget(
  children: React.ReactNode,
  generated: string
): { nodes: React.ReactNode; id?: string } {
  let found: string | undefined;
  const visit = (node: React.ReactNode, depth: number): React.ReactNode => {
    if (found !== undefined || !isValidElement(node)) return node;
    if (node.type === "input" || node.type === "select" || node.type === "textarea") {
      const props = node.props as { id?: string };
      found = props.id ?? generated;
      return props.id ? node : cloneElement(node as React.ReactElement<{ id?: string }>, { id: generated });
    }
    if (depth >= 2) return node;
    const props = node.props as { children?: React.ReactNode };
    if (props.children == null) return node;
    const nested = Children.map(props.children, (child) => visit(child, depth + 1));
    return cloneElement(node as React.ReactElement<{ children?: React.ReactNode }>, {}, nested);
  };
  const nodes = Children.map(children, (child) => visit(child, 0));
  return { nodes, id: found };
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  const generated = useId();
  const { nodes, id } = labelTarget(children, generated);
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between">
        <label htmlFor={id} className="text-xs font-medium text-[var(--color-fg-muted)]">
          {label}
        </label>
        {hint && <span className="text-[10px] text-[var(--color-fg-subtle)]">{hint}</span>}
      </div>
      {nodes}
    </div>
  );
}

export function Info({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
      <div className="text-xs text-[var(--color-fg-subtle)]">{label}</div>
      <div className={cn("mt-0.5 truncate text-sm", mono && "font-mono text-xs")} title={value}>
        {value}
      </div>
    </div>
  );
}

/** Copy-to-clipboard icon button with a brief confirmation state. */
export function CopyButton({ text }: { text: string }) {
  const [copied, flash] = useSavedFlash(1200);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(text);
        flash();
      }}
      aria-label="Copy to clipboard"
      className="shrink-0 rounded-md p-1 text-[var(--color-fg-subtle)] hover:text-[var(--color-fg)]"
    >
      {copied ? <Check className="size-3.5 text-[var(--color-ok)]" /> : <Copy className="size-3.5" />}
      <span aria-live="polite" className="sr-only">
        {copied ? "Copied" : ""}
      </span>
    </button>
  );
}

/** Small trailing "remove" icon button for config-list rows. */
export function RemoveBtn({
  onClick,
  pending,
  label = "Remove",
}: {
  onClick: () => void;
  pending: boolean;
  /** Name the item, e.g. "Remove redirect ^/old" — lists of bare "Remove"s are indistinguishable to screen readers. */
  label?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending}
      aria-label={label}
      className="shrink-0 rounded-md p-1 text-[var(--color-fg-subtle)] hover:text-[var(--color-danger)] disabled:opacity-40"
    >
      {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
    </button>
  );
}

// --- networking blocks ----------------------------------------------------------

/**
 * Railway-style Overview header: the primary public URL (first https domain,
 * else first domain) as a clickable link, plus the health badge. Shared by
 * applications and compose (both carry `domains`).
 */
export function PublicUrlBar({
  domains,
  status,
}: {
  domains: AppDomain[];
  status: ServiceStatus;
}) {
  const primary = domains.find((d) => d.https) ?? domains[0];
  const url = primary ? `${primary.https ? "https" : "http"}://${primary.host}` : null;
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3.5">
      <div className="min-w-0">
        <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-[var(--color-fg-subtle)]">
          Public URL
        </div>
        {url && primary ? (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex max-w-full items-center gap-1.5 text-sm font-medium text-[var(--color-brand)] hover:underline"
          >
            <Globe className="size-3.5 shrink-0" />
            <span className="truncate">{primary.host}</span>
            <ExternalLink className="size-3 shrink-0" />
          </a>
        ) : (
          <p className="text-xs text-[var(--color-fg-subtle)]">
            No domain yet — add one under Networking.
          </p>
        )}
      </div>
      <div className="shrink-0">
        <StatusBadge status={status} />
      </div>
    </div>
  );
}

/**
 * Private networking: the service's internal DNS name (its `appName`). Other
 * services on the overlay network reach it at this hostname — the analog of
 * Railway's `*.railway.internal`.
 */
export function PrivateNetwork({ host }: { host: string }) {
  return (
    <Field label="Private networking" hint="internal DNS">
      <div className="flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[#0b0b10] p-2.5">
        <Network className="size-3.5 shrink-0 text-[var(--color-fg-subtle)]" />
        <code className="flex-1 truncate font-mono text-[11px] text-[var(--color-fg-muted)]">
          {host}
        </code>
        <CopyButton text={host} />
      </div>
      <p className="mt-1 text-[10px] text-[var(--color-fg-subtle)]">
        Reachable from other services at this hostname on the internal network.
      </p>
    </Field>
  );
}

// --- composed blocks ------------------------------------------------------------

/** Deploy / Start / Stop / Redeploy buttons driven by the service status. */
export function LifecycleButtons({
  status,
  pending,
  error,
  run,
}: {
  status: ServiceStatus;
  pending: boolean;
  error: string | null;
  run: (action: Action) => void;
}) {
  return (
    <>
      <div className="flex flex-wrap gap-2">
        {status === "idle" ? (
          <Btn onClick={() => run("deploy")} disabled={pending} primary>
            <Rocket className="size-3.5" /> Deploy
          </Btn>
        ) : status === "done" ? (
          <Btn onClick={() => run("stop")} disabled={pending}>
            <Square className="size-3.5" /> Stop
          </Btn>
        ) : (
          <Btn onClick={() => run("start")} disabled={pending}>
            <Play className="size-3.5" /> Start
          </Btn>
        )}
        {status !== "idle" && (
          <Btn onClick={() => run("deploy")} disabled={pending}>
            <RefreshCw className="size-3.5" /> Redeploy
          </Btn>
        )}
      </div>
      {error && (
        <p role="alert" className="text-xs text-[var(--color-danger)]">
          {error}
        </p>
      )}
    </>
  );
}

/** Right-aligned save button with inline error / saved feedback. */
export function SaveRow({
  saving,
  saved,
  error,
  disabled,
  onSave,
  label = "Save changes",
}: {
  saving: boolean;
  saved: boolean;
  error: string | null;
  disabled?: boolean;
  onSave: () => void;
  label?: string;
}) {
  return (
    <div className="flex items-center justify-end gap-2">
      {error && (
        <span role="alert" className="text-xs text-[var(--color-danger)]">
          {error}
        </span>
      )}
      {saved && (
        <span role="status" className="flex items-center gap-1 text-xs text-[var(--color-ok)]">
          <Check className="size-3.5" /> Saved
        </span>
      )}
      <button
        type="button"
        onClick={onSave}
        disabled={saving || disabled}
        className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--color-brand-strong)] px-3.5 py-2 text-xs font-semibold text-white hover:bg-[var(--color-brand-deep)] disabled:opacity-40"
      >
        {saving && <Loader2 className="size-4 animate-spin" />}
        {label}
      </button>
    </div>
  );
}

/** Destroy block with confirmation; `message` names what gets removed. */
export function DangerZone({
  name,
  message,
  pending,
  error,
  onDestroy,
}: {
  name: string;
  message: string;
  pending: boolean;
  error: string | null;
  onDestroy: () => void;
}) {
  return (
    <div className="rounded-xl border border-[var(--color-danger)]/40 bg-[var(--color-danger-soft)] p-4">
      <h3 className="text-sm font-semibold text-[var(--color-danger)]">Danger zone</h3>
      <p className="mt-1 text-xs text-[var(--color-fg-muted)]">
        {message} This cannot be undone.
      </p>
      <button
        type="button"
        onClick={() => {
          if (confirm(`Destroy "${name}"? This cannot be undone.`)) onDestroy();
        }}
        disabled={pending}
        className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-[var(--color-danger)]/50 px-3 py-2 text-xs font-medium text-[var(--color-danger)] hover:bg-[var(--color-danger-soft)] disabled:opacity-50"
      >
        <Trash2 className="size-3.5" /> Destroy {name}
      </button>
      {error && (
        <p role="alert" className="mt-2 text-xs text-[var(--color-danger)]">
          {error}
        </p>
      )}
    </div>
  );
}
