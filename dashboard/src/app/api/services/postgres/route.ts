import { unstable_rethrow } from "next/navigation";

import { knownAppNames } from "@/lib/dokploy";
import {
  fetchRows,
  listTables,
  listTargets,
  resolveTarget,
  runUserQuery,
} from "@/lib/postgres";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Backend for the service drawer's "Data" tab: a read-only-by-default Postgres
 * browser. Every operation runs by docker-exec'ing `psql` inside the service's
 * own container as its container-env POSTGRES_USER/DB — no external connection,
 * no user-supplied credentials (see lib/postgres.ts and lib/docker.ts).
 *
 * Security:
 *  - AuthN/Z: this route sits behind the same session gate as every dashboard
 *    API route (src/proxy.ts checks the sealed cookie's presence; knownAppNames
 *    below revalidates the per-user session and, on failure, redirects to
 *    /login). The requested `app` must be one of the current user's Dokploy
 *    services — otherwise an authed user could reach an unrelated host container
 *    by name. This mirrors /api/services/exec.
 *  - Read-only: the `query` op is classified server-side (lib/postgres.ts
 *    #classifyStatement) and rejected unless it is read-only OR the request
 *    explicitly sets allowWrites. The client flag can only relax the guard; the
 *    server validates the statement class regardless.
 *  - SQL is always delivered to psql over stdin, never interpolated into argv or
 *    a shell (see runPsqlCsv). Catalog-sourced identifiers are double-quoted.
 */

// Ops (documentation of the discriminated request shapes):
//   { op: "targets" }
//   { op: "tables";  target? }
//   { op: "rows";    target?, schema, table, limit?, offset? }
//   { op: "query";   target?, sql, allowWrites? }
// The body is parsed as a flat bag of unknowns and each field is validated with
// a typeof check below, so a malformed body can never coerce past the guards.
interface Body {
  app?: unknown;
  op?: unknown;
  target?: unknown;
  schema?: unknown;
  table?: unknown;
  limit?: unknown;
  offset?: unknown;
  sql?: unknown;
  allowWrites?: unknown;
}

const bad = (error: string, status = 400) => Response.json({ error }, { status });

export async function POST(request: Request) {
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return bad("Invalid JSON body.");
  }

  const app = typeof body.app === "string" ? body.app : "";
  const op = typeof body.op === "string" ? body.op : "";
  if (!app) return bad("Missing service name.");
  if (!op) return bad("Missing op.");

  // AuthZ: only browse containers belonging to one of the current user's Dokploy
  // services. knownAppNames also revalidates the session (fail closed).
  let allowed: Set<string>;
  try {
    allowed = await knownAppNames();
  } catch (e) {
    // A rejected session throws NEXT_REDIRECT (-> /login); let it propagate
    // instead of masking it as a 503, exactly like the logs/metrics routes.
    unstable_rethrow(e);
    return bad("Workspace unavailable.", 503);
  }
  if (!allowed.has(app)) return bad("Unknown or unmanaged service.", 403);

  try {
    if (op === "targets") {
      const targets = await listTargets(app);
      return Response.json({ targets });
    }

    // Every other op needs a concrete target container.
    const targetKey = typeof body.target === "string" ? body.target : undefined;
    const target = await resolveTarget(app, targetKey);
    if (!target) {
      return bad("No running Postgres container found for this service.", 404);
    }

    if (op === "tables") {
      const res = await listTables(target);
      if (!res.ok) return bad(res.error, 422);
      return Response.json({ target: target.meta, schemas: res.schemas });
    }

    if (op === "rows") {
      const schema = typeof body.schema === "string" ? body.schema : "";
      const table = typeof body.table === "string" ? body.table : "";
      if (!schema || !table) return bad("Missing schema or table.");
      const res = await fetchRows(
        target,
        schema,
        table,
        typeof body.limit === "number" ? body.limit : 50,
        typeof body.offset === "number" ? body.offset : 0,
      );
      if (!res.ok) return bad(res.error, 422);
      return Response.json(res.page);
    }

    if (op === "query") {
      const sql = typeof body.sql === "string" ? body.sql : "";
      const allowWrites = body.allowWrites === true;
      const res = await runUserQuery(target, sql, allowWrites);
      if (!res.ok) {
        // 403 when the read-only guard rejected a write; 422 for a SQL error.
        return Response.json(
          { error: res.error, readonlyRejected: res.readonlyRejected ?? false },
          { status: res.readonlyRejected ? 403 : 422 },
        );
      }
      return Response.json({
        columns: res.grid?.columns ?? [],
        rows: res.grid?.rows ?? [],
        rowCount: res.rowCount ?? 0,
        ms: res.ms ?? 0,
        messages: res.messages,
        truncated: res.truncated ?? false,
      });
    }

    return bad(`Unknown op "${op}".`);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return bad(message, 500);
  }
}
