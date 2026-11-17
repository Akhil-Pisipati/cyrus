/* ══ apiKeyStore.ts — an in-memory registry of API keys ══════════
   apiKeyManager already knows how to mint, hash and constant-time
   compare a key; what it does not do is keep a list you can see,
   revoke or rotate. This is that thin management layer over it: the
   raw key is shown once at creation and never stored - only its
   hash and prefix are kept. In-memory on purpose (no schema needed):
   a restart forgets the keys, exactly as the app warns everywhere
   else that nothing durable exists without a database.           ═ */
import { randomUUID } from "node:crypto";
import { generateApiKey, type GeneratedApiKey } from "./apiKeyManager";

export type KeyEnvironment = "live" | "test";

interface StoredKey {
  readonly id: string;
  readonly name: string;
  readonly environment: KeyEnvironment;
  readonly prefix: string;
  readonly hashedKey: string;
  readonly createdAt: number;
  readonly seq: number; // monotonic, so same-millisecond keys still order
  revokedAt: number | null;
}

/** what the dashboard / list may show: never the hash, never the raw key */
export interface KeyView {
  readonly id: string;
  readonly name: string;
  readonly environment: KeyEnvironment;
  readonly masked: string;
  readonly createdAt: number;
  readonly revoked: boolean;
}

export interface CreatedKey {
  readonly key: KeyView;
  readonly rawKey: string; // returned once, at creation
}

const keys = new Map<string, StoredKey>();
let seq = 0;

const isLive = (k: StoredKey) => k.revokedAt === null;
const toView = (k: StoredKey): KeyView => ({
  id: k.id,
  name: k.name,
  environment: k.environment,
  masked: `${k.prefix}…${k.hashedKey.slice(0, 4)}`,
  createdAt: k.createdAt,
  revoked: k.revokedAt !== null,
});

function put(name: string, environment: KeyEnvironment, minted: GeneratedApiKey): StoredKey {
  const row: StoredKey = {
    id: randomUUID(),
    name: name.trim() || "Untitled key",
    environment,
    prefix: minted.prefix,
    hashedKey: minted.hashedKey,
    createdAt: Date.now(),
    seq: seq++,
    revokedAt: null,
  };
  keys.set(row.id, row);
  return row;
}

/** mint a key; the raw secret is only ever handed back here */
export function createKey(name: string, environment: KeyEnvironment = "live"): CreatedKey {
  const minted = generateApiKey(environment);
  const row = put(name, environment, minted);
  return { key: toView(row), rawKey: minted.rawKey };
}

/** newest first, live and revoked both listed */
export function listKeys(): KeyView[] {
  return [...keys.values()].sort((a, b) => b.createdAt - a.createdAt || b.seq - a.seq).map(toView);
}

export function liveKeyCount(): number {
  let n = 0;
  for (const k of keys.values()) if (isLive(k)) n++;
  return n;
}

/** revoke an existing, still-live key; false if unknown or already revoked */
export function revokeKey(id: string): boolean {
  const k = keys.get(id);
  if (!k || k.revokedAt !== null) return false;
  k.revokedAt = Date.now();
  return true;
}

/** revoke the old key and mint a fresh one in its place */
export function rotateKey(id: string, name?: string): CreatedKey | null {
  const old = keys.get(id);
  if (!old || old.revokedAt !== null) return null;
  revokeKey(id);
  return createKey(name ?? old.name, old.environment);
}

export function resetKeys(): void {
  keys.clear();
}
