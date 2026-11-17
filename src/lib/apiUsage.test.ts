import { describe, it, expect } from "vitest";
import {
  DAY, HOUR, WEEK, DEFAULT_LIMIT, DEFAULT_WINDOW_MS,
  bucketSeries, buildReport, classifyLevel, percentile, rateLimits,
  reportToCsv, reportToJson, rollupByEndpoint, activeAlerts,
  type CallRecord,
} from "./apiUsage";

const NOW = Date.UTC(2026, 10, 17, 12, 0, 0); // fixed epoch, UTC
const rec = (endpoint: string, at: number, status = 200, ms = 10): CallRecord => ({ endpoint, status, ms, at });

describe("percentile", () => {
  it("returns 0 for an empty array", () => {
    expect(percentile([], 0.95)).toBe(0);
  });
  it("indexes a sorted array and never overruns it", () => {
    const a = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(a, 0.5)).toBe(6);
    expect(percentile(a, 0.95)).toBe(10);
    expect(percentile(a, 1)).toBe(10);
  });
});

describe("classifyLevel", () => {
  it("splits ok / warning / critical at 0.7 and 0.9", () => {
    expect(classifyLevel(0)).toBe("ok");
    expect(classifyLevel(0.69)).toBe("ok");
    expect(classifyLevel(0.7)).toBe("warning");
    expect(classifyLevel(0.89)).toBe("warning");
    expect(classifyLevel(0.9)).toBe("critical");
    expect(classifyLevel(1.4)).toBe("critical");
  });
  it("honours custom thresholds", () => {
    expect(classifyLevel(0.5, 0.4, 0.6)).toBe("warning");
  });
});

describe("rollupByEndpoint", () => {
  it("groups by endpoint, busiest first", () => {
    const rows = rollupByEndpoint([
      rec("/a", NOW - 1), rec("/a", NOW - 2), rec("/a", NOW - 3),
      rec("/b", NOW - 1),
    ]);
    expect(rows.map((r) => r.endpoint)).toEqual(["/a", "/b"]);
    expect(rows[0].total).toBe(3);
  });
  it("counts errors at status >= 400 and reports the rate", () => {
    const rows = rollupByEndpoint([rec("/x", NOW, 200), rec("/x", NOW, 404), rec("/x", NOW, 500)]);
    expect(rows[0]).toMatchObject({ total: 3, errors: 2, errorRate: 0.6667 });
  });
  it("computes average and p95 latency from the recorded ms", () => {
    const lat = [10, 20, 30, 40, 50];
    const rows = rollupByEndpoint(lat.map((ms, i) => rec("/l", NOW - i, 200, ms)));
    expect(rows[0].avgMs).toBe(30);
    expect(rows[0].p95Ms).toBe(50);
  });
  it("is empty for no records", () => {
    expect(rollupByEndpoint([])).toEqual([]);
  });
});

describe("bucketSeries", () => {
  it("emits `count` contiguous buckets oldest first, empty included", () => {
    const b = bucketSeries([], "hour", NOW, 24);
    expect(b).toHaveLength(24);
    expect(b[0].start).toBe(NOW - 24 * HOUR);
    expect(b[23].end).toBe(NOW);
    expect(b.every((x) => x.total === 0)).toBe(true);
  });
  it("places a record in the bucket covering its timestamp", () => {
    const b = bucketSeries([rec("/a", NOW - 90 * 60_000)], "hour", NOW, 24); // ~1.5h ago -> 2nd from last
    expect(b[22].total).toBe(1);
    expect(b[23].total).toBe(0);
  });
  it("drops records older than the window or in the future", () => {
    const b = bucketSeries([rec("/old", NOW - 30 * HOUR), rec("/fut", NOW + HOUR)], "hour", NOW, 24);
    expect(b.reduce((n, x) => n + x.total, 0)).toBe(0);
  });
  it("separates errors from the total", () => {
    const b = bucketSeries([rec("/e", NOW - 60_000, 500), rec("/e", NOW - 120_000, 200)], "hour", NOW, 24);
    expect(b[23]).toMatchObject({ total: 2, errors: 1 });
  });
  it("labels by UTC granularity", () => {
    expect(bucketSeries([], "hour", NOW, 2)[0].label).toBe("10:00");
    const day = bucketSeries([], "day", NOW, 2)[0].label;
    expect(day).toMatch(/^\d{2}-\d{2}$/);
    expect(bucketSeries([], "week", NOW, 2)[0].label).toMatch(/^W \d{2}-\d{2}$/);
  });
  it("uses the right span width", () => {
    expect(bucketSeries([], "day", NOW, 14)[1].start - bucketSeries([], "day", NOW, 14)[0].start).toBe(DAY);
    expect(bucketSeries([], "week", NOW, 12)[1].start - bucketSeries([], "week", NOW, 12)[0].start).toBe(WEEK);
  });
});

