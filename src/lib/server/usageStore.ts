/* ══ usageStore.ts — an in-memory time-series of API calls ═══════
   The board asks for usage over time and rate-limit consumption; the
   existing apiMetrics collector only keeps latency arrays with no
   timestamps, so it cannot be bucketed. This ring stores each finished
   call as a CallRecord and hands the whole window to the pure lib.
   It is deliberately not durable: like every other live counter in this
   app it resets on restart, and the dashboard degrades to empty states
   rather than pretending to remember.                             ═ */
import type { CallRecord } from "../apiUsage";

const CAP = 10_000;
const ring: CallRecord[] = [];

/** append one finished call, evicting the oldest past the cap */
export function recordUsage(endpoint: string, status: number, ms: number, at: number = Date.now()): void {
  ring.push({ endpoint, status, ms, at });
  if (ring.length > CAP) ring.shift();
}

/** a copy of the current window, safe for the report builder */
export function usageRecords(): CallRecord[] {
  return ring.slice();
}

export function usageCount(): number {
  return ring.length;
}

export function resetUsage(): void {
  ring.length = 0;
}
