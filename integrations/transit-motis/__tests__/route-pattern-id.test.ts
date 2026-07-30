import { describe, expect, it } from "vitest";
import {
  decodeMotisLineReference,
  decodeMotisRoutePatternId,
  encodeMotisLineReference,
  encodeMotisRoutePatternId,
  validateMotisLineReferenceEpoch,
  validateMotisRoutePatternEpoch,
} from "../route-pattern-id";

describe("MOTIS route-pattern identifiers", () => {
  it("round-trips deterministically with every source route ID", () => {
    const id = encodeMotisRoutePatternId("epoch-42", 17, ["route/ä", "route:b"]);
    expect(id).toMatch(/^ms:rp:[A-Za-z0-9_-]+$/);
    expect(id).not.toContain("=");
    expect(encodeMotisRoutePatternId("epoch-42", 17, ["route/ä", "route:b"])).toBe(id);
    expect(decodeMotisRoutePatternId(id)).toEqual({
      v: 1,
      e: "epoch-42",
      i: 17,
      r: ["route/ä", "route:b"],
    });
  });

  it("rejects stale epochs without changing the index", () => {
    const id = encodeMotisRoutePatternId("old", 9, ["r"]);
    expect(validateMotisRoutePatternEpoch(id, "new")).toBeNull();
    expect(validateMotisRoutePatternEpoch(id, "old")?.i).toBe(9);
  });

  it.each([
    "ms:route-id",
    "ms:rp:",
    "ms:rp:not+base64",
    `ms:rp:${Buffer.from("not json").toString("base64url")}`,
    `ms:rp:${Buffer.from(JSON.stringify({ v: 2, e: "e", i: 1, r: [] })).toString("base64url")}`,
    `ms:rp:${Buffer.from(JSON.stringify({ v: 1, e: "", i: 1, r: [] })).toString("base64url")}`,
    `ms:rp:${Buffer.from(JSON.stringify({ v: 1, e: "e", i: -1, r: [] })).toString("base64url")}`,
    `ms:rp:${Buffer.from(JSON.stringify({ v: 1, e: "e", i: 1.5, r: [] })).toString("base64url")}`,
    `ms:rp:${Buffer.from(JSON.stringify({ v: 1, e: "e", i: 1, r: [1] })).toString("base64url")}`,
    `ms:rp:${Buffer.from(JSON.stringify({ v: 1, e: "e", i: 1, r: [], extra: true })).toString("base64url")}`,
    `ms:rp:${"a".repeat(4097)}`,
  ])("rejects malformed or incompatible payload %s", (id) => {
    expect(decodeMotisRoutePatternId(id)).toBeNull();
  });

  it("rejects oversized decoded and encoded payloads", () => {
    expect(() => encodeMotisRoutePatternId("e", 1, ["x".repeat(4000)])).toThrow(RangeError);
  });
});

describe("MOTIS line references", () => {
  it("round-trips independently from route patterns", () => {
    const id = encodeMotisLineReference("epoch-42", "source-route");
    expect(id).toMatch(/^ms:ln:[A-Za-z0-9_-]+$/);
    expect(decodeMotisLineReference(id)).toEqual({ v: 1, e: "epoch-42", r: "source-route" });
    expect(decodeMotisRoutePatternId(id)).toBeNull();
    expect(validateMotisLineReferenceEpoch(id, "other")).toBeNull();
    expect(validateMotisLineReferenceEpoch(id, "epoch-42")?.r).toBe("source-route");
  });
});
