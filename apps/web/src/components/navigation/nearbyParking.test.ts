import type { CategoryPlace, DataSourceResult } from "@openmapx/core";
import { describe, expect, it } from "vitest";
import { fromParkingSourceResult, fromPlaceSearch } from "./nearbyParking";

const NOW = Date.parse("2026-11-03T22:30:00Z");
const CURRENT = new Date(NOW + 60_000).toISOString();

function site(over: Partial<DataSourceResult> = {}): DataSourceResult {
  return {
    id: "oc:feature:osm-parking:way/1",
    name: "Garage",
    coordinates: [8.4, 49.01],
    source: "osm-parking",
    variant: "available",
    contributors: [{ sourceId: "osm-parking", name: "OpenStreetMap" }],
    ...over,
  };
}

function place(over: Partial<CategoryPlace> = {}): CategoryPlace {
  return { id: "osm:way/1", name: "Lot", coordinates: [8.4, 49.01], ...over };
}

describe("fromParkingSourceResult", () => {
  it("keeps a site's credits, free-space line, fee and access", () => {
    const summary = { $t: "summary.spacesOf", values: { free: 92, capacity: 190 } };
    expect(fromParkingSourceResult(site({ summary, fee: "paid", access: "customers" }))).toEqual({
      id: "oc:feature:osm-parking:way/1",
      name: "Garage",
      coordinates: [8.4, 49.01],
      category: "parking",
      contributors: [{ sourceId: "osm-parking", name: "OpenStreetMap" }],
      summary,
      fee: "paid",
      access: "customers",
    });
  });

  it("marks a site full only on a current reading of no space", () => {
    expect(fromParkingSourceResult(site({ variant: "full" }))?.full).toBe(true);
    expect(fromParkingSourceResult(site({ variant: "unknown" }))).not.toHaveProperty("full");
  });

  it("leaves out closed sites and those kept for others", () => {
    expect(fromParkingSourceResult(site({ status: "non-operational" }))).toBeNull();
    for (const access of ["permit", "private", "restricted"] as const) {
      expect(fromParkingSourceResult(site({ access }))).toBeNull();
    }
    for (const access of ["public", "customers", undefined] as const) {
      expect(fromParkingSourceResult(site({ access }))).not.toBeNull();
    }
  });
});

describe("fromPlaceSearch", () => {
  it("reads the fee and access OSM records", () => {
    expect(fromPlaceSearch(place({ osmTags: { fee: "no" } }), NOW)).toMatchObject({ fee: "free" });
    expect(fromPlaceSearch(place({ osmTags: { fee: "yes" } }), NOW)).toMatchObject({ fee: "paid" });
    expect(fromPlaceSearch(place({ osmTags: { access: "customers" } }), NOW)).toMatchObject({
      access: "customers",
    });
    const plain = fromPlaceSearch(place(), NOW);
    expect(plain).not.toHaveProperty("fee");
    expect(plain).not.toHaveProperty("access");
  });

  it("leaves out private, permit-only and destination-only places", () => {
    for (const access of ["private", "no", "permit", "destination", "delivery"]) {
      expect(fromPlaceSearch(place({ osmTags: { access } }), NOW)).toBeNull();
    }
    for (const access of ["yes", "permissive", "customers", "something_new"]) {
      expect(fromPlaceSearch(place({ osmTags: { access } }), NOW)).not.toBeNull();
    }
  });

  it("leaves out a mapped space kept for one group", () => {
    expect(fromPlaceSearch(place({ osmTags: { parking_space: "disabled" } }), NOW)).toBeNull();
    expect(fromPlaceSearch(place({ osmTags: { parking_space: "charging" } }), NOW)).toBeNull();
    expect(fromPlaceSearch(place({ osmTags: { parking_space: "standard" } }), NOW)).not.toBeNull();
  });

  it("leaves out a place its current hours say is closed, never one whose hours are unknown", () => {
    const hours = "Mo-Sa 07:00-22:00";
    const verdict = (isOpen: boolean, validUntil = CURRENT, isUnknown = false) =>
      place({
        openingHours: hours,
        openingHoursInfo: {
          status: { isOpen, ...(isUnknown ? { isUnknown } : {}) },
          isAlwaysOpen: false,
          weekBitmap: "",
          validUntil,
        },
      });
    expect(fromPlaceSearch(verdict(false), NOW)).toBeNull();
    expect(fromPlaceSearch(verdict(true), NOW)).not.toBeNull();
    expect(fromPlaceSearch(verdict(false, CURRENT, true), NOW)).not.toBeNull();
    // A verdict past its time says nothing about now.
    expect(fromPlaceSearch(verdict(false, new Date(NOW - 1).toISOString()), NOW)).not.toBeNull();
    expect(fromPlaceSearch(place({ openingHours: hours }), NOW)).not.toBeNull();
  });
});
