import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ oneToAll: vi.fn(), oneToMany: vi.fn() }));
vi.mock("@motis-project/motis-client", () => ({
  oneToAll: mocks.oneToAll,
  oneToManyIntermodalPost: mocks.oneToMany,
}));

import { TRANSIT_WALK_PROFILE } from "@openmapx/mobility-core/transit-reachability";
import {
  checkMotisReachabilityDestinations,
  getMotisReachabilitySeeds,
  resolveMotisReachabilityCapabilities,
} from "../reachability.js";

const instance = { client: {}, prefix: "ms:", provider: "ms" } as never;
const base = {
  origin: { lng: 13.4, lat: 52.5 },
  queryTime: "2026-08-29T08:31:00.000Z",
  direction: "depart-at" as const,
  thresholdsMinutes: [15, 30],
  transitModes: ["BUS"],
  walkProfileId: TRANSIT_WALK_PROFILE.id,
};

describe("MOTIS reachability", () => {
  beforeEach(() => {
    mocks.oneToAll.mockReset();
    mocks.oneToMany.mockReset();
  });

  it("maps one-to-all minutes to seconds and sends fixed walking semantics", async () => {
    mocks.oneToAll.mockResolvedValue({
      data: {
        all: [
          {
            place: { stopId: "s1", name: "Stop", lat: 52.51, lon: 13.41, modes: ["BUS"] },
            duration: 12,
          },
        ],
      },
    });
    const seeds = await getMotisReachabilitySeeds(instance, base);
    expect(seeds).toEqual([
      expect.objectContaining({ arrivalSeconds: 720, lat: 52.51, lng: 13.41 }),
    ]);
    expect(mocks.oneToAll).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.objectContaining({
          time: base.queryTime,
          maxTravelTime: 30,
          pedestrianSpeed: 1.2,
          maxPreTransitTime: 900,
          maxPostTransitTime: 900,
        }),
      }),
    );
  });

  it("uses sequential batches, preserves ids, and chooses the best duration", async () => {
    let active = 0;
    let peak = 0;
    mocks.oneToMany.mockImplementation(async (options: { body: { many: string[] } }) => {
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
      return {
        data: {
          street_durations: options.body.many.map(() => ({ duration: 1_200 })),
          transit_durations: options.body.many.map(() => [{ duration: 600, transfers: 1 }]),
        },
      };
    });
    const destinations = Array.from({ length: 129 }, (_, index) => ({
      id: `d${index}`,
      lat: 52.5,
      lng: 13.4 + index / 100_000,
    }));
    const result = await checkMotisReachabilityDestinations(
      instance,
      { ...base, destinations },
      128,
    );
    expect(mocks.oneToMany).toHaveBeenCalledTimes(2);
    expect(peak).toBe(1);
    expect(result.results.map(({ id }) => id)).toEqual(destinations.map(({ id }) => id));
    expect(result.results[0]).toEqual({ id: "d0", durationSeconds: 600, reachable: true });
    expect(mocks.oneToMany).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          time: base.queryTime,
          pedestrianProfile: "FOOT",
          pedestrianSpeed: 1.2,
          maxPreTransitTime: 900,
          maxPostTransitTime: 900,
          maxDirectTime: 900,
        }),
      }),
    );
  });

  it("rejects the whole check when a later batch is invalid", async () => {
    mocks.oneToMany
      .mockResolvedValueOnce({ data: { street_durations: [{}], transit_durations: [[]] } })
      .mockResolvedValueOnce({ data: { street_durations: [], transit_durations: [] } });
    await expect(
      checkMotisReachabilityDestinations(
        instance,
        {
          ...base,
          destinations: [
            { id: "a", lat: 52.5, lng: 13.4 },
            { id: "b", lat: 52.6, lng: 13.5 },
          ],
        },
        1,
      ),
    ).rejects.toMatchObject({ code: "invalid-response" });
  });

  it("honours caller cancellation before starting the next batch", async () => {
    const controller = new AbortController();
    mocks.oneToMany.mockImplementationOnce(async () => {
      controller.abort();
      return { data: { street_durations: [{}], transit_durations: [[]] } };
    });
    await expect(
      checkMotisReachabilityDestinations(
        instance,
        {
          ...base,
          destinations: [
            { id: "a", lat: 52.5, lng: 13.4 },
            { id: "b", lat: 52.6, lng: 13.5 },
          ],
        },
        1,
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: "timeout" });
    expect(mocks.oneToMany).toHaveBeenCalledOnce();
  });

  it("fails closed unless local, opted in, and verified", () => {
    const observed = {
      hasStreetRouting: true,
      maxOneToManySize: 128,
      maxOneToAllTravelTimeMinutes: 90,
      maxPrePostTransitSeconds: 900,
      maxDirectSeconds: 900,
      oneToManyIntermodalVerified: true,
    };
    expect(
      resolveMotisReachabilityCapabilities({
        source: "self-hosted-motis",
        runtimeHealthy: true,
        operatorEnabled: true,
        observed,
      }).exactPointChecks,
    ).toBe(true);
    expect(
      resolveMotisReachabilityCapabilities({
        source: "transitous",
        runtimeHealthy: true,
        operatorEnabled: true,
        observed,
      }),
    ).toMatchObject({ exactPointChecks: false, exactPointCheckReason: "hosted-source" });
    expect(
      resolveMotisReachabilityCapabilities({
        source: "self-hosted-motis",
        runtimeHealthy: true,
        operatorEnabled: false,
        observed,
      }),
    ).toMatchObject({ exactPointChecks: false, exactPointCheckReason: "operator-disabled" });

    for (const [label, options, reason] of [
      ["old snapshot", { observed: undefined }, "street-routing-disabled"],
      [
        "canary failure",
        { observed: { ...observed, oneToManyIntermodalVerified: false } },
        "endpoint-unverified",
      ],
      [
        "no street routing",
        { observed: { ...observed, hasStreetRouting: false } },
        "street-routing-disabled",
      ],
      ["runtime failure", { runtimeHealthy: false, observed }, "runtime-unhealthy"],
      [
        "insufficient direct cap",
        { observed: { ...observed, maxDirectSeconds: 899 } },
        "endpoint-unverified",
      ],
    ] as const) {
      expect(
        resolveMotisReachabilityCapabilities({
          source: "self-hosted-motis",
          runtimeHealthy: options.runtimeHealthy ?? true,
          operatorEnabled: true,
          observed: options.observed,
        }),
        label,
      ).toMatchObject({ exactPointChecks: false, exactPointCheckReason: reason });
    }
  });
});
