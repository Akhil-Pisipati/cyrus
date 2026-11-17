/* ══ GET /api/usage — the signed-in dashboard's numbers ═════════
   Protected admin surface: no backend, or no session, means nothing to
   read. On a live call we also record *this* request into the time
   series, so the board is measuring real traffic rather than a frozen
   fixture. The pure lib does all the maths on the current window.    ═ */
import { backendReady, currentUser, OFFLINE } from "@/lib/server/auth";
import { buildReport } from "@/lib/apiUsage";
import { recordUsage, usageRecords } from "@/lib/server/usageStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  if (!backendReady()) return OFFLINE();
  const u = await currentUser();
  if (!u) return Response.json({ error: "signed out" }, { status: 401 });

  const started = Date.now();
  const report = buildReport(usageRecords(), started);
  recordUsage("/api/usage", 200, Math.max(0, Date.now() - started), started);
  return Response.json(report);
}
