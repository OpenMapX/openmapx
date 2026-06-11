import type { TransitStop } from "@openmapx/mobility-core/transit";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockOneToAll = vi.fn();
vi.mock("@motis-project/motis-client", () => ({
  oneToAll: (...args: unknown[]) => mockOneToAll(...args),
  geocode: vi.fn(),
  routes: vi.fn(),
  stops: vi.fn(),
  trip: vi.fn(),
  plan: vi.fn(),
  stoptimes: vi.fn(),
  trips: vi.fn(),
}));

import { getReachable } from "../adapter.js";

const instance = {
  client: {} as never,
  prefix: "mo:",
  provider: "transit-motis-transitous",
} as never;

describe("getReachable — one-to-all duration is minutes", () => {
  beforeEach(() => {
    mockOneToAll.mockReset();
  });

  it("passes duration through as minutes (does NOT divide by 60)", async () => {
    mockOneToAll.mockResolvedValue({
      data: {
        all: [
          {
            place: { stopId: "8011160", name: "Berlin Hbf", lat: 52.525, lon: 13.369, modes: [] },
            duration: 13,
            k: 1,
          },
          {
            place: {
              stopId: "900003201",
              name: "S Hackescher Markt",
              lat: 52.522,
              lon: 13.402,
              modes: [],
            },
            duration: 28,
            k: 2,
          },
        ],
      },
    });

    const stops: TransitStop[] = await getReachable(instance, 52.5163, 13.3777, 30);

    expect(stops).toHaveLength(2);
    expect(stops[0].reachMinutes).toBe(13);
    expect(stops[0].reachTransfers).toBe(0);
    expect(stops[1].reachMinutes).toBe(28);
    expect(stops[1].reachTransfers).toBe(1);
  });

  it("returns [] when the response has no reachable stops", async () => {
    mockOneToAll.mockResolvedValue({ data: { all: [] } });
    expect(await getReachable(instance, 0, 0, 30)).toEqual([]);
  });
});
