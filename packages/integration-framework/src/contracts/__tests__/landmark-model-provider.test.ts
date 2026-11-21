import { describe, expect, it } from "vitest";
import {
  assertLandmarkModelProviderContract,
  type LandmarkModelProvider,
} from "../landmark-model-provider.js";

function provider(overrides: Partial<LandmarkModelProvider> = {}): LandmarkModelProvider {
  return {
    id: "p",
    sourceIds: ["a"],
    snapshot: () => null,
    fetchModelGzip: async () => ({ status: "unlisted" }),
    ...overrides,
  };
}

describe("assertLandmarkModelProviderContract", () => {
  it("accepts a provider whose id and sourceIds match", () => {
    expect(() =>
      assertLandmarkModelProviderContract(provider(), "p", new Set(["a", "osm"])),
    ).not.toThrow();
  });

  it("rejects a provider id that differs from the integration id", () => {
    expect(() => assertLandmarkModelProviderContract(provider(), "other", new Set(["a"]))).toThrow(
      /landmark-models provider id/,
    );
  });

  it("rejects undeclared source ids", () => {
    expect(() =>
      assertLandmarkModelProviderContract(provider({ sourceIds: ["a", "b"] }), "p", new Set(["a"])),
    ).toThrow(/undeclared source "b"/);
  });

  it("rejects an empty sourceIds list", () => {
    expect(() =>
      assertLandmarkModelProviderContract(provider({ sourceIds: [] }), "p", new Set(["a"])),
    ).toThrow();
  });
});
