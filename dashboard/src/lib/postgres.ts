/**
 * Server-only helpers for the dashboard's built-in Postgres data browser
 * (the service drawer's "Data" tab).
 *
 * Everything here runs read-only SQL against a service's own Postgres by
 * docker-exec'ing `psql` inside the target container (see lib/docker.ts). There
 * is no external Postgres connection and the user is never asked for
 * credentials: we connect over the container's local socket as its own
 * POSTGRES_USER / POSTGRES_DB, which the postgres image trusts by default.
 *
 * The read-only guarantee is enforced HERE, server-side (classifyStatement),
 * independently of the client's `allowWrites` flag — the flag can only *relax*
 * the guard, never bypass validation.
 */
import "server-only";
import {
  inspectPgIdentity,
  listPgContainers,
  runPsqlCsv,
  type PgIdentity,
  type PsqlResult,
} from "@/lib/docker";

/**
 * Marker psql prints for SQL NULL (`-P null=`). Wrapped in SOH control bytes so
 * it cannot collide with real text: psql emits it unquoted, and no ordinary
 * column value equals `NULL`. Lets the CSV parser map NULL -> null
 * while a genuine empty string stays "".
 */
const NULL_MARKER = "NULL";

/** A Postgres target the Data tab can browse (one container). */
export interface PgTarget {
  key: string;
  name: string;
  image: string;
  user: string;
  db: string;
}

/** A resolved target plus the fields runPsqlCsv needs (server-side only). */
interface ResolvedTarget {
  id: string;
  identity: PgIdentity;
  meta: PgTarget;
}

/**
 * Resolve the Postgres containers backing a service `appName` into targets,
 * enriched with the connection identity (user/db) read from each container's
 * env. `appName` MUST already be validated against the user's known services.
 */
export async function listTargets(appName: string): Promise<PgTarget[]> {
  const containers = await listPgContainers(appName);
  return Promise.all(
    containers.map(async (c) => {
      const identity = await inspectPgIdentity(c.id);
      return {
        key: c.key,
        name: c.name,
        image: c.image,
        user: identity.user,
        db: identity.db,
      } satisfies PgTarget;
    }),
  );
}

/**
 * Pick one target for a request. When `key` is given, match it; otherwise (or
 * when a stale key no longer matches, e.g. after a redeploy) fall back to the
 * sole target if there is exactly one. Returns null when nothing matches.
 */
export async function resolveTarget(
  appName: string,
  key?: string,
): Promise<ResolvedTarget | null> {
  const containers = await listPgContainers(appName);
  if (containers.length === 0) return null;
  const chosen =
    (key ? containers.find((c) => c.key === key) : undefined) ??
    (containers.length === 1 ? containers[0] : undefined);
  if (!chosen) return null;
  const identity = await inspectPgIdentity(chosen.id);
  return {
    id: chosen.id,
    identity,
    meta: {
      key: chosen.key,
      name: chosen.name,
      image: chosen.image,
      user: identity.user,
      db: identity.db,
    },
  };
}

// --- CSV parsing ------------------------------------------------------------

/** A parsed result grid. Cells are strings, or null for SQL NULL. */
export interface Grid {
  columns: string[];
  rows: (string | null)[][];
}

/**
 * Parse psql `--csv` output (RFC 4180: fields quoted only when they contain a
 * comma / quote / newline, embedded quotes doubled, newlines preserved inside
 * quotes). A field that was emitted UNQUOTED and equals NULL_MARKER is SQL NULL;
 * every quoted field, and any other unquoted text, is a literal string. The
 * first record is the header row.
 */
export function parseCsv(text: string): Grid {
  const records: (string | null)[][] = [];
  let record: (string | null)[] = [];
  let field = "";
  let inQuotes = false;
  let quotedField = false; // did the current field contain a quoted section?
  let started = false; // have we seen any char of the current record?

  const endField = () => {
    const isNull = !quotedField && field === NULL_MARKER;
    record.push(isNull ? null : field);
    field = "";
    quotedField = false;
  };
  const endRecord = () => {
    endField();
    records.push(record);
    record = [];
    started = false;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    started = true;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      quotedField = true;
    } else if (ch === ",") {
      endField();
    } else if (ch === "\n") {
      endRecord();
    } else if (ch === "\r") {
      // ignore — CRLF line endings
    } else {
      field += ch;
    }
  }
  // Flush a trailing record that had no final newline.
  if (started || field.length > 0 || record.length > 0) endRecord();

  const header = records.shift() ?? [];
  const columns = header.map((c) => (c === null ? "" : c));
  return { columns, rows: records };
}

