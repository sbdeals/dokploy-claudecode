import { unstable_rethrow } from "next/navigation";

import { followStats } from "@/lib/docker";
import { knownAppNames } from "@/lib/dokploy";
import { sseFromLines, sseOnce } from "@/lib/sse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Stream container resource samples as SSE: data: {"ts","cpu","memUsed","memLimit","memPct"}.
export async function GET(request: Request) {
  const app = new URL(request.url).searchParams.get("app");
  if (!app) return new Response("missing ?app", { status: 400 });

  // Only sample containers backing this user's Dokploy services (fail closed).
  let allowed: Set<string>;
  try {
    allowed = await knownAppNames();
  } catch (e) {
    unstable_rethrow(e);
    return new Response("workspace unavailable", { status: 503 });
  }
  if (!allowed.has(app)) return new Response("unknown app", { status: 403 });

  // Attach to the container's stats stream. A Docker hiccup (socket stalled,
  // daemon mid-restart, op timeout) makes followStats reject; without this guard
  // the route would 500 and the browser's EventSource would retry forever with
  // no data — leaving the tab stuck on "sampling…". Emit a terminal `unavailable`
  // event instead so the client can show an honest message.
  let src: Awaited<ReturnType<typeof followStats>>;
  try {
    src = await followStats(app, allowed);
  } catch (e) {
    unstable_rethrow(e);
    console.warn(`[metrics] followStats failed for ${app}:`, e instanceof Error ? e.message : e);
    return sseOnce(`event: unavailable\ndata: {}\n\n`);
  }
  if (!src) return sseOnce(`event: idle\ndata: {}\n\n`);

  return sseFromLines(src, request, (line) => {
    // Docker emits one JSON stats object per line.
    try {
      return `data: ${JSON.stringify(src.toSample(JSON.parse(line)))}\n\n`;
    } catch {
      return null; // partial / non-JSON chunk
    }
  });
}
