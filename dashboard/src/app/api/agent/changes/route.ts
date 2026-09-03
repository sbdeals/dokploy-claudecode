import { isAgentConfigured } from "@/lib/agent/client";
import { applyStaged } from "@/lib/agent/ops";
import { listStaged, removeStaged, sessionKey, type StagedChange } from "@/lib/agent/store";
import { sessionFromRequest, unauthorized } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function publicView(c: StagedChange) {
  return { id: c.id, kind: c.kind, description: c.description, createdAt: c.createdAt };
}

/** GET -> { configured, changes: [...] } */
export async function GET(req: Request) {
  // The proxy only proves a session cookie EXISTS; verify it before reading
  // or applying anything.
  if (!sessionFromRequest(req)) return unauthorized();
  const key = sessionKey(req);
  return Response.json({
    configured: isAgentConfigured(),
    changes: listStaged(key).map(publicView),
  });
}

/**
 * POST { action: "apply" | "discard", ids?: string[] }
 *  - apply:   execute the (selected) staged changes; return per-change results;
 *             successfully applied changes are removed from the queue.
 *  - discard: remove the (selected) staged changes without executing.
 */
export async function POST(req: Request) {
  if (!sessionFromRequest(req)) return unauthorized();
  const key = sessionKey(req);
  let body: { action?: string; ids?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === "string") : undefined;

  if (body.action === "discard") {
    const removed = removeStaged(key, ids);
    return Response.json({ discarded: removed.map((c) => c.id) });
  }

  if (body.action === "apply") {
    const all = listStaged(key);
    const idSet = ids ? new Set(ids) : null;
    const target = idSet ? all.filter((c) => idSet.has(c.id)) : all;

    const results: { id: string; description: string; ok: boolean; error?: string }[] = [];
    const applied: string[] = [];
    for (const change of target) {
      try {
        await applyStaged(change);
        results.push({ id: change.id, description: change.description, ok: true });
        applied.push(change.id);
      } catch (e) {
        results.push({
          id: change.id,
          description: change.description,
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    // Drop the ones that succeeded; leave failures queued for retry.
    if (applied.length) removeStaged(key, applied);
    return Response.json({ results, remaining: listStaged(key).map(publicView) });
  }

  return Response.json({ error: 'Unknown action. Use "apply" or "discard".' }, { status: 400 });
}