// --- command-tag detection ---------------------------------------------------

/**
 * Leading keywords of psql command tags — the status line psql prints on stdout
 * for a statement that returns NO row set (`UPDATE 1`, `INSERT 0 1`,
 * `CREATE TABLE`, `DROP TABLE`, …). Deliberately excludes the tuple-returning
 * leaders (SELECT/SHOW/EXPLAIN/TABLE/VALUES/WITH) so a real result set is never
 * mistaken for a status line.
 */
const COMMAND_TAG_LEADERS =
  "INSERT|UPDATE|DELETE|MERGE|MOVE|FETCH|COPY|CREATE|DROP|ALTER|TRUNCATE|" +
  "GRANT|REVOKE|COMMENT|SECURITY|BEGIN|COMMIT|ROLLBACK|START|SAVEPOINT|" +
  "RELEASE|SET|RESET|DISCARD|DO|CALL|VACUUM|ANALYZE|CLUSTER|REINDEX|REFRESH|" +
  "LOCK|LISTEN|UNLISTEN|NOTIFY|LOAD|CHECKPOINT|DECLARE|CLOSE|PREPARE|" +
  "EXECUTE|DEALLOCATE|IMPORT";
/** A whole cell that is a command tag: a leader, optional further UPPER words
 *  (`CREATE TABLE`, `REFRESH MATERIALIZED VIEW`), optional trailing counts. */
const COMMAND_TAG_RE = new RegExp(`^(?:${COMMAND_TAG_LEADERS})(?: [A-Z]+)*(?: \\d+)*$`);

function isCommandTag(cell: string | null): boolean {
  return cell !== null && COMMAND_TAG_RE.test(cell);
}

/**
 * True when a parsed grid is really psql command tags (a write with no
 * RETURNING, or a batch of DDL/DML in "Allow writes" mode) rather than a query
 * result. In `--csv` mode those tags arrive on the same stream as result data,
 * so `parseCsv` turns them into a degenerate one-column grid whose header and
 * every cell is a command tag — the shape this detects.
 */
function isCommandTagGrid(grid: Grid): boolean {
  if (grid.columns.length !== 1 || !isCommandTag(grid.columns[0])) return false;
  return grid.rows.every((r) => r.length === 1 && isCommandTag(r[0]));
}

/** A command-tag grid's tags in order (header first, then each row's cell). */
function commandTags(grid: Grid): string[] {
  return [grid.columns[0], ...grid.rows.map((r) => r[0] ?? "")].filter(Boolean);
}

// --- read-only statement classification -------------------------------------

const READ_ONLY_LEADERS = new Set(["SELECT", "WITH", "SHOW", "EXPLAIN", "TABLE", "VALUES"]);

export interface Classification {
  ok: boolean;
  /** Leading keyword we detected (upper-cased), for messages. */
  leader: string;
  reason?: string;
}

/**
 * Decide whether `sql` is a read-only statement that may run without the user
 * arming "Allow writes". This is the server-side guard the route enforces
 * regardless of the client's flag.
 *
 * Strategy: analyse a copy with comments and string/dollar-quoted literals
 * blanked out (so a `;` or the word "update" inside a literal never trips the
 * checks), then require: a single statement, a read-only leading keyword, and —
 * for `WITH` / `EXPLAIN ANALYZE`, which can wrap a writing statement — no
 * data-modifying keyword anywhere in the (literal-stripped) text.
 */
