"use client"
/* ══ ApiUsage.tsx — the API usage & rate-limit board (#191) ══════
   A protected dashboard reading /api/usage: hourly / daily / weekly
   traffic, current rate-limit consumption per endpoint with alert
   thresholds, an endpoint breakdown, a downloadable report and live
   API-key management. With no backend or no session it shows honest
   empty states rather than inventing numbers - the same rule the rest
   of the board lives by. Charts are hand-rolled SVG; nothing here
   adds a dependency.                                              ═ */
import { useCallback, useEffect, useMemo, useState } from "react";
import { btn } from "@/components/ui";
import { Card, DashHead, Ic, StatRow } from "@/lib/dash/shell";
import { DP } from "@/lib/dash/shared";

type Gran = "hour" | "day" | "week";
type Level = "ok" | "warning" | "critical";

interface Bucket { label: string; total: number; errors: number }
interface Rollup { endpoint: string; total: number; errors: number; errorRate: number; avgMs: number; p95Ms: number }
interface Limit { endpoint: string; limit: number; used: number; remaining: number; pct: number; level: Level; resetMs: number }
interface Report {
  generatedAt: number; windowMs: number;
  totals: { calls: number; errors: number; errorRate: number; endpoints: number };
  endpoints: Rollup[]; limits: Limit[]; series: Record<Gran, Bucket[]>;
}
interface KeyRow { id: string; name: string; environment: "live" | "test"; masked: string; createdAt: number; revoked: boolean }

type Status = "loading" | "ready" | "offline" | "auth" | "error";

const LEVEL_TEXT: Record<Level, string> = { ok: "text-leaf", warning: "text-honey", critical: "text-brick" };
const LEVEL_VAR: Record<Level, string> = { ok: "var(--color-accent)", warning: "var(--color-honey)", critical: "var(--color-brick)" };
const GRAN_LABEL: Record<Gran, string> = { hour: "Hourly", day: "Daily", week: "Weekly" };

