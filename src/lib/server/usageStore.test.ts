import { beforeEach, describe, expect, it } from "vitest";
import { recordUsage, resetUsage, usageCount, usageRecords } from "./usageStore";

describe("usageStore", () => {
  beforeEach(() => resetUsage());

  it("starts empty", () => {
    expect(usageCount()).toBe(0);
    expect(usageRecords()).toEqual([]);
  });

  it("records a call with a supplied timestamp", () => {
    recordUsage("/api/x", 200, 12, 1_000);
    expect(usageRecords()).toEqual([{ endpoint: "/api/x", status: 200, ms: 12, at: 1_000 }]);
  });

  it("defaults the timestamp to now and preserves insertion order", () => {
    recordUsage("/a", 200, 1, 100);
    recordUsage("/b", 500, 2, 200);
    const r = usageRecords();
    expect(r.map((x) => x.endpoint)).toEqual(["/a", "/b"]);
    expect(typeof r[0].at).toBe("number");
  });

  it("returns a copy, so external mutation cannot corrupt the ring", () => {
    recordUsage("/a", 200, 1, 100);
    const snapshot = usageRecords();
    snapshot.length = 0;
    expect(usageCount()).toBe(1);
  });

  it("evicts the oldest past the cap", () => {
    for (let i = 0; i < 10_003; i++) recordUsage("/bulk", 200, 1, 10 + i);
    const r = usageRecords();
    expect(r).toHaveLength(10_000);
    expect(r[0].at).toBe(13); // first three evicted
    expect(r[r.length - 1].at).toBe(10_012);
  });

  it("reset empties it", () => {
    recordUsage("/a", 200, 1, 100);
    resetUsage();
    expect(usageCount()).toBe(0);
  });
});
