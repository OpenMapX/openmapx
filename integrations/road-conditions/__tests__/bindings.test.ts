import { ApiClientError, apiClient } from "@openmapx/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRoadConditionBindings,
  loadRoadConditionBindings,
  parseBindingDetail,
} from "../bindings";

describe("parseBindingDetail", () => {
  it("keeps well-typed bindings and a missing reason as null", () => {
    expect(
      parseBindingDetail({
        situation: { status: "exact", reason: null, confidence: 0.95 },
        effects: { "a/c": { status: "ambiguous", reason: "direction_undecided" }, "a/x": 7 },
      }),
    ).toEqual({
      situation: { status: "exact", reason: null },
      effects: { "a/c": { status: "ambiguous", reason: "direction_undecided" } },
    });
  });

  it("reads an answer without a single binding as none", () => {
    expect(parseBindingDetail({ situation: null, effects: {} })).toBeNull();
    expect(parseBindingDetail({ type: "FeatureCollection", features: [] })).toBeNull();
    expect(parseBindingDetail([])).toBeNull();
  });
});

describe("loadRoadConditionBindings", () => {
  let get: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    clearRoadConditionBindings();
    get = vi.spyOn(apiClient, "get");
  });
  afterEach(() => vi.restoreAllMocks());

  it("asks the provider of each situation once, and reuses the answer", async () => {
    get.mockResolvedValue({ situation: { status: "unresolved", reason: "no_candidates" } });
    const event = { id: "oc:situation:a b", provider: "road-conditions-openconditions" };
    const first = await loadRoadConditionBindings([event], 0);
    expect(first.get(event.id)).toEqual({
      situation: { status: "unresolved", reason: "no_candidates" },
      effects: {},
    });
    expect(get).toHaveBeenCalledWith("/api/integrations/road-conditions/bindings", {
      provider: "road-conditions-openconditions",
      id: "oc:situation:a b",
    });
    await loadRoadConditionBindings([event], 1_000);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("leaves out a situation without bindings or whose read failed, and retries a failure", async () => {
    const gone = { id: "gone", provider: "p" };
    const failing = { id: "failing", provider: "p" };
    get.mockImplementation(async (_path: string, params?: Record<string, unknown>) => {
      throw new ApiClientError(params?.id === "gone" ? 404 : 503, null, null);
    });
    expect((await loadRoadConditionBindings([gone, failing], 0)).size).toBe(0);
    await loadRoadConditionBindings([gone, failing], 1_000);
    const asked = get.mock.calls.map(([, params]) => (params as { id: string }).id);
    expect(asked.filter((id) => id === "gone")).toHaveLength(1);
    expect(asked.filter((id) => id === "failing")).toHaveLength(2);
  });

  it("never asks for a situation without a provider", async () => {
    await loadRoadConditionBindings([{ id: "x", provider: "" }], 0);
    expect(get).not.toHaveBeenCalled();
  });
});