export function classifyStatement(sql: string): Classification {
  // Strip comments and literals for ANALYSIS only (the executed SQL is untouched).
  const analysis = sql
    .replace(/\/\*[\s\S]*?\*\//g, " ") // block comments
    .replace(/--[^\n]*/g, " ") // line comments
    .replace(/'(?:[^']|'')*'/g, "''") // single-quoted strings
    .replace(/\$([A-Za-z0-9_]*)\$[\s\S]*?\$\1\$/g, "''") // dollar-quoted strings
    .trim();

  if (!analysis) return { ok: false, leader: "", reason: "Empty statement." };

  // psql meta-commands (\d, \copy, \!, \gexec, \o …) bypass SQL statement
  // classification and can read/write files, run shell, or execute arbitrary
  // SQL. With string/dollar literals stripped, any remaining backslash is a
  // meta-command — reject it in read-only mode.
  if (analysis.includes("\\")) {
    return {
      ok: false,
      leader: "",
      reason:
        'psql meta-commands (\\…) are not allowed in read-only mode. Enable "Allow writes" to use them.',
    };
  }

  // Allow a single trailing semicolon; reject anything that chains statements.
  const withoutTrailing = analysis.replace(/;\s*$/, "");
  if (withoutTrailing.includes(";")) {
    return {
      ok: false,
      leader: "",
      reason: "Multiple statements are not allowed in read-only mode. Run one statement at a time.",
    };
  }

  const m = withoutTrailing.replace(/^[(\s]+/, "").match(/^([A-Za-z]+)/);
  const leader = m ? m[1].toUpperCase() : "";
  if (!READ_ONLY_LEADERS.has(leader)) {
    return {
      ok: false,
      leader,
      reason: `Only read-only statements (SELECT, WITH … SELECT, SHOW, EXPLAIN, TABLE, VALUES) run unless you enable "Allow writes"${
        leader ? ` — this is a ${leader} statement.` : "."
      }`,
    };
  }

  const writes = /\b(INSERT|UPDATE|DELETE|MERGE|CREATE|DROP|ALTER|TRUNCATE|GRANT|REVOKE|COPY)\b/i;
  if (leader === "WITH" && writes.test(withoutTrailing)) {
    return {
      ok: false,
      leader,
      reason: 'This WITH query contains a data-modifying statement. Enable "Allow writes" to run it.',
    };
  }
  if (leader === "EXPLAIN" && /\bANALYZE\b/i.test(withoutTrailing) && writes.test(withoutTrailing)) {
    return {
      ok: false,
      leader,
      reason: 'EXPLAIN ANALYZE on a writing statement executes it. Enable "Allow writes" to run it.',
    };
  }
  return { ok: true, leader };
}

// --- identifier quoting ------------------------------------------------------

/** Quote a Postgres identifier: wrap in double quotes, double any inside. This
 *  fully neutralises injection for catalog-sourced schema/table names. */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

// --- high-level operations ---------------------------------------------------

export interface RunResult {
  ok: boolean;
  grid?: Grid;
  /** Rows returned (data rows in the grid). */
  rowCount?: number;
  /** Server-measured execution time in ms. */
  ms?: number;
  /** psql stderr / notices (surfaced for writes and non-SELECT output). */
  messages?: string;
  truncated?: boolean;
  error?: string;
}

/** Run one already-classified SQL statement against a resolved target. */
export async function runSql(target: ResolvedTarget, sql: string): Promise<RunResult> {
  const started = Date.now();
  const res: PsqlResult | null = await runPsqlCsv(
    { id: target.id, identity: target.identity },
    sql,
    { nullMarker: NULL_MARKER },
  );
  const ms = Date.now() - started;
  if (!res) return { ok: false, error: "The Postgres container is no longer running." };

  if (res.exitCode === null) {
    // Never exited cleanly — the statement didn't complete within the timeout
    // (e.g. unbalanced quotes so psql's `\q` was swallowed).
    return {
      ok: false,
      ms,
      truncated: res.truncated,
      error:
        res.stderr.trim() ||
        "Query did not complete — check for an unterminated string or quote.",
    };
  }
  if (res.exitCode !== 0) {
    // psql exited non-zero (ON_ERROR_STOP): surface the error text.
    return {
      ok: false,
      ms,
      error: (res.stderr || res.stdout || "Query failed.").trim(),
    };
  }

  const grid = parseCsv(res.stdout);
  return {
    ok: true,
    grid,
    rowCount: grid.rows.length,
    ms,
    messages: res.stderr.trim() || undefined,
    truncated: res.truncated,
  };
}

export interface TableInfo {
  name: string;
  /** r=table, p=partitioned, v=view, m=matview, f=foreign. */
  kind: string;
  /** Approximate row count (pg_class.reltuples); null when never analysed. */
  approxRows: number | null;
}
export interface SchemaInfo {
  schema: string;
  tables: TableInfo[];
}

/**
 * List user schemas -> tables/views with approximate row counts, from the
 * catalog (no COUNT(*), so it stays cheap on large tables). Fixed SQL — no user
 * input is interpolated.
 */
export async function listTables(target: ResolvedTarget): Promise<
  { ok: true; schemas: SchemaInfo[] } | { ok: false; error: string }
> {
  const sql = `
    SELECT n.nspname AS schema,
           c.relname AS name,
           c.relkind AS kind,
           CASE WHEN c.relkind IN ('r','p','m') THEN c.reltuples::bigint ELSE NULL END AS approx_rows
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r','p','v','m','f')
      AND n.nspname NOT IN ('pg_catalog','information_schema')
      AND n.nspname NOT LIKE 'pg_toast%'
      AND n.nspname NOT LIKE 'pg_temp%'
    ORDER BY n.nspname, c.relname;`;
  const res = await runSql(target, sql);
  if (!res.ok || !res.grid) return { ok: false, error: res.error ?? "Failed to list tables." };

  const bySchema = new Map<string, TableInfo[]>();
  for (const row of res.grid.rows) {
    const [schema, name, kind, approx] = row;
    if (schema === null || name === null) continue;
    const list = bySchema.get(schema) ?? [];
    const n = approx === null || approx === "" ? null : Number(approx);
    list.push({ name, kind: kind ?? "r", approxRows: n === null || Number.isNaN(n) ? null : n });
    bySchema.set(schema, list);
  }
  const schemas = [...bySchema.entries()].map(([schema, tables]) => ({ schema, tables }));
  return { ok: true, schemas };
}

export interface RowsPage {
  columns: string[];
  rows: (string | null)[][];
  limit: number;
  offset: number;
  /** True when a full page came back, i.e. there may be more rows after this. */
  hasMore: boolean;
  ms: number;
}

/**
 * Fetch one page of a table's rows (LIMIT/OFFSET). schema/table come from the
 * catalog-backed sidebar and are double-quoted, so they cannot break out of the
 * identifier position. limit/offset are clamped integers.
 */
export async function fetchRows(
  target: ResolvedTarget,
  schema: string,
  table: string,
  limit: number,
  offset: number,
): Promise<{ ok: true; page: RowsPage } | { ok: false; error: string }> {
  const lim = Math.min(Math.max(1, Math.floor(limit) || 50), 200);
  const off = Math.max(0, Math.floor(offset) || 0);
  // No ORDER BY: universal across tables/views/foreign tables, and page-local
  // sorting is done client-side. We fetch one extra row to detect "has more"
  // without a COUNT(*).
  const sql = `SELECT * FROM ${quoteIdent(schema)}.${quoteIdent(table)} LIMIT ${lim + 1} OFFSET ${off};`;
  const res = await runSql(target, sql);
  if (!res.ok || !res.grid) return { ok: false, error: res.error ?? "Failed to read rows." };

  const all = res.grid.rows;
  const hasMore = all.length > lim;
  return {
    ok: true,
    page: {
      columns: res.grid.columns,
      rows: hasMore ? all.slice(0, lim) : all,
      limit: lim,
      offset: off,
      hasMore,
      ms: res.ms ?? 0,
    },
  };
}

/**
 * Run free-form SQL from the editor. Read-only by default: the statement is
 * classified server-side and rejected unless it is read-only OR `allowWrites`
 * is explicitly true. The client's flag can only relax the guard.
 */
export async function runUserQuery(
  target: ResolvedTarget,
  sql: string,
  allowWrites: boolean,
): Promise<RunResult & { readonlyRejected?: boolean; leader?: string }> {
  const trimmed = sql.trim();
  if (!trimmed) return { ok: false, error: "Enter a SQL statement to run." };

  if (!allowWrites) {
    const cls = classifyStatement(trimmed);
    if (!cls.ok) {
      return { ok: false, readonlyRejected: true, leader: cls.leader, error: cls.reason };
    }
  }

  const res = await runSql(target, trimmed);
  // A statement with no row set (writes/DDL) comes back as psql command tags in a
  // degenerate one-column grid. Surface those as a status message with an empty
  // grid so the client shows them in the status area, not as a table.
  if (res.ok && res.grid && isCommandTagGrid(res.grid)) {
    const status = commandTags(res.grid).join("\n");
    return {
      ...res,
      grid: { columns: [], rows: [] },
      rowCount: 0,
      messages: [status, res.messages].filter(Boolean).join("\n\n") || undefined,
    };
  }
  return res;
}
