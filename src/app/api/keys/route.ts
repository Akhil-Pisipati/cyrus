/* ══ /api/keys — API key management for the board ══════════════
   Protected. GET lists the registry (masked); POST takes an action:
     generate -> { name?, environment? }  returns the raw key ONCE
     revoke   -> { id }
     rotate   -> { id, name? }            revokes the old, mints a new
   Everything is in-memory (see apiKeyStore): a restart forgets it, the
   same honest limitation the rest of the app carries without a DB.    ═ */
import { backendReady, currentUser, OFFLINE } from "@/lib/server/auth";
import {
  createKey, listKeys, revokeKey, rotateKey, type KeyEnvironment,
} from "@/lib/server/apiKeyStore";
import { recordUsage } from "@/lib/server/usageStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const unauthorized = () => Response.json({ error: "signed out" }, { status: 401 });
const bad = (msg: string) => Response.json({ error: msg }, { status: 400 });

const ENVS = new Set<KeyEnvironment>(["live", "test"]);

async function guard(): Promise<Response | null> {
  if (!backendReady()) return OFFLINE();
  const u = await currentUser();
  return u ? null : unauthorized();
}

export async function GET() {
  const off = await guard();
  if (off) return off;
  return Response.json({ keys: listKeys() });
}

export async function POST(req: Request) {
  const off = await guard();
  if (off) return off;

  let body: { action?: unknown; id?: unknown; name?: unknown; environment?: unknown };
  try { body = await req.json(); } catch { return bad("JSON body required"); }
  if (body.action !== "generate" && body.action !== "revoke" && body.action !== "rotate")
    return bad("action must be generate, revoke or rotate");

  const name = typeof body.name === "string" ? body.name.slice(0, 80) : "";
  const environment: KeyEnvironment = ENVS.has(body.environment as KeyEnvironment) ? (body.environment as KeyEnvironment) : "live";

  if (body.action === "generate") {
    const created = createKey(name, environment);
    recordUsage("/api/keys", 200, 1);
    return Response.json({ ok: true, key: created.key, rawKey: created.rawKey });
  }

  if (typeof body.id !== "string" || !body.id) return bad("id is required");

  if (body.action === "revoke") {
    const revoked = revokeKey(body.id);
    if (!revoked) return bad("no live key with that id");
    recordUsage("/api/keys", 200, 1);
    return Response.json({ ok: true, revoked: true, keys: listKeys() });
  }

  // rotate
  const rotated = rotateKey(body.id, name || undefined);
  if (!rotated) return bad("no live key with that id");
  recordUsage("/api/keys", 200, 1);
  return Response.json({ ok: true, key: rotated.key, rawKey: rotated.rawKey, keys: listKeys() });
}
