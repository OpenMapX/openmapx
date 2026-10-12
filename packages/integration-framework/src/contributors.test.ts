import type { Attribution } from "@openmapx/mobility-core/attribution";
import { describe, expect, it } from "vitest";
import { resolveContributors, resolveSourceContributors } from "./contributors";

const a: Attribution = { sourceId: "a", name: "A", publisher: { name: "Original" } };
const resolver = (id: string) => (id === "a" ? a : undefined);

describe("exact contributor resolution", () => {
  it("resolves only explicitly named identities and copies metadata", () => {
    const result = resolveSourceContributors(["unknown", "a", "a"], resolver);
    expect(result).toEqual([a]);
    expect(result[0]).not.toBe(a);
    expect(result[0].publisher).not.toBe(a.publisher);
    expect(resolveSourceContributors(["unknown"], resolver)).toEqual([]);
  });
  it("prefers an authoritative snapshot including empty over current catalogue metadata", () => {
    const captured = { sourceId: "a", name: "Captured notice" };
    expect(resolveContributors({ contributors: [captured], sourceIds: ["a"] }, resolver)).toEqual([
      captured,
    ]);
    expect(resolveContributors({ contributors: [], sourceIds: ["a"] }, resolver)).toEqual([]);
  });
  it("uses only explicit legacy identities when a receipt is missing or malformed", () => {
    expect(resolveContributors({ sourceIds: ["a", "missing"] }, resolver)).toEqual([a]);
    expect(resolveContributors({ contributors: "bad", sourceIds: ["a"] }, resolver)).toEqual([a]);
    expect(resolveContributors({}, resolver)).toEqual([]);
  });
});