const num = (n: number) => n.toLocaleString("en-US");
const pct = (r: number) => `${Math.round(r * 100)}%`;
const ms = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}s` : `${Math.round(n)}ms`);
const clock = (msLeft: number) => (msLeft >= 60000 ? `${Math.round(msLeft / 60000)}m` : `${Math.ceil(msLeft / 1000)}s`);

async function fetchJson<T>(url: string): Promise<{ status: Status; data?: T }> {
  try {
    const r = await fetch(url, { headers: { accept: "application/json" } });
    if (r.status === 503) return { status: "offline" };
    if (r.status === 401) return { status: "auth" };
    if (!r.ok) return { status: "error" };
    return { status: "ready", data: (await r.json()) as T };
  } catch {
    return { status: "error" };
  }
}

/* hand-rolled column chart, oldest -> newest, errors shaded amber */
function Bars({ buckets, gran }: { buckets: Bucket[]; gran: Gran }) {
  const max = Math.max(1, ...buckets.map((b) => b.total));
  const slot = 100 / Math.max(1, buckets.length);
  return (
    <div>
      <svg viewBox="0 0 100 40" preserveAspectRatio="none" className="w-full h-[150px]" role="img" aria-label={`${GRAN_LABEL[gran]} request volume`}>
        {buckets.map((b, i) => {
          const h = (b.total / max) * 37;
          return (
            <rect key={i} x={i * slot + slot * 0.16} y={38 - h} width={slot * 0.68} height={Math.max(h, b.total ? 0.6 : 0)} rx={0.5}
              style={{ fill: b.errors > 0 ? "var(--color-honey)" : "var(--color-accent)", opacity: b.total ? 0.92 : 0.16 }}>
              <title>{`${b.label}: ${num(b.total)} request${b.total === 1 ? "" : "s"}${b.errors ? ` · ${num(b.errors)} errors` : ""}`}</title>
            </rect>
          );
        })}
        <line x1="0" y1="38" x2="100" y2="38" style={{ stroke: "var(--color-line)" }} strokeWidth={0.3} />
      </svg>
      <div className="flex justify-between mt-2 font-mono text-[10px] text-dim">
        <span>{buckets[0]?.label ?? "—"}</span>
        <span>{buckets[buckets.length - 1]?.label ?? "now"}</span>
      </div>
    </div>
  );
}

function Gauge({ value, level }: { value: number; level: Level }) {
  const R = 34, C = 2 * Math.PI * R, frac = Math.max(0, Math.min(1, value));
  return (
    <svg viewBox="0 0 80 80" width={88} height={88} role="img" aria-label={`Highest limit at ${pct(value)} used`}>
      <circle cx="40" cy="40" r={R} fill="none" style={{ stroke: "var(--color-line)" }} strokeWidth={8} />
      <circle cx="40" cy="40" r={R} fill="none" style={{ stroke: LEVEL_VAR[level] }} strokeWidth={8} strokeLinecap="round"
        strokeDasharray={`${frac * C} ${C}`} transform="rotate(-90 40 40)" />
      <text x="40" y="45" textAnchor="middle" style={{ fill: "var(--color-ink)", font: "700 15px var(--font-mono)" }}>{pct(value)}</text>
    </svg>
  );
}

export default function ApiUsage() {
  const [report, setReport] = useState<Report | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [gran, setGran] = useState<Gran>("hour");
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [secret, setSecret] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [env, setEnv] = useState<"live" | "test">("live");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [u, k] = await Promise.all([fetchJson<Report>("/api/usage"), fetchJson<{ keys: KeyRow[] }>("/api/keys")]);
    setStatus(u.status);
    if (u.data) setReport(u.data);
    if (k.data) setKeys(k.data.keys);
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, [load]);

  const act = useCallback(async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      const r = await fetch("/api/keys", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const data = await r.json();
      if (r.ok) {
        if (typeof data.rawKey === "string") setSecret(data.rawKey);
        if (Array.isArray(data.keys)) setKeys(data.keys);
        else if (data.key) await load();
      }
    } catch { /* surfaced by the next refresh */ }
    finally { setBusy(false); }
  }, [load]);

  const peak = useMemo(() => report?.limits.reduce((m, l) => (l.pct > m.pct ? l : m), { pct: 0, level: "ok" as Level } as Pick<Limit, "pct" | "level">), [report]);
  const alerts = useMemo(() => (report?.limits ?? []).filter((l) => l.level !== "ok"), [report]);

  if (status === "offline" || status === "auth" || status === "error") {
    const copy = status === "offline"
      ? { t: "Backend offline", s: "Usage needs a signed-in session against a live database, so nothing is being counted right now." }
      : status === "auth"
        ? { t: "Sign in required", s: "This board shows the traffic on your API keys - sign in from the dashboard to see it." }
        : { t: "Could not read usage", s: "The usage feed did not answer. Try again in a moment." };
    return (
      <div className="mx-auto max-w-[1160px] px-4 md:px-7 py-6 md:py-9">
        <DashHead title="API usage" sub="Rate-limit consumption and traffic over time." />
        <Card className="mt-6 text-center py-14">
          <div className="inline-grid place-items-center w-12 h-12 rounded-full border border-line text-dim mb-4"><Ic d={DP.pulse} size={22} /></div>
          <h2 className="font-display font-bold text-[18px]">{copy.t}</h2>
          <p className="text-cocoa text-[14px] leading-[1.6] mt-2 max-w-[440px] mx-auto">{copy.s}</p>
          <button className={btn("outline", "sm") + " mt-5"} onClick={() => { setStatus("loading"); void load(); }}>Try again</button>
        </Card>
      </div>
    );
  }

  if (status === "loading" || !report) {
    return (
      <div className="mx-auto max-w-[1160px] px-4 md:px-7 py-6 md:py-9 grid gap-6">
        <DashHead title="API usage" sub="Rate-limit consumption and traffic over time." />
        <Card className="py-14 text-center font-mono text-[11px] uppercase tracking-[.16em] text-dim">Loading your usage…</Card>
      </div>
    );
  }

  const buckets = report.series[gran];
  const hasTraffic = report.totals.calls > 0;

  return (
    <div className="mx-auto max-w-[1160px] px-4 md:px-7 py-6 md:py-9 grid gap-6 [&>*]:min-w-0">
      <DashHead
        tag="Board"
        title="API usage"
        sub="Current rate-limit consumption, traffic over time and key management for this deployment."
        action={
          <>
            <a href="/api/usage/report?format=csv" className={btn("outline", "sm")} download>CSV</a>
            <a href="/api/usage/report?format=json" className={btn("outline", "sm")} download>JSON</a>
          </>
        }
      />

      {alerts.length > 0 && (
        <div className="rounded-[14px] border px-4 py-3 flex items-center gap-3" style={{ borderColor: "var(--color-honey)", background: "color-mix(in srgb, var(--color-honey) 12%, transparent)" }}>
          <span className="w-[8px] h-[8px] rounded-full shrink-0" style={{ background: alerts.some((a) => a.level === "critical") ? "var(--color-brick)" : "var(--color-honey)" }} aria-hidden />
          <p className="text-[13.5px] text-cocoa">
            <b className="text-ink">{alerts.length}</b> endpoint{alerts.length === 1 ? "" : "s"} at or past the alert threshold — closest to the cap is <code className="font-mono text-[12.5px] text-ink">{alerts[0].endpoint}</code> at <b className={LEVEL_TEXT[alerts[0].level]}>{pct(alerts[0].pct)}</b>.
          </p>
        </div>
      )}

      {/* the numbers, up top */}
      <div className="grid md:grid-cols-[minmax(0,1fr)_auto] gap-5 items-center">
        <Card>
          <StatRow items={[
            ["calls", num(report.totals.calls)],
            ["endpoints", num(report.totals.endpoints)],
            ["errors", num(report.totals.errors)],
            ["error rate", pct(report.totals.errorRate)],
            ["window", `${report.windowMs / 1000}s`],
          ]} />
        </Card>
        {hasTraffic && peak && peak.pct > 0 && (
          <Card className="flex items-center gap-4 py-4">
            <Gauge value={peak.pct} level={peak.level} />
            <div>
              <p className="eyebrow mb-1">Peak limit use</p>
              <b className={`font-display font-bold text-[22px] ${LEVEL_TEXT[peak.level]}`}>{pct(peak.pct)}</b>
              <p className="text-dim text-[12px] font-mono mt-0.5">resets in {clock(report.limits[0]?.resetMs ?? report.windowMs)}</p>
            </div>
          </Card>
        )}
      </div>

      {/* traffic over time */}
      <Card>
        <div className="flex items-center justify-between gap-3 flex-wrap mb-4">
          <h2 className="font-display font-bold text-[16px]">Traffic over time</h2>
          <div className="flex gap-1 rounded-full border border-line bg-sand p-1">
            {(["hour", "day", "week"] as Gran[]).map((g) => (
              <button key={g} onClick={() => setGran(g)} aria-pressed={gran === g}
                className={`px-3 py-1 rounded-full text-[12.5px] font-semibold transition-colors cursor-pointer ${gran === g ? "bg-accent text-accentfg" : "text-cocoa hover:text-ink"}`}>
                {GRAN_LABEL[g]}
              </button>
            ))}
          </div>
        </div>
        {hasTraffic ? <Bars buckets={buckets} gran={gran} /> : (
          <p className="text-cocoa text-[13.5px] py-10 text-center">No API calls recorded yet on this server. Traffic appears here as requests come in.</p>
        )}
      </Card>

      <div className="grid lg:grid-cols-2 gap-6">
        {/* rate-limit status per endpoint */}
        <Card>
          <h2 className="font-display font-bold text-[16px] mb-4">Rate-limit status</h2>
          {report.limits.length ? (
            <div className="grid gap-3">
              {report.limits.map((l) => (
                <div key={l.endpoint}>
                  <div className="flex items-baseline justify-between gap-3 mb-1">
                    <code className="font-mono text-[12.5px] text-ink truncate">{l.endpoint}</code>
                    <span className={`font-mono text-[12px] font-semibold ${LEVEL_TEXT[l.level]}`}>{num(l.used)}/{num(l.limit)} · {clock(l.resetMs)}</span>
                  </div>
                  <div className="h-2 rounded-full bg-clay overflow-hidden">
                    <div className="h-full rounded-full transition-all duration-500" style={{ width: `${Math.min(100, l.pct * 100)}%`, background: LEVEL_VAR[l.level] }} />
                  </div>
                </div>
              ))}
            </div>
          ) : <p className="text-cocoa text-[13.5px] py-6 text-center">No calls inside the current window.</p>}
        </Card>

        {/* endpoint breakdown */}
        <Card>
          <h2 className="font-display font-bold text-[16px] mb-4">By endpoint</h2>
          {report.endpoints.length ? (
            <div className="overflow-x-auto -mx-1">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="text-dim font-mono text-[10.5px] uppercase tracking-[.12em] text-left">
                    <th className="px-1 py-1.5 font-semibold">Endpoint</th>
                    <th className="px-1 py-1.5 font-semibold text-right">Calls</th>
                    <th className="px-1 py-1.5 font-semibold text-right">Err</th>
                    <th className="px-1 py-1.5 font-semibold text-right">p95</th>
                  </tr>
                </thead>
                <tbody>
                  {report.endpoints.map((e) => (
                    <tr key={e.endpoint} className="border-t border-line">
                      <td className="px-1 py-2 font-mono text-[12px] text-ink truncate max-w-[220px]">{e.endpoint}</td>
                      <td className="px-1 py-2 text-right font-mono text-cocoa">{num(e.total)}</td>
                      <td className={`px-1 py-2 text-right font-mono ${e.errors ? "text-honey" : "text-dim"}`}>{num(e.errors)}</td>
                      <td className="px-1 py-2 text-right font-mono text-cocoa">{ms(e.p95Ms)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <p className="text-cocoa text-[13.5px] py-6 text-center">Nothing counted yet.</p>}
        </Card>
      </div>

      {/* API key management */}
      <Card>
        <h2 className="font-display font-bold text-[16px] mb-1">API keys</h2>
        <p className="text-cocoa text-[13px] mb-4">Keys live in this server's memory: mint, revoke or rotate them, and a restart forgets them. The secret shows once — copy it now.</p>

        {secret && (
          <div className="rounded-[12px] border mb-4 p-3 flex items-center gap-3 flex-wrap" style={{ borderColor: "var(--color-accent)", background: "color-mix(in srgb, var(--color-accent) 10%, transparent)" }}>
            <code className="font-mono text-[12.5px] text-ink break-all flex-1 min-w-0">{secret}</code>
            <button className={btn("outline", "sm")} onClick={() => setSecret(null)} aria-label="Dismiss secret">Done</button>
          </div>
        )}

        <div className="flex gap-2 flex-wrap items-center mb-4">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Key name" maxLength={80}
            className="h-9 px-3 rounded-[10px] border border-line bg-card text-ink text-[13px] min-w-0 flex-1 max-w-[240px]" />
          <select value={env} onChange={(e) => setEnv(e.target.value as "live" | "test")}
            className="h-9 px-2 rounded-[10px] border border-line bg-card text-ink text-[13px] cursor-pointer">
            <option value="live">live</option>
            <option value="test">test</option>
          </select>
          <button className={btn("primary", "sm")} disabled={busy} onClick={() => { setName(""); void act({ action: "generate", name, environment: env }); }}>Generate</button>
        </div>

        {keys.length ? (
          <div className="grid gap-2">
            {keys.map((k) => (
              <div key={k.id} className={`flex items-center gap-3 rounded-[12px] border border-line px-3 py-2.5 ${k.revoked ? "opacity-60" : ""}`}>
                <span className={`w-[7px] h-[7px] rounded-full shrink-0 ${k.revoked ? "bg-rule" : "bg-leaf"}`} aria-hidden />
                <div className="min-w-0 flex-1">
                  <b className="block text-[13.5px] font-semibold text-ink truncate">{k.name}</b>
                  <span className="block font-mono text-[11px] text-dim truncate">{k.masked} · {k.environment}</span>
                </div>
                <span className="font-mono text-[11px] text-dim hidden sm:block">{new Date(k.createdAt).toISOString().slice(0, 10)}</span>
                {k.revoked ? (
                  <span className="font-mono text-[11px] text-dim">revoked</span>
                ) : (
                  <div className="flex gap-1.5 shrink-0">
                    <button className={btn("outline", "sm")} disabled={busy} onClick={() => void act({ action: "rotate", id: k.id })}>Rotate</button>
                    <button className="h-9 px-3 rounded-[10px] border text-[13px] font-semibold cursor-pointer transition-colors"
                      style={{ borderColor: "color-mix(in srgb, var(--color-brick) 45%, transparent)", color: "var(--color-brick)" }}
                      disabled={busy} onClick={() => void act({ action: "revoke", id: k.id })}>Revoke</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : <p className="text-cocoa text-[13.5px] py-4 text-center">No keys yet. Generate one to start calling the API.</p>}
      </Card>
    </div>
  );
}
