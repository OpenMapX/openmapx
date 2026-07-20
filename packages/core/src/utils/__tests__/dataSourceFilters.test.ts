import { describe, expect, it } from "vitest";
import type { DataSourceResult } from "../../types/dataSource";
import { applyClientSideFilters } from "../dataSourceFilters";

function makeResult(overrides: Partial<DataSourceResult> & { id: string }): DataSourceResult {
  return {
    name: overrides.id,
    coordinates: [0, 0],
    source: "ev-charging",
    variant: "default",
    ...overrides,
  };
}

describe("applyClientSideFilters", () => {
  describe("available_now", () => {
    it("keeps only results with a free EVSE when active", () => {
      const results = [
        makeResult({ id: "a", availability: { available: 0, total: 2 } }),
        makeResult({ id: "b", availability: { available: 1, total: 2 } }),
        makeResult({ id: "c" }), // static, no availability data
      ];

      const out = applyClientSideFilters(results, { available_now: true });

      expect(out.map((r) => r.id)).toEqual(["b"]);
    });

    it("excludes results with no availability data", () => {
      const results = [
        makeResult({ id: "a" }),
        makeResult({ id: "b", availability: { available: 3, total: 3 } }),
      ];

      const out = applyClientSideFilters(results, { available_now: true });

      expect(out.map((r) => r.id)).toEqual(["b"]);
    });

    it("leaves results unchanged when unset", () => {
      const results = [
        makeResult({ id: "a", availability: { available: 0, total: 2 } }),
        makeResult({ id: "b" }),
      ];

      const out = applyClientSideFilters(results, {});

      expect(out).toEqual(results);
    });

    it("leaves results unchanged when explicitly false", () => {
      const results = [
        makeResult({ id: "a", availability: { available: 0, total: 2 } }),
        makeResult({ id: "b" }),
      ];

      const out = applyClientSideFilters(results, { available_now: false });

      expect(out).toEqual(results);
    });
  });
});
