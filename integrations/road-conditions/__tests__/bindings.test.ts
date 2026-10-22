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
  const fetchMock = vi.fn();
  beforeEach(() => {
    clearRoadConditionBindings();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("asks the provider of each situation once, and reuses the answer", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ situation: { status: "unresolved", reason: "no_candidates" } }),
    });
    const event = { id: "oc:situation:a b", provider: "road-conditions-openconditions" };
    const first = await loadRoadConditionBindings("https://api.test/", [event], 0);
    expect(first.get(event.id)).toEqual({
      situation: { status: "unresolved", reason: "no_candidates" },
      effects: {},
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.test/api/integrations/road-conditions/bindings?provider=road-conditions-openconditions&id=oc%3Asituation%3Aa+b",
      { credentials: "include" },
    );
    await loadRoadConditionBindings("https://api.test", [event], 1_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("leaves out a situation without bindings or whose read failed, and retries a failure", async () => {
    const gone = { id: "gone", provider: "p" };
    const failing = { id: "failing", provider: "p" };
    fetchMock.mockImplementation(async (url: string) =>
      url.includes("id=gone") ? { ok: false, status: 404 } : { ok: false, status: 503 },
    );
    expect((await loadRoadConditionBindings("", [gone, failing], 0)).size).toBe(0);
    await loadRoadConditionBindings("", [gone, failing], 1_000);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("id=gone"))).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("id=failing"))).toHaveLength(
      2,
    );
  });

  it("never asks for a situation without a provider", async () => {
    await loadRoadConditionBindings("", [{ id: "x", provider: "" }], 0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
