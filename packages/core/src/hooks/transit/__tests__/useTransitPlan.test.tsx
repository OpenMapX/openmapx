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
/** The time segment of every cached plan query key (index 3 of the key). */
function cachedKeyTimes(): unknown[] {
  return client
    .getQueryCache()
    .findAll({ queryKey: ["transit-plan"] })
    .map((query) => query.queryKey[3]);
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
  });

  it("starts a fresh query at the current minute once the token is cleared", async () => {
    const view = setup({ origin: ORIGIN, destination: DESTINATION });
    await settled(1);
    vi.setSystemTime("2026-10-23T05:21:30Z");
    view.rerender({ origin: ORIGIN, destination: DESTINATION, pageToken: "next-token" });
    await settled(2);

    vi.setSystemTime("2026-10-23T05:22:30Z");
    view.rerender({ origin: ORIGIN, destination: DESTINATION });
    await settled(3);
    expect(wireTimes()).toEqual([
      "2026-10-23T05:20:00Z",
      "2026-10-23T05:20:00Z",
      "2026-10-23T05:22:00Z",
    ]);
    expect(wireParams(2).page_token).toBeUndefined();
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
