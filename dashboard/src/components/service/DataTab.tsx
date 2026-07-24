"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useTransition,
  type KeyboardEvent,
} from "react";
import {
  Loader2,
  Table2,
  Play,
  RefreshCw,
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Database as DatabaseIcon,
  Eye,
  Columns3,
} from "lucide-react";
import type { Service } from "@/lib/dokploy";
import { inputCls } from "@/components/service/primitives";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 50;

interface PgTarget {
  key: string;
  name: string;
  image: string;
  user: string;
  db: string;
}
interface TableInfo {
  name: string;
  kind: string;
  approxRows: number | null;
}
interface SchemaInfo {
  schema: string;
  tables: TableInfo[];
}
interface Grid {
  columns: string[];
  rows: (string | null)[][];
}
interface RowsPage extends Grid {
  limit: number;
  offset: number;
  hasMore: boolean;
  ms: number;
}
interface QueryResult extends Grid {
  rowCount: number;
  ms: number;
  messages?: string;
  truncated: boolean;
}

/** POST to the Data-tab backend. Throws with the server's error message on non-2xx. */
async function api<T>(body: Record<string, unknown>): Promise<T> {
  const res = await fetch("/api/services/postgres", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

/**
 * The service drawer's "Data" tab: a read-only-by-default Postgres browser.
 * Lists schemas/tables, pages through rows, and runs free-form SQL — all by
 * docker-exec'ing psql inside the service's own container (server-side). Shown
 * only for Postgres services (a postgres database, or a compose stack with a
 * postgres container). All write protection is enforced server-side; the
 * "Allow writes" toggle only relaxes the guard and resets when the tab closes.
 */
export function DataTab({ service }: { service: Service }) {
  const app = service.appName;
  const [mode, setMode] = useState<"browse" | "sql">("browse");

  const [targets, setTargets] = useState<PgTarget[] | null>(null);
  const [targetKey, setTargetKey] = useState<string | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, startLoad] = useTransition();

  const loadTargets = useCallback(() => {
    startLoad(async () => {
      try {
        const { targets } = await api<{ targets: PgTarget[] }>({ app, op: "targets" });
        setTargets(targets);
        setTargetKey((k) => k ?? targets[0]?.key);
        setLoadError(null);
      } catch (e) {
        setLoadError(e instanceof Error ? e.message : String(e));
      }
    });
  }, [app]);

  useEffect(() => loadTargets(), [loadTargets]);

  const target = targets?.find((t) => t.key === targetKey) ?? targets?.[0];

  // Loading until the first fetch settles (targets stays null pre-fetch).
  if (loading || (targets === null && loadError === null)) {
    return (
      <div className="flex items-center gap-2 text-xs text-[var(--color-fg-subtle)]">
        <Loader2 className="size-4 animate-spin" /> Connecting to Postgres…
      </div>
    );
  }
  if (loadError) {
    return (
      <div className="space-y-3">
        <p role="alert" className="text-xs text-[var(--color-danger)]">
          {loadError}
        </p>
        <RetryButton onClick={loadTargets} />
      </div>
    );
  }
  if (!targets || targets.length === 0 || !target) {
    return (
      <div className="space-y-3">
        <EmptyState
          icon={<DatabaseIcon className="size-5" />}
          title="No running Postgres container"
          body="Deploy this service and make sure its Postgres container is running, then reopen this tab."
        />
        <RetryButton onClick={loadTargets} />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {targets.length > 1 ? (
            <select
              aria-label="Postgres container"
              value={target.key}
              onChange={(e) => setTargetKey(e.target.value)}
              className={cn(inputCls, "h-8 w-auto py-1 text-xs")}
            >
              {targets.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.db} · {t.name}
                </option>
              ))}
            </select>
          ) : (
            <div className="flex min-w-0 items-center gap-1.5 text-xs text-[var(--color-fg-muted)]">
              <DatabaseIcon className="size-3.5 shrink-0 text-[var(--color-brand)]" />
              <span className="truncate font-mono" title={`${target.db} as ${target.user} · ${target.image}`}>
                {target.db}
              </span>
              <span className="text-[var(--color-fg-subtle)]">as {target.user}</span>
            </div>
          )}
        </div>
        <ModeToggle mode={mode} onChange={setMode} />
      </div>

      {mode === "browse" ? (
        <BrowseView app={app} targetKey={target.key} />
      ) : (
        <SqlView app={app} targetKey={target.key} />
      )}
    </div>
  );
}

