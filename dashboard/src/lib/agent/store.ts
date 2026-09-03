/**
 * In-memory store of "staged" (pending-approval) changes the agent has queued
 * but not yet executed. Destructive operations (delete/stop a service, delete a
 * domain or mount) are never run by the agent directly — they land here and
 * wait for the user to click "Apply" in the Railway-style changes bar.
 *
 * The store is a process-global singleton so it survives Next.js HMR reloads and
 * repeated imports (same pattern as lib/collector.ts). It is keyed per user so
 * two people driving the same dashboard don't see each other's queued changes.
 */
import "server-only";
import { createHash } from "node:crypto";

import type { SwitchyardSession } from "@/lib/session";

/** The kinds of operation that must be staged rather than executed. */
export type StagedKind = "delete_service" | "stop_service" | "delete_domain" | "delete_mount";

export interface StagedChange {
  id: string;
  kind: StagedKind;
  /** Opaque params consumed by ops.applyStaged when the user approves. */
  params: Record<string, unknown>;
  /** Human-readable one-liner shown in the Apply bar / details modal. */
  description: string;
  createdAt: number;
}

interface StagedRuntime {
  /** sessionKey -> ordered list of staged changes. */
  byKey: Map<string, StagedChange[]>;
}

const g = globalThis as unknown as { __switchyardAgentStaged?: StagedRuntime };
const rt: StagedRuntime =
  g.__switchyardAgentStaged ?? (g.__switchyardAgentStaged = { byKey: new Map() });

/**
 * Derive a stable per-login key from the VERIFIED session — the opened seal
 * (`sessionFromRequest`), never the raw cookie header, which a caller could
 * vary by re-encoding it. The Dokploy session token is hashed so the raw value
 * is never used as a map key. Two browsers signed into the same account hold
 * different Dokploy sessions and therefore separate queues, matching the
 * per-browser agent conversation that produced the changes.
 */
export function sessionKey(session: SwitchyardSession): string {
  return createHash("sha256").update(session.dokployCookie).digest("hex").slice(0, 32);
}

export function listStaged(key: string): StagedChange[] {
  return rt.byKey.get(key) ?? [];
}

export function addStaged(
  key: string,
  entry: Omit<StagedChange, "id" | "createdAt">
): StagedChange {
  const change: StagedChange = {
    ...entry,
    id: `chg_${Math.random().toString(36).slice(2, 10)}`,
    createdAt: Date.now(),
  };
  const list = rt.byKey.get(key) ?? [];
  list.push(change);
  rt.byKey.set(key, list);
  return change;
}

/** Remove changes by id (or all when `ids` is undefined). Returns removed ones. */
export function removeStaged(key: string, ids?: string[]): StagedChange[] {
  const list = rt.byKey.get(key) ?? [];
  if (!ids) {
    rt.byKey.set(key, []);
    return list;
  }
  const idSet = new Set(ids);
  const removed = list.filter((c) => idSet.has(c.id));
  rt.byKey.set(
    key,
    list.filter((c) => !idSet.has(c.id))
  );
  return removed;
}
