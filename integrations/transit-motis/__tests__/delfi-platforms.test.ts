import { createMotisInstance } from "@openmapx/mobility-core/motis-client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import fixture from "./fixtures/re1-26839-transitous-trip.json";

const { trip } = vi.hoisted(() => ({ trip: vi.fn() }));
vi.mock("@motis-project/motis-client", async (original) => ({
  ...(await original<typeof import("@motis-project/motis-client")>()),
  trip,
}));

import { getTrip, motisPlaceToJourneyStop, normalizeStop } from "../adapter";
import { delfiStationRoot } from "../delfi-platforms";

const instance = createMotisInstance({
  baseUrl: "http://motis.test",
  prefix: "mo:",
  provider: "mo",
});

describe("DELFI passenger platforms", () => {
  beforeEach(() => trip.mockReset());
  it.each([
    ["de:05362:87303:2:23", "37"],
    ["de:05315:14201:7:73", "78"],
    ["de:05315:11901:7:74", "87"],
    ["de:05315:19201:7:73", "81"],
    ["de:05316:21101:7:75", "80"],
  ])("withholds the proven bad code at %s without inventing a replacement", (id, code) => {
    const place = {
      name: "Station",
      lat: 50,
      lon: 6,
      stopId: `de-DELFI_${id}`,
      track: code,
      scheduledTrack: code,
    };
    expect(normalizeStop(instance, place).platformCode).toBeUndefined();
    expect(motisPlaceToJourneyStop(instance, place)).toMatchObject({
      platform: undefined,
      scheduledPlatform: undefined,
    });
    expect(motisPlaceToJourneyStop(instance, { ...place, track: "3" })).toMatchObject({
      platform: "3",
      scheduledPlatform: undefined,
    });
    expect(normalizeStop(instance, { ...place, stopId: `other_${id}` }).platformCode).toBe(code);
    expect(
      normalizeStop(instance, { ...place, stopId: "de-DELFI_de:05334:1008" }).platformCode,
    ).toBe(code);
  });
  it("extracts only validated DELFI station roots", () => {
    expect(delfiStationRoot("de-DELFI_de:05315:14201:7:73")).toBe("de:05315:14201");
    expect(delfiStationRoot("de_DELFI_de:05334:1008")).toBe("de:05334:1008");
    for (const id of [
      "other_de:05334:1008",
      "de-DELFI_de:05334:1008_G",
      "8000000",
      "de-DELFI_de:12:3",
    ])
      expect(delfiStationRoot(id)).toBeUndefined();
  });
  it("binds the real single-leg fixture to its service date and train number", async () => {
    trip.mockResolvedValue({ data: fixture });
    const journey = await getTrip(instance, "mo:20261106_21:51_de-DELFI_3469151921");
    expect(journey?.identity).toEqual({
      serviceDate: "2026-11-06",
      trainNumber: "26839",
      lineName: "RE1",
      routeId: "de-DELFI_de:nrw:re1:_100",
      feedTag: "de-DELFI",
    });
    expect(journey?.stops[6].platform).toBeUndefined();
    expect(journey?.stops[7].platform).toBeUndefined();
  });
  it.each(["multi-leg", "unknown-feed", "train-name", "wrong-source"])(
    "does not authorize enrichment for %s",
    async (reason) => {
      const data = structuredClone(fixture);
      if (reason === "multi-leg") data.legs.push(data.legs[0]);
      if (reason === "train-name") data.legs[0].tripShortName = "RE1";
      if (reason === "wrong-source") data.legs[0].source = "other.gtfs.zip/stop_times.txt:1:2";
      trip.mockResolvedValue({ data });
      expect(
        (
          await getTrip(
            instance,
            reason === "unknown-feed"
              ? "20261106_21:51_other_123"
              : "20261106_21:51_de-DELFI_3469151921",
          )
        )?.identity,
      ).toBeUndefined();
    },
  );
});

it("records a correction diagnostic when only the current bad track was withheld", () => {
  const stop = motisPlaceToJourneyStop(instance, {
    stopId: "de-DELFI_de:05362:87303:2:23",
    name: "Horrem",
    lat: 50,
    lon: 6,
    track: "37",
  });
  expect(stop.platform).toBeUndefined();
  expect(stop.platformQuarantined).toBe(true);
});
