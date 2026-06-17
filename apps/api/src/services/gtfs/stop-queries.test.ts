import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const unsafe = vi.fn();
vi.mock("./db", () => ({ sql: { unsafe: (...args: unknown[]) => unsafe(...args) } }));

beforeEach(() => unsafe.mockReset());
afterEach(() => vi.resetModules());

const STOPS = [
  {
    stop_id: "a",
    stop_name: "Alpha",
    stop_lat: 1,
    stop_lon: 2,
    location_type: 1,
    parent_station: null,
    platform_code: null,
    route_types: [3],
  },
  {
    stop_id: "b",
    stop_name: "Beta",
    stop_lat: 3,
    stop_lon: 4,
    location_type: 0,
    parent_station: "a",
    platform_code: "1",
    route_types: null,
  },
];

describe("stop queries pass rows through unchanged", () => {
  it("getStopsInBbox returns the driver rows and issues one query", async () => {
    unsafe.mockResolvedValue(STOPS);
    vi.resetModules();
    const { getStopsInBbox } = await import("./queries");
    const rows = await getStopsInBbox("gtfs_ch", [1, 2, 3, 4], 50);
    expect(rows).toEqual(STOPS);
    expect(unsafe).toHaveBeenCalledTimes(1);
  });

  it("searchStopsByName returns the driver rows and issues one query", async () => {
    unsafe.mockResolvedValue(STOPS);
    vi.resetModules();
    const { searchStopsByName } = await import("./queries");
    const rows = await searchStopsByName("gtfs_ch", "al", 20);
    expect(rows).toEqual(STOPS);
    expect(unsafe).toHaveBeenCalledTimes(1);
  });
});
