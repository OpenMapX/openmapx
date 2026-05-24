import { describe, expect, it } from "vitest";
import { createPoiSingleFlight } from "../../src/jobs/poi-ingest/single-flight.js";

describe("createPoiSingleFlight", () => {
  it("acquires a lock once per (sourceId, kind) tuple", () => {
    const sf = createPoiSingleFlight({ now: () => 1_700_000_000_000 });
    expect(sf.tryAcquire("bnetza-ev", "static")).toEqual({ ok: true });
    const second = sf.tryAcquire("bnetza-ev", "static");
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.reason).toBe("in-flight");
      expect(second.existing.sourceId).toBe("bnetza-ev");
      expect(second.existing.kind).toBe("static");
    }
  });

  it("treats different kinds as independent locks for the same source", () => {
    const sf = createPoiSingleFlight();
    expect(sf.tryAcquire("bnetza-ev", "static").ok).toBe(true);
    expect(sf.tryAcquire("bnetza-ev", "live").ok).toBe(true);
  });

  it("treats different sources as independent locks", () => {
    const sf = createPoiSingleFlight();
    expect(sf.tryAcquire("a", "static").ok).toBe(true);
    expect(sf.tryAcquire("b", "static").ok).toBe(true);
  });

  it("re-acquires after release", () => {
    const sf = createPoiSingleFlight();
    expect(sf.tryAcquire("a", "static").ok).toBe(true);
    sf.release("a", "static");
    expect(sf.tryAcquire("a", "static").ok).toBe(true);
  });

  it("lists all current inflight entries", () => {
    const sf = createPoiSingleFlight({ now: () => 1 });
    sf.tryAcquire("a", "static");
    sf.tryAcquire("a", "live");
    sf.tryAcquire("b", "bundled");
    const all = sf.listInflight();
    expect(all).toHaveLength(3);
    expect(new Set(all.map((e) => `${e.sourceId}:${e.kind}`))).toEqual(
      new Set(["a:static", "a:live", "b:bundled"]),
    );
  });

  it("getInflight returns null when nothing is held", () => {
    const sf = createPoiSingleFlight();
    expect(sf.getInflight("nope", "static")).toBeNull();
    sf.tryAcquire("nope", "static");
    expect(sf.getInflight("nope", "static")?.sourceId).toBe("nope");
  });
});
