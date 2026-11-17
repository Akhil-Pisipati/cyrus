import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({
  backendReady: vi.fn(() => true),
  currentUser: vi.fn(async (): Promise<{ id: string } | null> => ({ id: "u1" })),
  OFFLINE: vi.fn(() => Response.json({ error: "backend offline" }, { status: 503 })),
}));
vi.mock("@/lib/server/auth", () => ({ backendReady: auth.backendReady, currentUser: auth.currentUser, OFFLINE: auth.OFFLINE }));

const store = vi.hoisted(() => ({
  recordUsage: vi.fn(),
  usageRecords: vi.fn(() => [] as { endpoint: string; status: number; ms: number; at: number }[]),
}));
vi.mock("@/lib/server/usageStore", () => ({ recordUsage: store.recordUsage, usageRecords: store.usageRecords }));

const keys = vi.hoisted(() => ({
  createKey: vi.fn(),
  listKeys: vi.fn(() => [] as unknown[]),
  revokeKey: vi.fn(() => true),
  rotateKey: vi.fn(),
}));
vi.mock("@/lib/server/apiKeyStore", () => keys);

import { GET as usageGET } from "./route";
import { GET as reportGET } from "./report/route";
import { GET as keysGET, POST as keysPOST } from "../keys/route";

const req = (url: string, body?: unknown) =>
  new Request(url, body === undefined ? undefined : { method: "POST", body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  auth.backendReady.mockReturnValue(true);
  auth.currentUser.mockResolvedValue({ id: "u1" });
  store.usageRecords.mockReturnValue([]);
});

describe("GET /api/usage", () => {
  it("is 503 when the backend is offline", async () => {
    auth.backendReady.mockReturnValue(false);
    const res = await usageGET();
    expect(res.status).toBe(503);
    expect(auth.OFFLINE).toHaveBeenCalled();
  });
  it("is 401 when nobody is signed in", async () => {
    auth.currentUser.mockResolvedValue(null);
    const res = await usageGET();
    expect(res.status).toBe(401);
  });
  it("returns the full report shape for a signed-in user", async () => {
    const res = await usageGET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ totals: { calls: 0, endpoints: 0 }, endpoints: [], limits: [] });
    expect(body.series.hour).toHaveLength(24);
    expect(store.recordUsage).toHaveBeenCalledWith("/api/usage", 200, expect.any(Number), expect.any(Number));
  });
});

describe("GET /api/usage/report", () => {
  it("guards offline and signed-out", async () => {
    auth.backendReady.mockReturnValue(false);
    expect((await reportGET(req("http://x/api/usage/report"))).status).toBe(503);
    auth.backendReady.mockReturnValue(true);
    auth.currentUser.mockResolvedValue(null);
    expect((await reportGET(req("http://x/api/usage/report"))).status).toBe(401);
  });
  it("defaults to CSV with an attachment disposition", async () => {
    const res = await reportGET(req("http://x/api/usage/report"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toMatch(/attachment; filename="cyrus-usage-\d{4}-\d{2}-\d{2}\.csv"/);
    expect(await res.text()).toContain("endpoint,total,errors,error_rate,avg_ms,p95_ms,limit,used,level");
  });
  it("serves JSON when ?format=json", async () => {
    const res = await reportGET(req("http://x/api/usage/report?format=json"));
    expect(res.headers.get("content-type")).toContain("application/json");
    expect((await res.json()).totals).toMatchObject({ calls: 0 });
  });
});

describe("GET /api/keys", () => {
  it("guards offline and signed-out", async () => {
    auth.backendReady.mockReturnValue(false);
    expect((await keysGET()).status).toBe(503);
    auth.backendReady.mockReturnValue(true);
    auth.currentUser.mockResolvedValue(null);
    expect((await keysGET()).status).toBe(401);
  });
  it("lists the registry", async () => {
    keys.listKeys.mockReturnValue([{ id: "1" }]);
    const body = await (await keysGET()).json();
    expect(body).toEqual({ keys: [{ id: "1" }] });
  });
});

describe("POST /api/keys", () => {
  it("400s a non-JSON or unknown action", async () => {
    auth.currentUser.mockResolvedValue({ id: "u1" });
    expect((await keysPOST(new Request("http://x/api/keys", { method: "POST", body: "not json" }))).status).toBe(400);
    expect((await keysPOST(req("http://x/api/keys", { action: "delete" }))).status).toBe(400);
  });
  it("generate returns the raw key once and records usage", async () => {
    keys.createKey.mockReturnValue({ key: { id: "k1", name: "CI" }, rawKey: "cyrus_live_secret" });
    const res = await keysPOST(req("http://x/api/keys", { action: "generate", name: "CI", environment: "test" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, rawKey: "cyrus_live_secret", key: { id: "k1" } });
    expect(keys.createKey).toHaveBeenCalledWith("CI", "test");
    expect(store.recordUsage).toHaveBeenCalled();
  });
  it("generate falls back to live and an empty name", async () => {
    keys.createKey.mockReturnValue({ key: { id: "k2" }, rawKey: "x" });
    await keysPOST(req("http://x/api/keys", { action: "generate" }));
    expect(keys.createKey).toHaveBeenCalledWith("", "live");
  });
  it("revoke needs an id and a live key", async () => {
    expect((await keysPOST(req("http://x/api/keys", { action: "revoke" }))).status).toBe(400);
    keys.revokeKey.mockReturnValue(false);
    expect((await keysPOST(req("http://x/api/keys", { action: "revoke", id: "nope" }))).status).toBe(400);
  });
  it("revoke succeeds and returns the updated list", async () => {
    keys.revokeKey.mockReturnValue(true);
    keys.listKeys.mockReturnValue([{ id: "a", revoked: true }]);
    const body = await (await keysPOST(req("http://x/api/keys", { action: "revoke", id: "a" }))).json();
    expect(body).toMatchObject({ ok: true, revoked: true });
    expect(body.keys).toHaveLength(1);
  });
  it("rotate refuses an unknown id and succeeds otherwise", async () => {
    keys.rotateKey.mockReturnValue(null);
    expect((await keysPOST(req("http://x/api/keys", { action: "rotate", id: "ghost" }))).status).toBe(400);
    keys.rotateKey.mockReturnValue({ key: { id: "new" }, rawKey: "r" });
    const body = await (await keysPOST(req("http://x/api/keys", { action: "rotate", id: "old" }))).json();
    expect(body).toMatchObject({ ok: true, key: { id: "new" }, rawKey: "r" });
  });
});