describe("rateLimits", () => {
  const windowed = [rec("/a", NOW - 10_000, 200), rec("/a", NOW - 20_000, 200), rec("/b", NOW - 5_000, 200)];
  it("counts only calls inside the sliding window", () => {
    const l = rateLimits([...windowed, rec("/a", NOW - DEFAULT_WINDOW_MS - 1)], { now: NOW });
    const a = l.find((x) => x.endpoint === "/a")!;
    expect(a.used).toBe(2);
  });
  it("computes remaining, pct and level against the default limit", () => {
    const a = rateLimits(windowed, { now: NOW, limit: 2 })!.find((x) => x.endpoint === "/a")!;
    expect(a).toMatchObject({ limit: 2, used: 2, remaining: 0, pct: 1, level: "critical" });
  });
  it("reads a per-endpoint limit override", () => {
    const b = rateLimits(windowed, { now: NOW, limits: { "/b": 1 } }).find((x) => x.endpoint === "/b")!;
    expect(b).toMatchObject({ limit: 1, used: 1, pct: 1, level: "critical" });
  });
  it("sorts highest consumption first", () => {
    const l = rateLimits(windowed, { now: NOW, limit: 2 });
    expect(l[0].pct).toBeGreaterThanOrEqual(l[1].pct);
  });
  it("resetMs counts down from the oldest in-window call", () => {
    const a = rateLimits(windowed, { now: NOW, limit: 100 }).find((x) => x.endpoint === "/a")!;
    expect(a.resetMs).toBe(DEFAULT_WINDOW_MS - 20_000); // oldest at NOW-20s
  });
  it("is empty when no endpoint used the window", () => {
    expect(rateLimits([], { now: NOW })).toEqual([]);
  });
});

describe("activeAlerts", () => {
  it("keeps only warning / critical", () => {
    const l = rateLimits([rec("/a", NOW - 1), rec("/b", NOW - 2)], { now: NOW, limits: { "/a": 1, "/b": 100 } });
    const alerts = activeAlerts(l);
    expect(alerts.map((x) => x.endpoint)).toEqual(["/a"]);
    expect(alerts[0].level).toBe("critical");
  });
});

describe("buildReport", () => {
  const records = [
    rec("/a", NOW - 5_000, 200, 10), rec("/a", NOW - 1_000, 500, 40),
    rec("/b", NOW - 2_000, 200, 20),
  ];
  const report = buildReport(records, NOW);
  it("summarises totals", () => {
    expect(report.totals).toEqual({ calls: 3, errors: 1, errorRate: 0.3333, endpoints: 2 });
    expect(report.generatedAt).toBe(NOW);
    expect(report.windowMs).toBe(DEFAULT_WINDOW_MS);
  });
  it("carries rollups, limits and the three series", () => {
    expect(report.endpoints.map((e) => e.endpoint)).toEqual(["/a", "/b"]);
    expect(report.limits.every((l) => l.level === "ok")).toBe(true);
    expect(report.series.hour).toHaveLength(24);
    expect(report.series.day).toHaveLength(14);
    expect(report.series.week).toHaveLength(12);
  });
  it("defaults cleanly on no traffic", () => {
    const empty = buildReport([], NOW);
    expect(empty.totals.calls).toBe(0);
    expect(empty.endpoints).toEqual([]);
    expect(empty.limits).toEqual([]);
  });
});

describe("report serialisation", () => {
  const report = buildReport([rec("/x,y", NOW - 1, 200, 5), rec("/x,y", NOW - 2, 404, 15)], NOW, { limit: DEFAULT_LIMIT });
  it("renders one CSV row per endpoint with a quoted, escaped header", () => {
    const lines = reportToCsv(report).trim().split("\r\n");
    expect(lines[0]).toBe("endpoint,total,errors,error_rate,avg_ms,p95_ms,limit,used,level");
    expect(lines[1]).toBe('"/x,y",2,1,0.5,10,15,1000,2,ok');
  });
  it("produces valid, round-trippable JSON", () => {
    const parsed = JSON.parse(reportToJson(report));
    expect(parsed.totals.calls).toBe(2);
    expect(parsed.endpoints[0].endpoint).toBe("/x,y");
  });
});
