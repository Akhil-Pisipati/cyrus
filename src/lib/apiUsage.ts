/* ══ apiUsage.ts — pure time-series math for the API usage board ═══
   Nothing here touches the network or the clock: every function takes
   the records and a `now` it is handed. That keeps the whole feature -
   rate-limit status, hourly/daily/weekly buckets, alert thresholds and
   the downloadable report - testable with no database and no server.
   The store feeds it CallRecords; the route trims and hands them back.
   ═══════════════════════════════════════════════════════════════ */

export interface CallRecord {
  readonly endpoint: string;
  readonly status: number; // HTTP status the response carried
  readonly ms: number;     // wall-clock duration of the call
  readonly at: number;     // epoch ms the call finished
}

export type Granularity = "hour" | "day" | "week";

export interface Bucket {
  readonly start: number; // epoch ms, inclusive
  readonly end: number;   // epoch ms, exclusive
  readonly label: string;
  readonly total: number;
  readonly errors: number;
}

export interface EndpointRollup {
  readonly endpoint: string;
  readonly total: number;
  readonly errors: number;
  readonly errorRate: number;
  readonly avgMs: number;
  readonly p95Ms: number;
}

export type AlertLevel = "ok" | "warning" | "critical";

export interface RateLimitStatus {
  readonly endpoint: string;
  readonly limit: number;
  readonly used: number;
  readonly remaining: number;
  readonly pct: number;
  readonly level: AlertLevel;
  readonly resetMs: number;
}

export interface UsageReport {
  readonly generatedAt: number;
  readonly windowMs: number;
  readonly totals: { calls: number; errors: number; errorRate: number; endpoints: number };
  readonly endpoints: EndpointRollup[];
  readonly limits: RateLimitStatus[];
  readonly series: Record<Granularity, Bucket[]>;
}

export interface RateLimitOpts {
  now: number;
  limit?: number;
  windowMs?: number;
  limits?: Record<string, number>;
}

export const HOUR = 3_600_000;
export const DAY = 86_400_000;
export const WEEK = 7 * DAY;
const SPAN: Record<Granularity, number> = { hour: HOUR, day: DAY, week: WEEK };

export const DEFAULT_LIMIT = 1000;
export const DEFAULT_WINDOW_MS = 60_000;
export const WARN_RATIO = 0.7;
export const CRIT_RATIO = 0.9;

const isError = (r: CallRecord): boolean => r.status >= 400;

/** percentile of an already-sorted ascending array; empty -> 0 */
export function percentile(sortedAsc: readonly number[], q: number): number {
  if (!sortedAsc.length) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.floor(sortedAsc.length * q));
  return sortedAsc[idx];
}

/** where a consumption ratio lands against the alert thresholds */
export function classifyLevel(pct: number, warn = WARN_RATIO, crit = CRIT_RATIO): AlertLevel {
  if (pct >= crit) return "critical";
  if (pct >= warn) return "warning";
  return "ok";
}

