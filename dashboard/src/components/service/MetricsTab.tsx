"use client";

import { useEffect, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Cpu, MemoryStick, Loader2 } from "lucide-react";

interface Sample {
  ts: number;
  cpu: number;
  memUsed: number;
  memLimit: number;
  memPct: number;
}

/** Live keeps a short dense buffer; history ranges query the durable store. */
const MAX_LIVE = 1000;
const LIVE_SEED_MS = 15 * 60_000;
const RANGES = [
  { id: "live", label: "Live", ms: 0 },
  { id: "15m", label: "15m", ms: 15 * 60_000 },
  { id: "1h", label: "1h", ms: 60 * 60_000 },
  { id: "6h", label: "6h", ms: 6 * 60 * 60_000 },
  { id: "24h", label: "24h", ms: 24 * 60 * 60_000 },
] as const;
type RangeId = (typeof RANGES)[number]["id"];

const fmtMB = (b: number) => `${Math.round(b / 1024 / 1024)} MB`;

async function fetchHistory(
  appName: string,
  windowMs: number,
  signal: AbortSignal,
): Promise<{ enabled: boolean; samples: Sample[] }> {
  const since = Date.now() - windowMs;
  const res = await fetch(
    `/api/services/metrics/history?app=${encodeURIComponent(appName)}&since=${since}`,
    { signal, cache: "no-store" },
  );
  if (!res.ok) return { enabled: false, samples: [] };
  return (await res.json()) as { enabled: boolean; samples: Sample[] };
}

export function MetricsTab({ appName, active }: { appName: string; active: boolean }) {
  const [data, setData] = useState<Sample[]>([]);
  const [idle, setIdle] = useState(false);
  // The live stats stream couldn't be attached (Docker error) — distinct from
  // idle (container simply not running).
  const [unavailable, setUnavailable] = useState(false);
  const [range, setRange] = useState<RangeId>("live");
  // null = unknown (still probing); false = no durable store configured.
  const [storeOn, setStoreOn] = useState<boolean | null>(null);

  // Reset the live buffer when the series identity (service or range) changes.
  // Done during render, not in the effect below: calling setState synchronously
  // inside an effect body triggers a cascading re-render
  // (react-hooks/set-state-in-effect) and briefly flashes the previous series'
  // samples. Adjusting state during render on a changed key is the supported
  // React pattern for this.
  const seriesKey = `${appName}|${range}`;
  const [prevKey, setPrevKey] = useState(seriesKey);
  if (seriesKey !== prevKey) {
    setPrevKey(seriesKey);
    setData([]);
    setIdle(false);
    setUnavailable(false);
  }

  useEffect(() => {
    if (!active || !appName) return;
    const ac = new AbortController();
    let es: EventSource | null = null;

    const window = range === "live" ? LIVE_SEED_MS : RANGES.find((r) => r.id === range)!.ms;

    // Seed from the durable store (history survives tab close), then, in Live
    // mode, append the live SSE on top.
    fetchHistory(appName, window, ac.signal)
      .then(({ enabled, samples }) => {
        setStoreOn(enabled);
        setData(samples);
      })
      .catch(() => setStoreOn(false));

    if (range === "live") {
      es = new EventSource(`/api/services/metrics?app=${encodeURIComponent(appName)}`);
      es.addEventListener("idle", () => setIdle(true));
      es.addEventListener("unavailable", () => setUnavailable(true));
      es.onmessage = (e) => {
        try {
          const s = JSON.parse(e.data) as Sample;
          if (!s || typeof s.cpu !== "number") return;
          setData((prev) => [...prev, s].slice(-MAX_LIVE));
        } catch {
          /* ignore */
        }
      };
    }

    return () => {
      ac.abort();
      es?.close();
    };
  }, [appName, active, range]);

  const last = data[data.length - 1];
  const historyEmpty = range !== "live" && data.length === 0;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex rounded-lg border border-[var(--color-border)] p-0.5">
          {RANGES.map((r) => (
            <button
              key={r.id}
              onClick={() => setRange(r.id)}
              disabled={r.id !== "live" && storeOn === false}
              aria-pressed={range === r.id}
              title={r.id !== "live" && storeOn === false ? "Metrics history is off" : undefined}
              className={
                "rounded-md px-2.5 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 " +
                (range === r.id
                  ? "bg-[var(--color-surface)] text-[var(--color-fg)]"
                  : "text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]")
              }
            >
              {r.label}
            </button>
          ))}
        </div>
        {range === "live" && storeOn === false && (
          <span
            className="cursor-help text-[10px] text-[var(--color-fg-subtle)] underline decoration-dotted underline-offset-2"
            title="Metric history isn't being recorded. It needs the Switchyard metrics store — re-run `switchyard up` (the store is on by default), or set SWITCHYARD_STORE_URL when running the dashboard from source."
          >
            history off
          </span>
        )}
      </div>

      {!((idle || unavailable) && range === "live") && (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Stat
              icon={<Cpu className="size-4" />}
              label="CPU"
              value={last ? `${last.cpu.toFixed(1)}%` : "—"}
              accent="#a06bff"
            />
            <Stat
              icon={<MemoryStick className="size-4" />}
              label="Memory"
              value={last ? fmtMB(last.memUsed) : "—"}
              sub={last && last.memLimit ? `of ${fmtMB(last.memLimit)}` : undefined}
              accent="#3ecf8e"
            />
          </div>

          <Chart title="CPU %" data={data} dataKey="cpu" color="#a06bff" unit="%" />
          <Chart title="Memory" data={data} dataKey="memUsed" color="#3ecf8e" formatter={fmtMB} />
        </>
      )}

      {/* Single stable live region: status messages render inside it so they're announced. */}
      <div aria-live="polite" className="empty:hidden">
        {idle && range === "live" ? (
          <div className="flex h-40 items-center justify-center text-sm text-[var(--color-fg-subtle)]">
            No metrics — the service isn&apos;t running.
          </div>
        ) : unavailable && range === "live" ? (
          <div className="flex h-40 items-center justify-center text-sm text-[var(--color-fg-subtle)]">
            Metrics unavailable — couldn&apos;t read container stats from Docker.
          </div>
        ) : (
          <>
            {historyEmpty && (
              <div className="flex items-center justify-center text-xs text-[var(--color-fg-subtle)]">
                {storeOn === false
                  ? "Metric history needs the Switchyard store. Re-run `switchyard up` (the store is on by default), or set SWITCHYARD_STORE_URL to record history."
                  : "No metrics recorded in this range yet."}
              </div>
            )}
            {range === "live" && data.length === 0 && (
              <div className="flex items-center justify-center gap-2 text-xs text-[var(--color-fg-subtle)]">
                <Loader2 className="size-4 animate-spin" /> sampling…
              </div>
            )}
          </>
        )}
      </div>

      <HttpSection appName={appName} active={active} />
    </div>
  );
}