function ModeToggle({
  mode,
  onChange,
}: {
  mode: "browse" | "sql";
  onChange: (m: "browse" | "sql") => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Data view"
      className="flex shrink-0 rounded-lg border border-[var(--color-border-strong)] p-0.5 text-xs"
    >
      {(["browse", "sql"] as const).map((m) => (
        <button
          key={m}
          type="button"
          role="tab"
          aria-selected={mode === m}
          onClick={() => onChange(m)}
          className={cn(
            "rounded-md px-2.5 py-1 font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand)]/50",
            mode === m
              ? "bg-[var(--color-brand-strong)] text-white"
              : "text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
          )}
        >
          {m === "browse" ? "Browse" : "SQL"}
        </button>
      ))}
    </div>
  );
}

// --- Browse view ------------------------------------------------------------

function BrowseView({ app, targetKey }: { app: string; targetKey: string }) {
  const [schemas, setSchemas] = useState<SchemaInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, startLoad] = useTransition();
  const [selected, setSelected] = useState<{ schema: string; table: string } | null>(null);

  const load = useCallback(() => {
    startLoad(async () => {
      try {
        const { schemas } = await api<{ schemas: SchemaInfo[] }>({ app, op: "tables", target: targetKey });
        setSchemas(schemas);
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    });
  }, [app, targetKey]);

  useEffect(() => load(), [load]);
  const busy = loading || (schemas === null && error === null);

  return (
    <div className="flex min-h-0 flex-1 gap-3">
      <aside className="flex w-44 shrink-0 flex-col overflow-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
        {busy ? (
          <div className="flex items-center gap-1.5 p-3 text-[11px] text-[var(--color-fg-subtle)]">
            <Loader2 className="size-3.5 animate-spin" /> loading…
          </div>
        ) : error ? (
          <div className="p-3">
            <p role="alert" className="text-[11px] text-[var(--color-danger)]">
              {error}
            </p>
          </div>
        ) : !schemas || schemas.length === 0 ? (
          <p className="p-3 text-[11px] text-[var(--color-fg-subtle)]">No tables found.</p>
        ) : (
          <nav aria-label="Tables" className="p-1.5">
            {schemas.map((s) => (
              <div key={s.schema} className="mb-1.5">
                <div className="px-1.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-fg-subtle)]">
                  {s.schema}
                </div>
                {s.tables.map((t) => {
                  const active = selected?.schema === s.schema && selected?.table === t.name;
                  return (
                    <button
                      key={t.name}
                      type="button"
                      aria-current={active}
                      onClick={() => setSelected({ schema: s.schema, table: t.name })}
                      title={`${s.schema}.${t.name}${
                        t.approxRows != null && t.approxRows >= 0 ? ` · ≈${t.approxRows} rows` : ""
                      }`}
                      className={cn(
                        "flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand)]/50",
                        active
                          ? "bg-[var(--color-brand-soft)] text-[var(--color-fg)]"
                          : "text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)]"
                      )}
                    >
                      {t.kind === "v" || t.kind === "m" ? (
                        <Eye className="size-3 shrink-0 text-[var(--color-fg-subtle)]" />
                      ) : (
                        <Table2 className="size-3 shrink-0 text-[var(--color-fg-subtle)]" />
                      )}
                      <span className="truncate">{t.name}</span>
                      {t.approxRows != null && t.approxRows >= 0 && (
                        <span className="ml-auto shrink-0 text-[9px] text-[var(--color-fg-subtle)]">
                          {approxLabel(t.approxRows)}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            ))}
          </nav>
        )}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {selected ? (
          <TableRows app={app} targetKey={targetKey} schema={selected.schema} table={selected.table} />
        ) : (
          <EmptyState
            icon={<Columns3 className="size-5" />}
            title="Select a table"
            body="Pick a table on the left to page through its rows."
          />
        )}
      </div>
    </div>
  );
}

function TableRows({
  app,
  targetKey,
  schema,
  table,
}: {
  app: string;
  targetKey: string;
  schema: string;
  table: string;
}) {
  const [page, setPage] = useState<RowsPage | null>(null);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, startLoad] = useTransition();

  // Reset to the first page when the selected table changes (adjust state during
  // render — the React-recommended alternative to a resetting effect).
  const tableKey = `${schema}.${table}`;
  const [shownKey, setShownKey] = useState(tableKey);
  if (shownKey !== tableKey) {
    setShownKey(tableKey);
    setOffset(0);
    setPage(null);
  }

  useEffect(() => {
    let live = true;
    startLoad(async () => {
      try {
        const p = await api<RowsPage>({
          app,
          op: "rows",
          target: targetKey,
          schema,
          table,
          limit: PAGE_SIZE,
          offset,
        });
        if (live) {
          setPage(p);
          setError(null);
        }
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : String(e));
      }
    });
    return () => {
      live = false;
    };
  }, [app, targetKey, schema, table, offset]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="min-w-0 truncate text-xs font-medium text-[var(--color-fg)]">
          <span className="text-[var(--color-fg-subtle)]">{schema}.</span>
          {table}
        </div>
        <div className="flex shrink-0 items-center gap-1.5 text-[11px] text-[var(--color-fg-muted)]">
          {loading && <Loader2 className="size-3.5 animate-spin" />}
          <span aria-live="polite">
            {page ? `rows ${offset + 1}–${offset + page.rows.length}` : "—"}
          </span>
          <button
            type="button"
            onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
            disabled={loading || offset === 0}
            aria-label="Previous page"
            className="rounded-md border border-[var(--color-border-strong)] p-1 hover:bg-[var(--color-surface-hover)] disabled:opacity-40"
          >
            <ChevronLeft className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setOffset((o) => o + PAGE_SIZE)}
            disabled={loading || !page?.hasMore}
            aria-label="Next page"
            className="rounded-md border border-[var(--color-border-strong)] p-1 hover:bg-[var(--color-surface-hover)] disabled:opacity-40"
          >
            <ChevronRight className="size-3.5" />
          </button>
        </div>
      </div>

      {error ? (
        <p role="alert" className="text-xs text-[var(--color-danger)]">
          {error}
        </p>
      ) : page && page.rows.length === 0 ? (
        <p className="text-xs text-[var(--color-fg-subtle)]">No rows on this page.</p>
      ) : page ? (
        <ResultGrid columns={page.columns} rows={page.rows} />
      ) : null}
    </div>
  );
}

// --- SQL view ---------------------------------------------------------------

function SqlView({ app, targetKey }: { app: string; targetKey: string }) {
  const [sql, setSql] = useState("");
  const [allowWrites, setAllowWrites] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<{ message: string; readonly: boolean } | null>(null);

  const run = useCallback(() => {
    const trimmed = sql.trim();
    if (!trimmed || running) return;
    setRunning(true);
    setError(null);
    fetch("/api/services/postgres", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app, op: "query", target: targetKey, sql: trimmed, allowWrites }),
    })
      .then(async (res) => {
        const data = (await res.json().catch(() => ({}))) as QueryResult & {
          error?: string;
          readonlyRejected?: boolean;
        };
        if (!res.ok) {
          setResult(null);
          setError({ message: data.error || `HTTP ${res.status}`, readonly: !!data.readonlyRejected });
        } else {
          setResult(data);
        }
      })
      .catch((e: unknown) =>
        setError({ message: e instanceof Error ? e.message : String(e), readonly: false })
      )
      .finally(() => setRunning(false));
  }, [app, targetKey, sql, allowWrites, running]);

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      run();
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div>
        <label htmlFor="pg-sql" className="sr-only">
          SQL query
        </label>
        <textarea
          id="pg-sql"
          value={sql}
          onChange={(e) => setSql(e.target.value)}
          onKeyDown={onKeyDown}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          placeholder="SELECT * FROM … — ⌘/Ctrl+Enter to run"
          rows={4}
          className="w-full resize-y rounded-lg border border-[var(--color-border-control)] bg-[#0b0b10] p-3 font-mono text-xs leading-relaxed text-[var(--color-fg)] outline-none focus:border-[var(--color-brand)] focus-visible:ring-2 focus-visible:ring-[var(--color-brand)]/50"
        />
      </div>

      <div className="flex items-center justify-between gap-2">
        <WritesToggle on={allowWrites} onChange={setAllowWrites} />
        <div className="flex items-center gap-2">
          {result && !error && (
            <span aria-live="polite" className="text-[11px] text-[var(--color-fg-subtle)]">
              {result.rowCount} row{result.rowCount === 1 ? "" : "s"} · {result.ms} ms
              {result.truncated && " · truncated"}
            </span>
          )}
          <button
            type="button"
            onClick={run}
            disabled={running || !sql.trim()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--color-brand-strong)] px-3 py-2 text-xs font-semibold text-white hover:bg-[var(--color-brand-deep)] disabled:opacity-40"
          >
            {running ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
            Run
          </button>
        </div>
      </div>

      {allowWrites && (
        <div className="flex items-start gap-2 rounded-lg border border-[var(--color-warn)]/40 bg-[var(--color-warn-soft)] px-3 py-2 text-[11px] text-[var(--color-warn)]">
          <AlertTriangle className="mt-px size-3.5 shrink-0" />
          <span>
            Writes are enabled. Statements that modify data or schema will run against the live
            database. This resets when you close the drawer.
          </span>
        </div>
      )}

      {error && (
        <div
          role="alert"
          className={cn(
            "rounded-lg border px-3 py-2 text-xs",
            error.readonly
              ? "border-[var(--color-warn)]/40 bg-[var(--color-warn-soft)] text-[var(--color-warn)]"
              : "border-[var(--color-danger)]/40 bg-[var(--color-danger-soft)] text-[var(--color-danger)]"
          )}
        >
          <pre className="whitespace-pre-wrap break-words font-mono">{error.message}</pre>
        </div>
      )}

      {result && !error && (
        <div className="flex min-h-0 flex-1 flex-col">
          {result.columns.length === 0 ? (
            <pre
              aria-live="polite"
              className="whitespace-pre-wrap break-words rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 font-mono text-xs text-[var(--color-fg-muted)]"
            >
              {result.messages || "Statement executed."}
            </pre>
          ) : (
            <ResultGrid columns={result.columns} rows={result.rows} />
          )}
          {result.messages && result.columns.length > 0 && (
            <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-[10px] text-[var(--color-fg-subtle)]">
              {result.messages}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function WritesToggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className={cn(
        "inline-flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand)]/50",
        on
          ? "border-[var(--color-warn)]/50 text-[var(--color-warn)]"
          : "border-[var(--color-border-strong)] text-[var(--color-fg-muted)]"
      )}
    >
      <span
        className={cn(
          "relative h-4 w-7 rounded-full transition-colors",
          on ? "bg-[var(--color-warn)]" : "bg-[var(--color-idle)]"
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 size-3 rounded-full bg-white transition-all",
            on ? "left-3.5" : "left-0.5"
          )}
        />
      </span>
      Allow writes
    </button>
  );
}

// --- shared result grid -----------------------------------------------------

type SortState = { col: number; dir: "asc" | "desc" } | null;

/**
 * Render a columns/rows grid. SQL NULL is shown as a distinct muted pill (vs an
 * empty string, which renders blank). Clicking a column header sorts the current
 * page client-side (asc -> desc -> none). Wide grids scroll inside their own box.
 */
function ResultGrid({ columns, rows }: { columns: string[]; rows: (string | null)[][] }) {
  const [sort, setSort] = useState<SortState>(null);

  // New data (a new page or query result) clears the sort — adjust state during
  // render rather than in a resetting effect.
  const [seenRows, setSeenRows] = useState(rows);
  if (seenRows !== rows) {
    setSeenRows(rows);
    setSort(null);
  }

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const { col, dir } = sort;
    const copy = [...rows];
    copy.sort((a, b) => {
      const av = a[col];
      const bv = b[col];
      if (av === bv) return 0;
      if (av === null) return 1; // NULLs last, regardless of direction
      if (bv === null) return -1;
      const an = Number(av);
      const bn = Number(bv);
      const numeric = av !== "" && bv !== "" && !Number.isNaN(an) && !Number.isNaN(bn);
      const cmp = numeric ? an - bn : av.localeCompare(bv);
      return dir === "asc" ? cmp : -cmp;
    });
    return copy;
  }, [rows, sort]);

  const onSort = (col: number) =>
    setSort((s) =>
      s?.col === col
        ? s.dir === "asc"
          ? { col, dir: "desc" }
          : null
        : { col, dir: "asc" }
    );

  return (
    <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-[var(--color-border)] bg-[#0b0b10]">
      <table className="w-full border-collapse text-left font-mono text-[11px]">
        <thead className="sticky top-0 z-10 bg-[var(--color-bg-elevated)]">
          <tr>
            <th
              scope="col"
              className="border-b border-[var(--color-border)] px-2 py-1.5 text-[10px] font-normal text-[var(--color-fg-subtle)]"
            >
              #
            </th>
            {columns.map((c, i) => {
              const dir = sort?.col === i ? sort.dir : undefined;
              return (
                <th
                  key={i}
                  scope="col"
                  aria-sort={dir === "asc" ? "ascending" : dir === "desc" ? "descending" : "none"}
                  className="border-b border-[var(--color-border)] px-2 py-1.5"
                >
                  <button
                    type="button"
                    onClick={() => onSort(i)}
                    className="flex items-center gap-1 whitespace-nowrap font-semibold text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand)]/50"
                  >
                    {c || <span className="italic text-[var(--color-fg-subtle)]">?column?</span>}
                    <span aria-hidden className="text-[9px] text-[var(--color-fg-subtle)]">
                      {dir === "asc" ? "▲" : dir === "desc" ? "▼" : ""}
                    </span>
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row, r) => (
            <tr key={r} className="even:bg-white/[0.02] hover:bg-[var(--color-surface-hover)]">
              <td className="border-b border-[var(--color-border)]/50 px-2 py-1 text-[10px] text-[var(--color-fg-subtle)]">
                {r + 1}
              </td>
              {row.map((cell, c) => (
                <td
                  key={c}
                  className="max-w-[22rem] border-b border-[var(--color-border)]/50 px-2 py-1 align-top text-[var(--color-fg)]"
                >
                  {cell === null ? (
                    <span className="rounded bg-[var(--color-idle-soft)] px-1 text-[10px] italic text-[var(--color-fg-subtle)]">
                      NULL
                    </span>
                  ) : cell === "" ? (
                    <span className="text-[var(--color-fg-subtle)]">·</span>
                  ) : (
                    <span className="block max-w-full truncate" title={cell}>
                      {cell}
                    </span>
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// --- small shared bits ------------------------------------------------------

function EmptyState({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-[var(--color-border)] p-6 text-center">
      <div className="text-[var(--color-fg-subtle)]">{icon}</div>
      <div className="text-sm font-medium text-[var(--color-fg-muted)]">{title}</div>
      <p className="max-w-xs text-xs text-[var(--color-fg-subtle)]">{body}</p>
    </div>
  );
}

function RetryButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--color-border-strong)] px-3 py-2 text-xs font-medium text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)]"
    >
      <RefreshCw className="size-3.5" /> Retry
    </button>
  );
}

/** Compact approximate-count label, e.g. 12.3k / 4.5M. */
function approxLabel(n: number): string {
  if (n < 1000) return `≈${n}`;
  if (n < 1_000_000) return `≈${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `≈${(n / 1_000_000).toFixed(1)}M`;
}
