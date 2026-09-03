import { unstable_rethrow } from "next/navigation";

import { knownAppNames } from "@/lib/dokploy";
import { sessionFromRequest, unauthorized } from "@/lib/session";
import { getHttpMetrics } from "@/lib/traefik-metrics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET ?app=<appName>&range=<minutes> -> { available, points }.
// `available:false` means the Traefik metrics endpoint has never been reached.
export async function GET(request: Request) {
  // The proxy only proves a session cookie EXISTS; verify it here.
  if (!sessionFromRequest(request)) return unauthorized();

  const url = new URL(request.url);
  const app = url.searchParams.get("app");
  if (!app) return Response.json({ error: "missing ?app" }, { status: 400 });

  const rangeRaw = Number(url.searchParams.get("range"));
  const range = Number.isFinite(rangeRaw) && rangeRaw > 0 ? Math.min(rangeRaw, 1440) : 60;

  // Guard: only serve metrics for one of the current user's services. The
  // scraper holds traffic data for every Traefik router on the host, so if the
  // allow-list can't be built (Dokploy down, session rejected) we fail CLOSED —
  // a request we can't authorize must not see any of it.
  let allowed: Set<string>;
  try {
    allowed = await knownAppNames();
  } catch (e) {
    unstable_rethrow(e);
    return Response.json(
      { available: false, points: [], error: "workspace unavailable" },
      { status: 503 },
    );
  }
  if (!allowed.has(app)) {
    // Same body shape the panel expects, so an unknown app renders as "no data".
    return Response.json({ available: false, points: [] }, { status: 403 });
  }

  return Response.json(getHttpMetrics(app, range));
}