function Stat({
  icon,
  label,
  value,
  sub,
  accent,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  sub?: string;
  accent: string;
}) {
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
      <div className="flex items-center gap-1.5 text-xs text-[var(--color-fg-muted)]" style={{ color: accent }}>
        {icon}
        <span>{label}</span>
      </div>
      <div className="mt-1 text-lg font-semibold tabular-nums">{value}</div>
      {sub && <div className="text-xs text-[var(--color-fg-subtle)]">{sub}</div>}
    </div>
  );
}

function Chart({
  title,
  data,
  dataKey,
  color,
  unit,
  formatter,
}: {
  title: string;
  data: Sample[];
  dataKey: "cpu" | "memUsed";
  color: string;
  unit?: string;
  formatter?: (n: number) => string;
}) {
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
      <div className="mb-2 text-xs font-medium text-[var(--color-fg-muted)]">{title}</div>
      <div className="h-28" role="img" aria-label={`${title} chart`}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id={`g-${dataKey}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity={0.35} />
                <stop offset="100%" stopColor={color} stopOpacity={0} />
              </linearGradient>
            </defs>
            <XAxis dataKey="ts" hide />
            <YAxis hide domain={[0, "auto"]} />
            <Tooltip
              contentStyle={{
                background: "#12121a",
                border: "1px solid #34344a",
                borderRadius: 8,
                fontSize: 11,
              }}
              labelFormatter={(ts) => new Date(ts as number).toLocaleTimeString()}
              formatter={(value) => {
                const v = Number(value);
                return [formatter ? formatter(v) : `${v}${unit ?? ""}`, title];
              }}
            />
            <Area
              type="monotone"
              dataKey={dataKey}
              stroke={color}
              strokeWidth={2}
              fill={`url(#g-${dataKey})`}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
// --- HTTP (Traefik) metrics -------------------------------------------------

const TOOLTIP_STYLE = {
  background: "#12121a",
  border: "1px solid #34344a",
  borderRadius: 8,
  fontSize: 11,
} as const;

// Railway-like status/traffic palette.
const C2XX = "#4a9eff"; // blue
const C3XX = "#a06bff"; // purple
const C4XX = "#f5a623"; // yellow
const C5XX = "#ff5c5c"; // red
const INGRESS = "#4a9eff"; // blue
const EGRESS = "#f5a623"; // yellow

interface HttpPoint {
  ts: number;
  ingress: number;
  egress: number;
  c2xx: number;
  c3xx: number;
  c4xx: number;
  c5xx: number;
  total: number;
  errorRate: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
}

const HTTP_RANGES = [
  { label: "15m", min: 15 },
  { label: "1h", min: 60 },
  { label: "6h", min: 360 },
  { label: "24h", min: 1440 },
] as const;

const fmtBytes = (n: number): string => {
  if (!n) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
};
const fmtNum = (n: number): string =>
  n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(Math.round(n));
const fmtMs = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(2)} s` : `${Math.round(n)} ms`);
const timeLabel = (ts: number) => new Date(ts as number).toLocaleTimeString();

function HttpSection({ appName, active }: { appName: string; active: boolean }) {
  const [rangeMin, setRangeMin] = useState<number>(60);
  const [state, setState] = useState<{ available: boolean; points: HttpPoint[] } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!active || !appName) return;
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(
          `/api/services/http-metrics?app=${encodeURIComponent(appName)}&range=${rangeMin}`,
          { cache: "no-store" },
        );
        const json = (await res.json()) as { available: boolean; points: HttpPoint[] };
        if (!cancelled) setState(json);
      } catch {
        if (!cancelled) setState({ available: false, points: [] });
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    const id = setInterval(load, 20_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [appName, active, rangeMin]);

  const points = state?.points ?? [];
  const available = state?.available ?? false;

  // Range totals for the stat cards.
  const totals = points.reduce(
    (a, p) => {
      a.reqs += p.total;
      a.errs += p.c5xx;
      a.ingress += p.ingress;
      a.egress += p.egress;
      return a;
    },
    { reqs: 0, errs: 0, ingress: 0, egress: 0 },
  );
  const errorRate = totals.reqs > 0 ? (totals.errs / totals.reqs) * 100 : 0;
  const lastP95 = points.length ? points[points.length - 1].p95 : 0;

  return (
    <div className="space-y-4 border-t border-[var(--color-border)] pt-5">
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold text-[var(--color-fg)]">HTTP</div>
        <div className="flex gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-0.5">
          {HTTP_RANGES.map((r) => (
            <button
              key={r.min}
              onClick={() => setRangeMin(r.min)}
              aria-pressed={rangeMin === r.min}
              className={
                "rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors " +
                (rangeMin === r.min
                  ? "bg-[var(--color-brand-soft)] text-[var(--color-brand)]"
                  : "text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]")
              }
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {loading && !state ? (
        <div className="flex items-center justify-center gap-2 py-6 text-xs text-[var(--color-fg-subtle)]">
          <Loader2 className="size-4 animate-spin" /> loading…
        </div>
      ) : !available ? (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Stat icon={<span aria-hidden="true">↕</span>} label="Requests" value="—" accent="#4a9eff" />
            <Stat icon={<span aria-hidden="true">⚠</span>} label="Error rate" value="—" accent="#ff5c5c" />
            <Stat icon={<span aria-hidden="true">↓</span>} label="Ingress" value="—" accent={INGRESS} />
            <Stat icon={<span aria-hidden="true">↑</span>} label="Egress" value="—" accent={EGRESS} />
          </div>
          <p className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-xs text-[var(--color-fg-subtle)]">
            HTTP metrics need the Traefik metrics endpoint (TRAEFIK_METRICS_URL).
          </p>
        </>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Stat icon={<span aria-hidden="true">↕</span>} label="Requests" value={fmtNum(totals.reqs)} accent="#4a9eff" />
            <Stat
              icon={<span aria-hidden="true">⚠</span>}
              label="Error rate"
              value={
                <>
                  {`${errorRate.toFixed(errorRate >= 10 ? 0 : 1)}%`}
                  {errorRate > 1 && <span className="sr-only"> high</span>}
                </>
              }
              accent={errorRate > 1 ? "#ff5c5c" : "#3ecf8e"}
            />
            <Stat icon={<span aria-hidden="true">↓</span>} label="Ingress" value={fmtBytes(totals.ingress)} accent={INGRESS} />
            <Stat icon={<span aria-hidden="true">↑</span>} label="Egress" value={fmtBytes(totals.egress)} accent={EGRESS} />
          </div>

          {points.length === 0 ? (
            <p className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-xs text-[var(--color-fg-subtle)]">
              No HTTP traffic in this window yet.
            </p>
          ) : (
            <>
              <TrafficPanel points={points} />
              <RequestsPanel points={points} total={totals.reqs} />
              <ErrorRatePanel points={points} />
              <ResponseTimePanel points={points} lastP95={lastP95} />
            </>
          )}
        </>
      )}
    </div>
  );
}

function PanelCard({
  title,
  right,
  children,
}: {
  title: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-xs font-medium text-[var(--color-fg-muted)]">{title}</div>
        {right && <div className="text-xs tabular-nums text-[var(--color-fg-subtle)]">{right}</div>}
      </div>
      <div className="h-32" role="img" aria-label={`${title} chart`}>{children}</div>
    </div>
  );
}

function TrafficPanel({ points }: { points: HttpPoint[] }) {
  return (
    <PanelCard title="Public Network Traffic">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={points} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="g-ingress" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={INGRESS} stopOpacity={0.35} />
              <stop offset="100%" stopColor={INGRESS} stopOpacity={0} />
            </linearGradient>
            <linearGradient id="g-egress" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={EGRESS} stopOpacity={0.35} />
              <stop offset="100%" stopColor={EGRESS} stopOpacity={0} />
            </linearGradient>
          </defs>
          <XAxis dataKey="ts" hide />
          <YAxis hide domain={[0, "auto"]} />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            labelFormatter={(ts) => timeLabel(ts as number)}
            formatter={(value, name) => [fmtBytes(Number(value)), name === "ingress" ? "Ingress" : "Egress"]}
          />
          <Legend wrapperStyle={LEGEND_STYLE} iconType="plainline" />
          <Area
            type="monotone"
            name="Ingress"
            dataKey="ingress"
            stroke={INGRESS}
            strokeWidth={2}
            fill="url(#g-ingress)"
            isAnimationActive={false}
          />
          <Area
            type="monotone"
            name="Egress"
            dataKey="egress"
            stroke={EGRESS}
            strokeWidth={2}
            strokeDasharray="6 3"
            fill="url(#g-egress)"
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </PanelCard>
  );
}

function RequestsPanel({ points, total }: { points: HttpPoint[]; total: number }) {
  return (
    <PanelCard title="Requests" right={`${fmtNum(total)} total`}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={points} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
          <XAxis dataKey="ts" hide />
          <YAxis hide domain={[0, "auto"]} />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            cursor={{ fill: "#ffffff08" }}
            labelFormatter={(ts) => timeLabel(ts as number)}
            formatter={(value, name) => [fmtNum(Number(value)), String(name).toUpperCase()]}
          />
          <Legend wrapperStyle={LEGEND_STYLE} iconType="square" />
          <Bar name="2xx" dataKey="c2xx" stackId="s" fill={C2XX} isAnimationActive={false} />
          <Bar name="3xx" dataKey="c3xx" stackId="s" fill={C3XX} isAnimationActive={false} />
          <Bar name="4xx" dataKey="c4xx" stackId="s" fill={C4XX} isAnimationActive={false} />
          <Bar name="5xx" dataKey="c5xx" stackId="s" fill={C5XX} isAnimationActive={false} radius={[2, 2, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </PanelCard>
  );
}

function ErrorRatePanel({ points }: { points: HttpPoint[] }) {
  return (
    <PanelCard title="Request Error Rate">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={points} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
          <XAxis dataKey="ts" hide />
          <YAxis hide domain={[0, "auto"]} />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            labelFormatter={(ts) => timeLabel(ts as number)}
            formatter={(value) => [`${Number(value).toFixed(2)}%`, "5xx rate"]}
          />
          <Line
            type="monotone"
            dataKey="errorRate"
            stroke={C5XX}
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </PanelCard>
  );
}

function ResponseTimePanel({ points, lastP95 }: { points: HttpPoint[]; lastP95: number }) {
  return (
    <PanelCard title="Response Time" right={`p95 ${fmtMs(lastP95)}`}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={points} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
          <XAxis dataKey="ts" hide />
          <YAxis hide domain={[0, "auto"]} />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            labelFormatter={(ts) => timeLabel(ts as number)}
            formatter={(value, name) => [fmtMs(Number(value)), String(name)]}
          />
          <Legend wrapperStyle={LEGEND_STYLE} iconType="plainline" />
          <Line type="monotone" name="p50" dataKey="p50" stroke="#3ecf8e" strokeWidth={1.5} dot={false} isAnimationActive={false} />
          <Line type="monotone" name="p90" dataKey="p90" stroke="#4a9eff" strokeWidth={1.5} strokeDasharray="6 3" dot={false} isAnimationActive={false} />
          <Line type="monotone" name="p95" dataKey="p95" stroke="#f5a623" strokeWidth={1.5} strokeDasharray="3 3" dot={false} isAnimationActive={false} />
          <Line type="monotone" name="p99" dataKey="p99" stroke="#ff5c5c" strokeWidth={1.5} strokeDasharray="1 3" dot={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </PanelCard>
  );
}

const LEGEND_STYLE = { fontSize: 11, paddingTop: 4 } as const;