function bucketLabel(granularity: Granularity, start: number): string {
  const d = new Date(start);
  const pad = (n: number) => String(n).padStart(2, "0");
  if (granularity === "hour") return `${pad(d.getUTCHours())}:00`;
  const md = `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  return granularity === "day" ? md : `W ${md}`;
}

/** total / error / latency rollup for each endpoint, busiest first */
export function rollupByEndpoint(records: readonly CallRecord[]): EndpointRollup[] {
  const by = new Map<string, CallRecord[]>();
  for (const r of records) {
    const list = by.get(r.endpoint);
    if (list) list.push(r);
    else by.set(r.endpoint, [r]);
  }
  const out: EndpointRollup[] = [];
  for (const [endpoint, rs] of by) {
    const total = rs.length;
    const errors = rs.reduce((n, r) => n + (isError(r) ? 1 : 0), 0);
    const lat = rs.map((r) => r.ms).sort((a, b) => a - b);
    const avg = total ? lat.reduce((a, b) => a + b, 0) / total : 0;
    out.push({
      endpoint,
      total,
      errors,
      errorRate: total ? +(errors / total).toFixed(4) : 0,
      avgMs: +avg.toFixed(2),
      p95Ms: percentile(lat, 0.95),
    });
  }
  return out.sort((a, b) => b.total - a.total || a.endpoint.localeCompare(b.endpoint));
}

/** the last `count` buckets of width SPAN[granularity] ending at `now`,
    oldest first. Empty buckets are emitted so the chart axis is stable. */
export function bucketSeries(records: readonly CallRecord[], granularity: Granularity, now: number, count = 12): Bucket[] {
  const span = SPAN[granularity];
  const start0 = now - span * count;
  type Mutable = { start: number; end: number; label: string; total: number; errors: number };
  const buckets: Mutable[] = [];
  for (let i = 0; i < count; i++) {
    const start = start0 + span * i;
    buckets.push({ start, end: start + span, label: bucketLabel(granularity, start), total: 0, errors: 0 });
  }
  for (const r of records) {
    if (r.at < start0 || r.at >= now) continue;
    const i = Math.min(count - 1, Math.max(0, Math.floor((r.at - start0) / span)));
    const b = buckets[i];
    b.total++;
    if (isError(r)) b.errors++;
  }
  return buckets;
}

/** current rate-limit consumption per endpoint over a sliding window
    ending at `now` (records exactly at the floor are excluded). */
export function rateLimits(records: readonly CallRecord[], opts: RateLimitOpts): RateLimitStatus[] {
  const { now } = opts;
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const baseLimit = opts.limit ?? DEFAULT_LIMIT;
  const floor = now - windowMs;
  const by = new Map<string, CallRecord[]>();
  for (const r of records) {
    if (r.at <= floor || r.at > now) continue;
    const list = by.get(r.endpoint);
    if (list) list.push(r);
    else by.set(r.endpoint, [r]);
  }
  const out: RateLimitStatus[] = [];
  for (const [endpoint, rs] of by) {
    const limit = opts.limits?.[endpoint] ?? baseLimit;
    const used = rs.length;
    const pct = limit > 0 ? used / limit : 1;
    const oldest = rs.reduce((m, r) => Math.min(m, r.at), Infinity);
    const resetMs = Math.max(0, oldest + windowMs - now);
    out.push({
      endpoint,
      limit,
      used,
      remaining: Math.max(0, limit - used),
      pct: +pct.toFixed(4),
      level: classifyLevel(pct),
      resetMs: Math.round(resetMs),
    });
  }
  return out.sort((a, b) => b.pct - a.pct || a.endpoint.localeCompare(b.endpoint));
}

/** only the endpoints at or past the warning threshold */
export function activeAlerts(limits: readonly RateLimitStatus[]): RateLimitStatus[] {
  return limits.filter((l) => l.level !== "ok");
}

/** everything the dashboard and the download need, in one snapshot */
export function buildReport(
  records: readonly CallRecord[],
  now: number,
  opts: { limit?: number; windowMs?: number; limits?: Record<string, number> } = {},
): UsageReport {
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const endpoints = rollupByEndpoint(records);
  const calls = records.length;
  const errors = records.reduce((n, r) => n + (isError(r) ? 1 : 0), 0);
  return {
    generatedAt: now,
    windowMs,
    totals: { calls, errors, errorRate: calls ? +(errors / calls).toFixed(4) : 0, endpoints: endpoints.length },
    endpoints,
    limits: rateLimits(records, { now, limit: opts.limit, windowMs, limits: opts.limits }),
    series: {
      hour: bucketSeries(records, "hour", now, 24),
      day: bucketSeries(records, "day", now, 14),
      week: bucketSeries(records, "week", now, 12),
    },
  };
}

function csvCell(v: unknown): string {
  const s = String(v ?? "");
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** a per-endpoint spreadsheet: one row per endpoint, joined with the
    current rate-limit reading for it. */
export function reportToCsv(report: UsageReport): string {
  const limitBy = new Map(report.limits.map((l) => [l.endpoint, l] as const));
  const rows: unknown[][] = [["endpoint", "total", "errors", "error_rate", "avg_ms", "p95_ms", "limit", "used", "level"]];
  for (const e of report.endpoints) {
    const l = limitBy.get(e.endpoint);
    rows.push([e.endpoint, e.total, e.errors, e.errorRate, e.avgMs, e.p95Ms, l?.limit ?? "", l?.used ?? "", l?.level ?? "ok"]);
  }
  return rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

export function reportToJson(report: UsageReport): string {
  return JSON.stringify(report, null, 2);
}
