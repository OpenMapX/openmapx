import type { Itinerary, PlanResponse } from "@motis-project/motis-client";
import { describe, expect, it, vi } from "vitest";
import { diversifyPlan, regionalModes } from "../plan-diversity.js";

function trip(id: string, mode: string, start: string): Itinerary {
  return {
    id,
    startTime: start,
    endTime: "2026-11-06T22:00:00Z",
    duration: 60,
    transfers: 0,
    legs: [
      {
        mode,
        tripId: id,
        routeShortName: id,
        startTime: start,
        endTime: "2026-11-06T22:00:00Z",
        from: { stopId: "a", lat: 1, lon: 2 },
        to: { stopId: "b", lat: 2, lon: 3 },
      },
    ],
  } as Itinerary;
}
const ice = trip("ice319", "HIGHSPEED_RAIL", "2026-11-06T21:06:00Z");
const re1 = trip("re1-26839", "REGIONAL_RAIL", "2026-11-06T20:51:00Z");
const re9 = trip("re9", "REGIONAL_RAIL", "2026-11-06T21:18:00Z");
const page = (itineraries: Itinerary[], previous = "EARLIER|1", next = "LATER|2") =>
  ({
    itineraries,
    direct: [],
    previousPageCursor: previous,
    nextPageCursor: next,
  }) as unknown as PlanResponse;
const query = { fromPlace: "1,2", toPlace: "2,3", time: "2026-11-06T20:41:00Z", numItineraries: 3 };
const options = { enabled: true, instance: "mo", epoch: "" };

describe("MOTIS regional diversity", () => {
  it("retains overtaken RE1 alongside ICE, keeping primary duplicates and all returned journeys", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ data: page([ice, re9]) })
      .mockResolvedValueOnce({ data: page([re1, { ...re9, id: "duplicate" }]) });
    const result = await diversifyPlan(query, run, options);
    expect(result?.data.itineraries.map((it) => it.id)).toEqual(["re1-26839", "ice319", "re9"]);
    expect(result?.data.itineraries[2]).toBe(re9);
    expect(result?.supplemented).toBe(true);
  });
  it.each([
    [undefined, true],
    [["RAIL"], true],
    [["BUS"], false],
    [["HIGHSPEED_RAIL"], false],
    [["REGIONAL_RAIL"], false],
  ])("intersects modes without widening %s", (modes, eligible) => {
    expect(Boolean(regionalModes(modes as string[] | undefined))).toBe(eligible);
  });
  it("forwards restrictions and arrive-by while omitting regional direct modes", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ data: page([ice]) })
      .mockResolvedValueOnce({ data: page([re1]) });
    const constraints = {
      ...query,
      arriveBy: true,
      pedestrianProfile: "WHEELCHAIR",
      requireBikeTransport: true,
      maxTransfers: 0,
      minTransferTime: 3,
      additionalTransferTime: 2,
      preTransitModes: ["BIKE"],
      postTransitModes: ["WALK"],
      directModes: ["BIKE"],
      preTransitRentalProviders: ["x"],
    } as never;
    await diversifyPlan(constraints, run, options);
    expect(run.mock.calls[1][0]).toMatchObject({
      arriveBy: true,
      pedestrianProfile: "WHEELCHAIR",
      requireBikeTransport: true,
      maxTransfers: 0,
      preTransitModes: ["BIKE"],
      preTransitRentalProviders: ["x"],
      minTransferTime: 3,
    });
    expect(run.mock.calls[1][0].directModes).toBeUndefined();
    expect(run.mock.calls[1][1]).toBeInstanceOf(AbortSignal);
  });
  it.each([false, true])(
    "does not supplement disabled or local-only results (%s)",
    async (enabled) => {
      const run = vi.fn().mockResolvedValue({ data: page([enabled ? re1 : ice]) });
      await diversifyPlan(query, run, { ...options, enabled });
      expect(run).toHaveBeenCalledTimes(1);
    },
  );
  it.each([{ error: "failed" }, { data: {} }, { response: { ok: false } }])(
    "keeps primary when the regional response fails",
    async (failure) => {
      const run = vi
        .fn()
        .mockResolvedValueOnce({ data: page([ice]) })
        .mockResolvedValueOnce(failure);
      const result = await diversifyPlan(query, run, options);
      expect(result?.data.itineraries).toEqual([ice]);
      expect(result?.supplemented).toBe(false);
    },
  );
  it("pages independently, retains exhausted lanes for reverse direction, and rejects other epochs", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ data: page([ice], "P-prev", "P-next") })
      .mockResolvedValueOnce({ data: page([re1], "R-prev", "R-next") });
    const first = await diversifyPlan(query, run, options);
    run
      .mockReset()
      .mockResolvedValueOnce({ data: page([ice], "P-back", "") })
      .mockResolvedValueOnce({ data: page([re1], "R-back", "R-more") });
    const second = await diversifyPlan(
      { ...query, pageCursor: first!.data.nextPageCursor },
      run,
      options,
    );
    expect(run.mock.calls.map((c) => c[0].pageCursor)).toEqual(["P-next", "R-next"]);
    run.mockReset().mockResolvedValueOnce({ data: page([re1], "R-return", "") });
    const third = await diversifyPlan(
      { ...query, pageCursor: second!.data.nextPageCursor },
      run,
      options,
    );
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0].pageCursor).toBe("R-more");
    run.mockReset().mockResolvedValue({ data: page([]) });
    await diversifyPlan({ ...query, pageCursor: third!.data.previousPageCursor }, run, options);
    expect(run.mock.calls.map((c) => c[0].pageCursor)).toEqual(["P-back", "R-return"]);
    await expect(
      diversifyPlan({ ...query, pageCursor: first!.data.nextPageCursor }, run, {
        ...options,
        epoch: "new",
      }),
    ).rejects.toThrow();
  });
  it("uses legacy raw cursors on the primary only", async () => {
    const run = vi.fn().mockResolvedValue({ data: page([ice]) });
    await diversifyPlan({ ...query, pageCursor: "LATER|42" }, run, options);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0].pageCursor).toBe("LATER|42");
  });
});

