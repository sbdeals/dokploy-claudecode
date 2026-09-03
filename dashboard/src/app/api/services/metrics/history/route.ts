import { unstable_rethrow } from "next/navigation";

import { knownAppNames } from "@/lib/dokploy";
import { sessionFromRequest, unauthorized } from "@/lib/session";
import { queryMetrics, storeEnabled } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Metric history over a time range from the durable store.
 *   GET /api/services/metrics/history?app=<appName>&since=<ms>&until=<ms>
 * Returns { enabled, samples }. When no store is configured `enabled` is false
 * and the client falls back to live-only mode.
 */
export async function GET(request: Request) {
  // The proxy only proves a session cookie EXISTS; verify it here.
  if (!sessionFromRequest(request)) return unauthorized();

  const url = new URL(request.url);
  const app = url.searchParams.get("app");
  if (!app) return new Response("missing ?app", { status: 400 });

  // The store holds samples for every service on the host, so only serve the
  // ones backing this user's Dokploy services — and fail closed if that
  // allow-list can't be built (same contract as the live metrics/logs routes).
  let allowed: Set<string>;
  try {
    allowed = await knownAppNames();
  } catch (e) {
    unstable_rethrow(e);
    return new Response("workspace unavailable", { status: 503 });
  }
  if (!allowed.has(app)) return new Response("unknown app", { status: 403 });

  if (!storeEnabled()) {
    return Response.json({ enabled: false, samples: [] });
  }

  const now = Date.now();
  const sinceParam = Number(url.searchParams.get("since"));
  const untilParam = Number(url.searchParams.get("until"));
  const since = Number.isFinite(sinceParam) && sinceParam > 0 ? sinceParam : now - 60 * 60_000;
  const until = Number.isFinite(untilParam) && untilParam > 0 ? untilParam : now;

  const samples = await queryMetrics(app, since, until);
  return Response.json({ enabled: true, samples });
}
