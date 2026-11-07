import type { QueryClient } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { apiClient } from "../../../api/client";
import { createQueryWrapper, createTestQueryClient } from "../../../test/queryWrapper";
import type { LngLat } from "../../../types/geometry";
import { useTransitPlan } from "../useTransitPlan";

type Params = Parameters<typeof useTransitPlan>[0];

const ORIGIN: LngLat = [13, 52];
const DESTINATION: LngLat = [14, 53];
const envelope = { data: { provider: "synthetic", itineraries: [] }, attributions: [] };

let client: QueryClient;
let get: MockInstance<typeof apiClient.get>;

/** Wire query strings in request order. */
function wireTimes(): (string | undefined)[] {
  return get.mock.calls.map((call) => (call[1] as Record<string, string>).time);
}
function wireParams(index: number): Record<string, string> {
  return get.mock.calls[index][1] as Record<string, string>;
}
/** The shared canonical request in every cached search key carries its wire time. */
function cachedKeyTimes(): unknown[] {
  return client
    .getQueryCache()
    .findAll({ queryKey: ["transit-plan"] })
    .map((query) => (query.queryKey[1] as Record<string, unknown>).time);
}
function setup(initialProps: Params) {
  return renderHook((props: Params) => useTransitPlan(props), {
    initialProps,
    wrapper: createQueryWrapper(client),
  });
}
async function settled(count: number) {
  await waitFor(() => expect(get).toHaveBeenCalledTimes(count));
  await waitFor(() => expect(client.isFetching()).toBe(0));
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime("2026-10-23T05:20:10Z");
  client = createTestQueryClient();
  get = vi.spyOn(apiClient, "get").mockResolvedValue(envelope as never);
});
afterEach(() => {
  client.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useTransitPlan paging time", () => {
  it("keeps the initial implicit-now time for next and previous pages across minute rollover", async () => {
    const view = setup({ origin: ORIGIN, destination: DESTINATION });
    await settled(1);
    expect(wireTimes()).toEqual(["2026-10-23T05:20:00Z"]);

    vi.setSystemTime("2026-10-23T05:21:30Z");
    view.rerender({ origin: ORIGIN, destination: DESTINATION, pageToken: "next-token" });
    await settled(2);
    expect(wireParams(1)).toMatchObject({
      time: "2026-10-23T05:20:00Z",
      page_token: "next-token",
    });

    vi.setSystemTime("2026-10-23T05:22:30Z");
    view.rerender({ origin: ORIGIN, destination: DESTINATION, pageToken: "previous-token" });
    await settled(3);
    expect(wireParams(2)).toMatchObject({
      time: "2026-10-23T05:20:00Z",
      page_token: "previous-token",
    });
    // Query identity and the wire request carry the same retained time.
    expect(cachedKeyTimes()).toEqual(Array(3).fill("2026-10-23T05:20:00Z"));
    vi.setSystemTime("2026-10-23T05:23:30Z");
    view.rerender({ origin: ORIGIN, destination: DESTINATION });
    await settled(4);
    expect(wireParams(3)).toMatchObject({ time: "2026-10-23T05:23:00Z" });
    expect(wireParams(3).page_token).toBeUndefined();
  });

  it("does not freeze ordinary unpaged queries at the first render", async () => {
    const view = setup({ origin: ORIGIN, destination: DESTINATION });
    await settled(1);
    vi.setSystemTime("2026-10-23T05:21:30Z");
    view.rerender({ origin: ORIGIN, destination: DESTINATION });
    await settled(2);
    expect(wireTimes()).toEqual(["2026-10-23T05:20:00Z", "2026-10-23T05:21:00Z"]);
  });

  it("uses the current minute for changed endpoints without a token", async () => {
    const view = setup({ origin: ORIGIN, destination: DESTINATION });
    await settled(1);
    vi.setSystemTime("2026-10-23T05:21:30Z");
    view.rerender({ origin: ORIGIN, destination: [15, 54] });
    await settled(2);
    expect(wireParams(1)).toMatchObject({ time: "2026-10-23T05:21:00Z", to_lng: "15" });
  });

  it("does not let a retained time leak into a later fresh search", async () => {
    const view = setup({ origin: ORIGIN, destination: DESTINATION });
    await settled(1);
    view.rerender({ origin: ORIGIN, destination: DESTINATION, pageToken: "next-token" });
    await settled(2);
    vi.setSystemTime("2026-10-23T05:25:10Z");
    view.rerender({ origin: ORIGIN, destination: [15, 54] });
    await settled(3);
    view.rerender({ origin: ORIGIN, destination: [15, 54], pageToken: "other-token" });
    await settled(4);
    expect(wireTimes().slice(2)).toEqual(["2026-10-23T05:25:00Z", "2026-10-23T05:25:00Z"]);
  });

  it.each([
    ["departAt", { departAt: "2026-10-23T09:00:00.000Z" }, undefined],
    ["arriveBy", { arriveBy: "2026-10-23T11:30:00.000Z" }, "true"],
  ] as const)(
    "keeps explicit %s timestamps exact on a paged request",
    async (_name, time, arrive) => {
      const exact = "departAt" in time ? time.departAt : time.arriveBy;
      const view = setup({ origin: ORIGIN, destination: DESTINATION, ...time });
      await settled(1);
      vi.setSystemTime("2026-10-23T05:23:30Z");
      view.rerender({ origin: ORIGIN, destination: DESTINATION, ...time, pageToken: "next-token" });
      await settled(2);
      expect(wireTimes()).toEqual([exact, exact]);
      expect(wireParams(1).arrive_by).toBe(arrive);
      expect(cachedKeyTimes()).toEqual([exact, exact]);
    },
  );

  it("does not acquire or advance a retained time while an endpoint is missing", async () => {
    const view = setup({ origin: null, destination: DESTINATION });
    vi.setSystemTime("2026-10-23T05:21:30Z");
    view.rerender({ origin: null, destination: DESTINATION, pageToken: "next-token" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(get).not.toHaveBeenCalled();
    expect(client.isFetching()).toBe(0);
  });

  it("keeps order-independent option-list cache keys", async () => {
    const view = setup({ origin: ORIGIN, destination: DESTINATION, modes: ["TRAM", "BUS"] });
    await settled(1);
    view.rerender({ origin: ORIGIN, destination: DESTINATION, modes: ["BUS", "TRAM"] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(get).toHaveBeenCalledTimes(1);
  });
});

it("uses the shared canonical key for a provided normal plan, including persisted hills and epoch", async () => {
  const { providerPlanSelection } = await import("../../../travel-plans/__fixtures__/providerPlan");
  const { transitPlanQueryKey } = await import("../../../api/transit");
  const selection = providerPlanSelection({ bikeHillPreference: "avoid" });
  if (selection.query.kind !== "search") throw new Error("fixture");
  client.setQueryData(transitPlanQueryKey(selection.query), selection.plan);
  const params = selection.query.params;
  const view = setup({
    origin: params.origin,
    destination: params.destination,
    departAt: params.time,
    numItineraries: params.numItineraries,
    transferBuffer: params.transferBuffer,
    wheelchairRequired: params.wheelchairRequired,
    requireBikeTransport: params.requireBikeTransport,
    bikeHillPreference: params.bikeHillPreference,
    capabilityEpoch: params.capabilityEpoch,
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10);
  });
  expect(get).not.toHaveBeenCalled();
  expect(view.result.current.data).toMatchObject(selection.plan.data);
});

it("refetches the same provider reference rather than asking for normal search alternatives", async () => {
  const { providerPlanSelection } = await import("../../../travel-plans/__fixtures__/providerPlan");
  const { transitPlanQueryKey } = await import("../../../api/transit");
  const selection = providerPlanSelection();
  const reference = {
    reference: {
      datasetEpoch: "E",
      legs: [
        {
          tripId: "ms:10935",
          fromStopId: "ms:a",
          toStopId: "ms:b",
          scheduledDeparture: "2026-11-06T20:18:00.000Z",
          scheduledArrival: "2026-11-06T21:11:00.000Z",
        },
      ],
    },
  };
  client.setQueryData(
    transitPlanQueryKey({ kind: "reference", params: reference }),
    selection.plan,
  );
  const post = vi.spyOn(apiClient, "post").mockResolvedValue(selection.plan as never);
  const view = setup({ origin: [6.091, 50.768], destination: [6.959, 50.943], reference });
  await act(async () => {
    await view.result.current.refetch();
  });
  expect(get).not.toHaveBeenCalled();
  expect(post).toHaveBeenCalledWith(
    "/api/integrations/transit/plan/resolve",
    reference,
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  expect(view.result.current.data).toMatchObject(selection.plan.data);
});

it.each(["substitution", "stale", "partial", "requirements"])(
  "retains the selected reference when refetch returns %s evidence",
  async (kind) => {
    const { providerPlanSelection } = await import(
      "../../../travel-plans/__fixtures__/providerPlan"
    );
    const { transitPlanQueryKey } = await import("../../../api/transit");
    const selection = providerPlanSelection();
    const reference = {
      reference: {
        datasetEpoch: "E",
        legs: [
          {
            tripId: "ms:10935",
            fromStopId: "ms:a",
            toStopId: "ms:b",
            scheduledDeparture: "2026-11-06T20:18:00.000Z",
            scheduledArrival: "2026-11-06T21:11:00.000Z",
          },
        ],
      },
      wheelchairRequired: true,
    };
    client.setQueryData(
      transitPlanQueryKey({ kind: "reference", params: reference }),
      selection.plan,
    );
    const changed = structuredClone(selection.plan);
    if (kind === "substitution") changed.data.itineraries[0].legs[0].tripId = "ms:another";
    if (kind === "stale") changed.freshness.isStale = true;
    if (kind === "partial") changed.freshness.isPartial = true;
    if (kind === "requirements") changed.data.itineraries[0].legs[0].wheelchairAccessible = false;
    vi.spyOn(apiClient, "post").mockResolvedValue(changed as never);
    const view = setup({ origin: ORIGIN, destination: DESTINATION, reference });
    await act(async () => {
      await view.result.current.refetch();
    });
    await waitFor(() => expect(view.result.current.isError).toBe(true));
    expect(view.result.current.data).toMatchObject(selection.plan.data);
    expect(get).not.toHaveBeenCalled();
  },
);
