import { describe, expect, it } from "vitest";
import { describeMapLocation, mapLocationCopyRows, mapLocationPlace } from "./mapLocation";

const POINT: [number, number] = [6.083, 50.776];
const LABELS = { coordinates: "Coordinates", name: "Name", address: "Address" };
const CAFE = {
  featureId: "42",
  name: "Café Kaiser",
  coordinates: [6.0831, 50.7761] as [number, number],
};

describe("describeMapLocation", () => {
  it("falls back from the place's name to the city, the address and the coordinates", () => {
    const bare = { coordinates: POINT, poi: null };
    expect(describeMapLocation(bare, null).title).toBe("50.776000, 6.083000");
    expect(describeMapLocation(bare, { address: "Markt 1" }).title).toBe("Markt 1");
    expect(describeMapLocation(bare, { address: "Markt 1", city: "Aachen" }).title).toBe("Aachen");
    expect(describeMapLocation({ coordinates: POINT, poi: CAFE }, { city: "Aachen" }).title).toBe(
      "Café Kaiser",
    );
  });

  it("routes under the place's name, else the address", () => {
    expect(
      describeMapLocation({ coordinates: POINT, poi: null }, { address: "Markt 1", city: "Aachen" })
        .routeLabel,
    ).toBe("Markt 1");
    expect(
      describeMapLocation({ coordinates: POINT, poi: CAFE }, { address: "Markt 1" }).routeLabel,
    ).toBe("Café Kaiser");
  });
});

describe("mapLocationPlace", () => {
  it("is the basemap place when there is one, else the point", () => {
    expect(mapLocationPlace({ coordinates: POINT, poi: CAFE }, null).id).toBe("stylePoi:42");
    expect(mapLocationPlace({ coordinates: POINT, poi: null }, null).coordinates).toEqual(POINT);
  });
});

describe("mapLocationCopyRows", () => {
  it("lists coordinates, name and address without repeating a value", () => {
    const rows = mapLocationCopyRows(
      { coordinates: POINT, poi: { ...CAFE, name: "Markt 1" } },
      { address: "Markt 1" },
      LABELS,
    );
    expect(rows).toEqual([
      { label: "Coordinates", value: "50.776000, 6.083000" },
      { label: "Name", value: "Markt 1" },
    ]);
  });

  it("offers only the coordinates for a bare point with no address yet", () => {
    expect(mapLocationCopyRows({ coordinates: POINT, poi: null }, null, LABELS)).toHaveLength(1);
  });
});
