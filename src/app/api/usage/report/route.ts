/* ══ GET /api/usage/report — download the usage report ══════════
   Same protection as the board. ?format=csv (default) returns a
   spreadsheet one row per endpoint; ?format=json returns the full
   report. Both carry an attachment filename so the browser saves it. ═ */
import { backendReady, currentUser, OFFLINE } from "@/lib/server/auth";
import { buildReport, reportToCsv, reportToJson } from "@/lib/apiUsage";
import { usageRecords } from "@/lib/server/usageStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!backendReady()) return OFFLINE();
  const u = await currentUser();
  if (!u) return Response.json({ error: "signed out" }, { status: 401 });

  const format = new URL(req.url).searchParams.get("format") ?? "csv";
  const stamp = new Date().toISOString().slice(0, 10);

  if (format === "json") {
    return new Response(reportToJson(buildReport(usageRecords(), Date.now())), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="cyrus-usage-${stamp}.json"`,
      },
    });
  }

  return new Response(reportToCsv(buildReport(usageRecords(), Date.now())), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="cyrus-usage-${stamp}.csv"`,
    },
  });
}
