import type { TripSegment } from "@motis-project/motis-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getMotisVehicleRadar,
  interpolateAlong,
  tripSegmentsToVehicles,
} from "../src/motis-radar.js";
import { encodePolyline } from "../src/polyline.js";
import { createMotisInstance } from "../src/server/motis-client.js";

const { trips } = vi.hoisted(() => ({ trips: vi.fn() }));
vi.mock("@motis-project/motis-client", () => ({ trips }));

const NOW = new Date("2026-08-31T12:00:00.000Z").getTime();

function segment(overrides: Partial<TripSegment> = {}): TripSegment {
  return {
    departure: new Date(NOW - 60_000).toISOString(),
    arrival: new Date(NOW + 60_000).toISOString(),
    mode: "BUS",
    polyline: encodePolyline(
      [
        [8, 50],
        [9, 50],
      ],
      6,
    ),
    trips: [{ tripId: "trip-1", routeShortName: "42" }],
    ...overrides,
  } as TripSegment;
}

describe("MOTIS radar conversion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("interpolates coordinates and bearing along a polyline", () => {
    expect(
      interpolateAlong(
        [
          [0, 0],
          [1, 0],
        ],
        0.5,
      ),
    ).toMatchObject({ lng: 0.5, lat: 0, bearing: 90 });
  });

  it("uses instance prefixes and provider ids and keeps one position per trip", () => {
    const vehicles = tripSegmentsToVehicles(
      { prefix: "ms:", provider: "ms", precision: 6, nowMs: NOW },
      [segment(), segment()],
    );

    expect(vehicles).toHaveLength(1);
    expect(vehicles[0]).toMatchObject({
      id: "ms:trip-1",
      provider: "ms",
      tripId: "ms:trip-1",
      mode: "bus",
      label: "42",
      lat: 50,
      lng: 8.5,
      updatedAt: "2026-08-31T12:00:00.000Z",
    });
    expect(vehicles[0]?.bearing).toBeCloseTo(90, 0);
  });

  it("requests active map trips with the instance client", async () => {
    trips.mockResolvedValueOnce({ data: [segment()] });
    const instance = createMotisInstance({
      baseUrl: "https://motis.example",
      prefix: "mo:",
      provider: "mo",
    });

    const result = await getMotisVehicleRadar(instance, [7, 49, 10, 51], 12);

    expect(trips).toHaveBeenCalledWith({
      client: instance.client,
      query: {
        min: "49,7",
        max: "51,10",
        startTime: "2026-08-31T11:59:00.000Z",
        endTime: "2026-08-31T12:01:00.000Z",
        zoom: 12,
        precision: 6,
      },
    });
    expect(result[0]).toMatchObject({ id: "mo:trip-1", provider: "mo" });
  });

  it("returns an empty list for empty responses and request errors", async () => {
    const instance = createMotisInstance({
      baseUrl: "https://motis.example",
      prefix: "ms:",
      provider: "ms",
    });
    trips.mockResolvedValueOnce({ data: null }).mockRejectedValueOnce(new Error("offline"));

    await expect(getMotisVehicleRadar(instance, [7, 49, 10, 51])).resolves.toEqual([]);
    await expect(getMotisVehicleRadar(instance, [7, 49, 10, 51])).resolves.toEqual([]);
  });
});