it("does not discard journeys when MOTIS returns more than numItineraries", async () => {
  const extra = trip("extra", "REGIONAL_RAIL", "2026-11-06T21:30:00Z");
  const run = vi
    .fn()
    .mockResolvedValueOnce({ data: page([ice, re9]) })
    .mockResolvedValueOnce({ data: page([re1, extra]) });
  const result = await diversifyPlan({ ...query, numItineraries: 1 }, run, options);
  expect(result?.data.itineraries).toHaveLength(4);
});
it("rejects corrupt composite cursors and does not hide primary transport failures", async () => {
  const run = vi.fn().mockRejectedValue(new Error("transport"));
  await expect(diversifyPlan(query, run, options)).rejects.toThrow("transport");
  await expect(
    diversifyPlan({ ...query, pageCursor: "omxmotis1.invalid" }, run, options),
  ).rejects.toThrow("Invalid MOTIS");
  await expect(
    diversifyPlan({ ...query, pageCursor: "omxmotis1." + "x".repeat(4096) }, run, options),
  ).rejects.toThrow("Invalid MOTIS");
});
it("reports failure when the primary is exhausted and the regional page fails", async () => {
  const run = vi
    .fn()
    .mockResolvedValueOnce({ data: page([ice], "", "") })
    .mockResolvedValueOnce({ data: page([re1], "", "R-next") });
  const first = await diversifyPlan(query, run, options);
  run.mockReset().mockRejectedValue(new Error("regional offline"));
  await expect(
    diversifyPlan({ ...query, pageCursor: first?.data.nextPageCursor }, run, options),
  ).rejects.toThrow("page unavailable");
});

it("keeps primary journeys when the supplement contains malformed itinerary records", async () => {
  const run = vi
    .fn()
    .mockResolvedValueOnce({ data: page([ice]) })
    .mockResolvedValueOnce({ data: { itineraries: [{}] } });
  const result = await diversifyPlan(query, run, options);
  expect(result?.data.itineraries).toEqual([ice]);
});

it("does not reject the primary's entire response because one record has no legs", async () => {
  const primary = page([ice, { ...re1, legs: [] }]);
  const run = vi.fn().mockResolvedValue({ data: primary });
  const result = await diversifyPlan(query, run, { ...options, enabled: false });
  expect(result?.data).toBe(primary);
});
it("keeps the regional cursor retryable after a failed page while primary succeeds", async () => {
  const run = vi
    .fn()
    .mockResolvedValueOnce({ data: page([ice], "P-prev", "P-next") })
    .mockResolvedValueOnce({ data: page([re1], "R-prev", "R-next") });
  const first = await diversifyPlan(query, run, options);
  run
    .mockReset()
    .mockResolvedValueOnce({ data: page([ice], "P-back", "P-more") })
    .mockRejectedValueOnce(new Error("regional down"));
  const second = await diversifyPlan(
    { ...query, pageCursor: first?.data.nextPageCursor },
    run,
    options,
  );
  expect(second?.data.itineraries).toEqual([ice]);
  run.mockReset().mockResolvedValue({ data: page([]) });
  await diversifyPlan({ ...query, pageCursor: second?.data.nextPageCursor }, run, options);
  expect(run.mock.calls.map((c) => c[0].pageCursor)).toEqual(["P-more", "R-next"]);
});

it("aborts an unresponsive optional request and keeps successful primary journeys", async () => {
  let aborted = false;
  const run = vi.fn(async (_query: unknown, signal?: AbortSignal) => {
    if (!signal) return { data: page([ice]) };
    return await new Promise<never>((_resolve, reject) => {
      const abort = () => {
        aborted = true;
        reject(signal.reason);
      };
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
  });
  const result = await diversifyPlan(query, run, options);
  expect(aborted).toBe(true);
  expect(result?.data.itineraries).toEqual([ice]);
});

it("does not enable regional labels when the extra window adds no distinct journeys", async () => {
  const run = vi
    .fn()
    .mockResolvedValueOnce({ data: page([ice, re9]) })
    .mockResolvedValueOnce({ data: page([{ ...re9, id: "duplicate" }]) });
  const result = await diversifyPlan(query, run, options);
  expect(result?.data.itineraries).toEqual([ice, re9]);
  expect(result?.supplemented).toBe(false);
  expect(result?.data.nextPageCursor).toMatch(/^omxmotis1\./);
});
