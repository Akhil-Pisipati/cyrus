import { beforeEach, describe, expect, it } from "vitest";
import { hashApiKey } from "./apiKeyManager";
import {
  createKey, listKeys, liveKeyCount, resetKeys, revokeKey, rotateKey,
} from "./apiKeyStore";

describe("apiKeyStore", () => {
  beforeEach(() => resetKeys());

  it("mints a live key and hands back the raw secret only once", () => {
    const { key, rawKey } = createKey("CI", "test");
    expect(rawKey.startsWith("cyrus_test_")).toBe(true);
    expect(key.environment).toBe("test");
    expect(key.revoked).toBe(false);
    // no view ever carries the raw key or the full hash
    expect(JSON.stringify(key)).not.toContain(rawKey);
    expect(key.masked).not.toContain(rawKey);
  });

  it("names an untitled key", () => {
    expect(createKey("   ").key.name).toBe("Untitled key");
  });

  it("stores the hash, not the secret: masked tail matches the hash", () => {
    const { key, rawKey } = createKey("x", "live");
    expect(key.masked.endsWith(`…${hashApiKey(rawKey).slice(0, 4)}`)).toBe(true);
  });

  it("lists newest first", () => {
    const a = createKey("a");
    const b = createKey("b");
    const list = listKeys();
    expect(list.map((k) => k.id)).toEqual([b.key.id, a.key.id]);
  });

  it("revoke flips a live key and is idempotent", () => {
    const { key } = createKey("x");
    expect(revokeKey(key.id)).toBe(true);
    expect(listKeys()[0].revoked).toBe(true);
    expect(revokeKey(key.id)).toBe(false);   // already revoked
    expect(revokeKey("nope")).toBe(false);   // unknown id
  });

  it("counts only live keys", () => {
    const a = createKey("a");
    createKey("b");
    expect(liveKeyCount()).toBe(2);
    revokeKey(a.key.id);
    expect(liveKeyCount()).toBe(1);
  });

  it("rotate revokes the old key and mints a replacement in its name", () => {
    const a = createKey("deploy", "live");
    const rotated = rotateKey(a.key.id);
    expect(rotated).not.toBeNull();
    expect(rotated!.key.name).toBe("deploy");
    expect(rotated!.key.environment).toBe("live");
    const list = listKeys();
    expect(list).toHaveLength(2);
    expect(list.find((k) => k.id === a.key.id)!.revoked).toBe(true);
  });

  it("rotate refuses an unknown or already-revoked id", () => {
    expect(rotateKey("nope")).toBeNull();
    const a = createKey("x");
    revokeKey(a.key.id);
    expect(rotateKey(a.key.id)).toBeNull();
  });

  it("reset clears everything", () => {
    createKey("x");
    resetKeys();
    expect(listKeys()).toEqual([]);
    expect(liveKeyCount()).toBe(0);
  });
});
