import { ProviderPayloadError } from "@openmapx/integration-framework";
import { describe, expect, it } from "vitest";
import { lngLatOrNull, usableGeocoderRecords } from "./records.js";

describe("geocoder records", () => {
  it("accepts only finite coordinates in range", () => {
    expect(lngLatOrNull(13.4, 52.5)).toEqual([13.4, 52.5]);
    expect(lngLatOrNull(181, 52.5)).toBeNull();
    expect(lngLatOrNull(13.4, Number.NaN)).toBeNull();
    expect(lngLatOrNull("13.4", 52.5)).toBeNull();
  });

  it("drops records without coordinates or label", () => {
    const records = [
      { id: 1, lng: 13.4, lat: 52.5, label: "Berlin" },
      { id: 2, lng: undefined, lat: 52.5, label: "No coordinates" },
      { id: 3, lng: 13.4, lat: 52.5, label: " " },
    ];
    const usable = usableGeocoderRecords(
      records,
      (r) => ({ coordinates: lngLatOrNull(r.lng, r.lat), label: r.label }),
      "Test geocoder",
    );
    expect(usable.map(({ record }) => record.id)).toEqual([1]);
  });

  it("rejects a non-empty answer with no usable record", () => {
    expect(() =>
      usableGeocoderRecords([{}], () => ({ coordinates: null, label: "x" }), "Test geocoder"),
    ).toThrow(ProviderPayloadError);
    expect(usableGeocoderRecords([], () => ({ coordinates: null, label: "" }), "Test")).toEqual([]);
  });
});
