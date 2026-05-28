import type { SharedMobilityStation, SharedMobilityVehicle } from "@openmapx/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mapStationToDetail,
  mapStationToResult,
  mapVehicleToDetail,
  mapVehicleToResult,
} from "../src/mapper.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function makeStation(overrides?: Partial<SharedMobilityStation>): SharedMobilityStation {
  return {
    id: "station-1",
    name: "Test Station",
    coordinates: [13.41, 52.52],
    availableVehicles: 3,
    emptySlots: 7,
    vehicleTypes: ["bicycle"],
    isActive: true,
    sources: ["gbfs/test"],
    operator: "TestBikes",
    ...overrides,
  };
}

function makeVehicle(overrides?: Partial<SharedMobilityVehicle>): SharedMobilityVehicle {
  return {
    id: "vehicle-1",
    coordinates: [13.41, 52.52],
    formFactor: "scooter_standing",
    isReserved: false,
    isDisabled: false,
    sources: ["gbfs/lime"],
    operator: "Lime",
    ...overrides,
  };
}

/** Finds a row by its label token's `$t` key. Rows where the label is a plain
 * string fall back to direct comparison. */
function findRow(
  section: { rows?: unknown[][] } | undefined,
  keyOrLabel: string,
): unknown[] | undefined {
  return section?.rows?.find((r) => {
    const label = r[0];
    if (label && typeof label === "object" && "$t" in label) {
      return (label as { $t: string }).$t === keyOrLabel;
    }
    return label === keyOrLabel;
  });
}

function findSection<T extends { title: unknown }>(
  sections: T[],
  keyOrTitle: string,
): T | undefined {
  return sections.find((s) => {
    const t = s.title;
    if (t && typeof t === "object" && "$t" in t) {
      return (t as { $t: string }).$t === keyOrTitle;
    }
    return t === keyOrTitle;
  });
}

describe("mapStationToResult", () => {
  describe("variant computation", () => {
    it("returns 'available' when availableVehicles > 0 and emptySlots > 0", () => {
      const station = makeStation({ availableVehicles: 3, emptySlots: 7 });
      const result = mapStationToResult(station);
      expect(result.variant).toBe("available");
      expect(result.status).toBe("available");
    });

    it("returns 'empty' when availableVehicles = 0 and emptySlots > 0", () => {
      const station = makeStation({ availableVehicles: 0, emptySlots: 10 });
      const result = mapStationToResult(station);
      expect(result.variant).toBe("empty");
      expect(result.status).toBe("empty");
    });

    it("returns 'full' when availableVehicles > 0 and emptySlots = 0", () => {
      const station = makeStation({ availableVehicles: 10, emptySlots: 0 });
      const result = mapStationToResult(station);
      expect(result.variant).toBe("full");
      expect(result.status).toBe("full");
    });

    it("returns 'inactive' when isActive = false", () => {
      const station = makeStation({ isActive: false, availableVehicles: 5, emptySlots: 5 });
      const result = mapStationToResult(station);
      expect(result.variant).toBe("inactive");
      expect(result.status).toBe("inactive");
    });

    it("inactive takes priority over empty/full", () => {
      const station = makeStation({ isActive: false, availableVehicles: 0, emptySlots: 0 });
      const result = mapStationToResult(station);
      expect(result.variant).toBe("inactive");
    });
  });

  describe("result fields", () => {
    it("maps all standard fields correctly", () => {
      const station = makeStation();
      const result = mapStationToResult(station);

      expect(result.id).toBe("s:station-1");
      expect(result.kind).toBe("station");
      expect(result.name).toBe("Test Station");
      expect(result.coordinates).toEqual([13.41, 52.52]);
      expect(result.source).toBe("gbfs/test");
      expect(result.operator).toBe("TestBikes");
    });

    it("includes sortValues with available count and slots", () => {
      const station = makeStation({ availableVehicles: 5, emptySlots: 3 });
      const result = mapStationToResult(station);
      expect(result.sortValues).toEqual({ available: 5, slots: 3 });
    });

    it("defaults slots to 0 when emptySlots is undefined", () => {
      const station = makeStation({ emptySlots: undefined });
      const result = mapStationToResult(station);
      expect(result.sortValues?.slots).toBe(0);
    });

    it("maps branding and map context when Entur metadata is present", () => {
      const result = mapStationToResult(
        makeStation({
          systemId: "voioslo",
          vehicleTypeIds: ["bike-type"],
          branding: {
            name: "Voi",
            legalName: "Voi Technology",
            logoUrl: "https://cdn.example.com/voi.svg",
            color: "#F4A300",
          },
        }),
      );

      expect(result.branding).toMatchObject({
        name: "Voi",
        legalName: "Voi Technology",
        logoUrl: "https://cdn.example.com/voi.svg",
        color: "#F4A300",
      });
      expect(result.mapContext).toEqual({
        systemIds: ["voioslo"],
        vehicleTypeIds: ["bike-type"],
      });
    });
  });

  describe("summary", () => {
    it("emits a summary.available token with the available count", () => {
      const result = mapStationToResult(makeStation({ availableVehicles: 5 }));
      expect(result.summary).toEqual({ $t: "summary.available", values: { count: 5 } });
    });

    it("emits zero counts unchanged for the ICU plural rule to render", () => {
      const result = mapStationToResult(makeStation({ availableVehicles: 0 }));
      expect(result.summary).toEqual({ $t: "summary.available", values: { count: 0 } });
    });

    it("does not include slot or access information on the result card", () => {
      // Slot counts and access methods now live in the station-detail
      // Availability table where they can be resolved per-integration; the
      // result card summary stays a single token to avoid client-side
      // concatenation of locale fragments.
      const result = mapStationToResult(
        makeStation({ availableVehicles: 2, emptySlots: 4, accessMethod: "Chipkarte" }),
      );
      expect(result.summary).toEqual({ $t: "summary.available", values: { count: 2 } });
    });
  });
});

describe("mapVehicleToResult", () => {
  describe("variant computation", () => {
    it("returns 'reserved' when isReserved = true", () => {
      const vehicle = makeVehicle({ isReserved: true });
      const result = mapVehicleToResult(vehicle);
      expect(result.variant).toBe("reserved");
      expect(result.status).toBe("reserved");
    });

    it("returns 'disabled' when isDisabled = true", () => {
      const vehicle = makeVehicle({ isDisabled: true });
      const result = mapVehicleToResult(vehicle);
      expect(result.variant).toBe("disabled");
      expect(result.status).toBe("disabled");
    });

    it("disabled takes priority over reserved", () => {
      const vehicle = makeVehicle({ isDisabled: true, isReserved: true });
      const result = mapVehicleToResult(vehicle);
      expect(result.variant).toBe("disabled");
    });

    it("returns 'low_battery' when battery < 20", () => {
      const vehicle = makeVehicle({ batteryLevel: 15 });
      const result = mapVehicleToResult(vehicle);
      expect(result.variant).toBe("low_battery");
    });

    it("returns 'medium_battery' when battery >= 20 and < 80", () => {
      const vehicle = makeVehicle({ batteryLevel: 50 });
      const result = mapVehicleToResult(vehicle);
      expect(result.variant).toBe("medium_battery");
    });

    it("returns 'medium_battery' at exactly 20", () => {
      const vehicle = makeVehicle({ batteryLevel: 20 });
      const result = mapVehicleToResult(vehicle);
      expect(result.variant).toBe("medium_battery");
    });

    it("returns 'high_battery' when battery >= 80", () => {
      const vehicle = makeVehicle({ batteryLevel: 80 });
      const result = mapVehicleToResult(vehicle);
      expect(result.variant).toBe("high_battery");
    });

    it("returns 'high_battery' at 100", () => {
      const vehicle = makeVehicle({ batteryLevel: 100 });
      const result = mapVehicleToResult(vehicle);
      expect(result.variant).toBe("high_battery");
    });

    it("returns 'available' when no battery and not reserved/disabled", () => {
      const vehicle = makeVehicle({ batteryLevel: undefined });
      const result = mapVehicleToResult(vehicle);
      expect(result.variant).toBe("available");
    });

    it("returns 'low_battery' at exactly 0", () => {
      const vehicle = makeVehicle({ batteryLevel: 0 });
      const result = mapVehicleToResult(vehicle);
      expect(result.variant).toBe("low_battery");
    });

    it("returns 'low_battery' at 19", () => {
      const vehicle = makeVehicle({ batteryLevel: 19 });
      const result = mapVehicleToResult(vehicle);
      expect(result.variant).toBe("low_battery");
    });

    it("returns 'medium_battery' at 79", () => {
      const vehicle = makeVehicle({ batteryLevel: 79 });
      const result = mapVehicleToResult(vehicle);
      expect(result.variant).toBe("medium_battery");
    });
  });

  describe("result fields", () => {
    it("maps all standard fields correctly", () => {
      const vehicle = makeVehicle();
      const result = mapVehicleToResult(vehicle);

      expect(result.id).toBe("v:vehicle-1");
      expect(result.kind).toBe("vehicle");
      expect(result.coordinates).toEqual([13.41, 52.52]);
      expect(result.source).toBe("gbfs/lime");
      expect(result.operator).toBe("Lime");
    });

    it("name includes operator and English form factor fallback label", () => {
      // The vehicle `name` is a plain string used as both display and OSM
      // identity input, so it carries an English fallback rather than a
      // token. Tokenization of vehicle name follows in Task 4.1.
      const result = mapVehicleToResult(
        makeVehicle({ operator: "Lime", formFactor: "scooter_standing" }),
      );
      expect(result.name).toBe("Lime E-Scooter");
    });

    it("name is just form factor fallback when no operator", () => {
      const result = mapVehicleToResult(
        makeVehicle({ operator: undefined, formFactor: "bicycle" }),
      );
      expect(result.name).toBe("Bicycle");
    });

    it("name uses 'Vehicle' for unknown form factor", () => {
      const result = mapVehicleToResult(makeVehicle({ operator: undefined, formFactor: "other" }));
      expect(result.name).toBe("Vehicle");
    });

    it("includes battery in sortValues when present", () => {
      const result = mapVehicleToResult(makeVehicle({ batteryLevel: 75 }));
      expect(result.sortValues?.battery).toBe(75);
    });

    it("includes range in sortValues when present", () => {
      const result = mapVehicleToResult(makeVehicle({ rangeMeters: 12000 }));
      expect(result.sortValues?.range).toBe(12000);
    });

    it("sortValues is empty object when no battery or range", () => {
      const result = mapVehicleToResult(
        makeVehicle({ batteryLevel: undefined, rangeMeters: undefined }),
      );
      expect(result.sortValues).toEqual({});
    });

    it("maps vehicle branding and map context when Entur metadata is present", () => {
      const result = mapVehicleToResult(
        makeVehicle({
          systemId: "bilkollektivet",
          vehicleTypeId: "car-type",
          branding: {
            name: "Bilkollektivet",
            legalName: "Bilkollektivet SA",
            logoUrl: "https://cdn.example.com/bil.svg",
          },
          vehicleIconUrl: "https://cdn.example.com/car-icon.svg",
        }),
      );

      expect(result.branding).toMatchObject({
        name: "Bilkollektivet",
        legalName: "Bilkollektivet SA",
        logoUrl: "https://cdn.example.com/bil.svg",
        imageUrl: "https://cdn.example.com/car-icon.svg",
      });
      expect(result.mapContext).toEqual({
        systemIds: ["bilkollektivet"],
        vehicleTypeIds: ["car-type"],
      });
    });
  });

  describe("summary", () => {
    it("emits a battery format token when only battery is known", () => {
      const result = mapVehicleToResult(makeVehicle({ batteryLevel: 75 }));
      expect(result.summary).toEqual({ $t: "format.batteryPercent", values: { value: 75 } });
    });

    it("emits a distance format token when only range is known", () => {
      const result = mapVehicleToResult(makeVehicle({ rangeMeters: 12000 }));
      expect(result.summary).toEqual({ $t: "format.distanceKm", values: { value: "12.0" } });
    });

    it("emits the combined battery+range token when both are known", () => {
      // Compound combos resolve against the consuming integration's
      // `summary.batteryRange` template so the separator/unit are
      // locale-correct — no English literal crosses the contract.
      const result = mapVehicleToResult(makeVehicle({ batteryLevel: 80, rangeMeters: 25000 }));
      expect(result.summary).toEqual({
        $t: "summary.batteryRange",
        values: { battery: 80, km: "25.0" },
      });
    });

    it("returns undefined summary when no battery or range", () => {
      const result = mapVehicleToResult(
        makeVehicle({ batteryLevel: undefined, rangeMeters: undefined }),
      );
      expect(result.summary).toBeUndefined();
    });
  });
});

describe("mapStationToDetail", () => {
  it("includes Availability section with vehicle count", () => {
    const detail = mapStationToDetail(makeStation());
    const section = findSection(detail.sections, "shared.section.availability");
    expect(section).toBeDefined();
    expect(section?.type).toBe("table");
    expect(section?.sectionIcon).toBe("info");
    expect(findRow(section, "row.availableVehicles")?.[1]).toBe(3);
  });

  it("includes empty slots in Availability when defined", () => {
    const detail = mapStationToDetail(makeStation({ emptySlots: 7 }));
    const section = findSection(detail.sections, "shared.section.availability");
    expect(findRow(section, "row.emptySlots")?.[1]).toBe(7);
  });

  it("omits empty slots from Availability when undefined", () => {
    const detail = mapStationToDetail(makeStation({ emptySlots: undefined }));
    const section = findSection(detail.sections, "shared.section.availability");
    expect(findRow(section, "row.emptySlots")).toBeUndefined();
  });

  it("includes capacity in Availability when defined", () => {
    const detail = mapStationToDetail(makeStation({ capacity: 20 }));
    const section = findSection(detail.sections, "shared.section.availability");
    expect(findRow(section, "row.totalCapacity")?.[1]).toBe(20);
  });

  it("maps stationType 'fixed' to a fixedStation token", () => {
    const detail = mapStationToDetail(makeStation({ stationType: "fixed" }));
    const section = findSection(detail.sections, "shared.section.availability");
    expect(findRow(section, "shared.row.type")?.[1]).toEqual({ $t: "value.fixedStation" });
  });

  it("maps stationType 'free' to a freefloatingZone token", () => {
    const detail = mapStationToDetail(makeStation({ stationType: "free" }));
    const section = findSection(detail.sections, "shared.section.availability");
    expect(findRow(section, "shared.row.type")?.[1]).toEqual({ $t: "value.freefloatingZone" });
  });

  it("includes pricing summary in Availability when present", () => {
    const detail = mapStationToDetail(makeStation({ pricingSummary: "from 1.50 €/h" }));
    const section = findSection(detail.sections, "shared.section.availability");
    expect(findRow(section, "row.pricing")?.[1]).toBe("from 1.50 €/h");
  });

  it("includes Transit section when transitInfo has lines", () => {
    const detail = mapStationToDetail(
      makeStation({ transitInfo: { lines: "U5, U8", stops: "Alexanderplatz" } }),
    );
    const section = findSection(detail.sections, "section.transit");
    expect(section).toBeDefined();
    expect(section?.sectionIcon).toBe("directions_bus");
    expect(findRow(section, "row.busLines")?.[1]).toBe("U5, U8");
    expect(findRow(section, "row.nearestStops")?.[1]).toBe("Alexanderplatz");
  });

  it("omits Transit section when no transitInfo", () => {
    const detail = mapStationToDetail(makeStation({ transitInfo: undefined }));
    expect(findSection(detail.sections, "section.transit")).toBeUndefined();
  });

  it("includes Vehicle Details section for vehicleTypeDetails", () => {
    const detail = mapStationToDetail(
      makeStation({
        vehicleTypeDetails: [
          {
            name: "E-Bike",
            make: "Bosch",
            model: "CX",
            propulsion: "electric_assist",
            riderCapacity: 1,
            accessories: ["navigation"],
            co2PerKm: 0,
          },
        ],
      }),
    );
    const section = findSection(detail.sections, "section.vehicleDetails");
    expect(section).toBeDefined();
    expect(section?.sectionIcon).toBe("directions_car");
    expect(section?.collapsed).toBe(true);
    // Make+model takes precedence over the structured name — emitted as a
    // pass-through string since the value is operator-provided.
    expect(findRow(section, "row.vehicle")?.[1]).toBe("Bosch CX");
    expect(findRow(section, "row.propulsion")?.[1]).toEqual({
      $t: "value.propulsionKind.electric_assist",
    });
    expect(findRow(section, "row.seats")?.[1]).toBe(1);
    // Accessories emit one token per entry (resolved + joined client-side).
    expect(findRow(section, "row.features")?.[1]).toEqual([{ $t: "value.accessory.navigation" }]);
    expect(findRow(section, "row.co2")?.[1]).toEqual({ $t: "value.zeroEmissions" });
  });

  it("emits accessory tokens for known enums and English fallback for unknown", () => {
    const detail = mapStationToDetail(
      makeStation({
        vehicleTypeDetails: [
          {
            name: "Car",
            formFactor: "car",
            accessories: ["air_conditioning", "heated_seats"],
          },
        ],
      }),
    );
    const section = findSection(detail.sections, "section.vehicleDetails");
    // Known enum → catalog token; unknown enum → readable English fallback.
    expect(findRow(section, "row.features")?.[1]).toEqual([
      { $t: "value.accessory.air_conditioning" },
      "heated seats",
    ]);
  });

  it("shows CO2 value in g/km when > 0", () => {
    const detail = mapStationToDetail(
      makeStation({
        vehicleTypeDetails: [{ name: "Car", co2PerKm: 120 }],
      }),
    );
    const section = findSection(detail.sections, "section.vehicleDetails");
    expect(findRow(section, "row.co2")?.[1]).toEqual({
      $t: "format.co2PerKm",
      values: { value: 120 },
    });
  });

  it("falls back to Vehicle Classes list when no vehicleTypeDetails", () => {
    const detail = mapStationToDetail(
      makeStation({
        vehicleTypeDetails: undefined,
        vehicleClassNames: ["Mini", "Kombi", "Estate"],
      }),
    );
    const section = findSection(detail.sections, "section.vehicleClasses");
    expect(section).toBeDefined();
    expect(section?.type).toBe("list");
    expect(section?.items).toEqual(["Mini", "Kombi", "Estate"]);
  });

  it("includes Pricing section with formatted rates", () => {
    const detail = mapStationToDetail(
      makeStation({
        pricingDetails: [
          {
            name: "Standard",
            currency: "EUR",
            flatRate: 1.5,
            perKmRate: 0.28,
            perHourRate: 1.9,
          },
        ],
      }),
    );
    const section = findSection(detail.sections, "shared.section.pricing");
    expect(section).toBeDefined();
    expect(section?.type).toBe("pricing");
    expect(section?.sectionIcon).toBe("payments");
    expect(section?.collapsed).toBe(true);
    expect(section?.pricingPlans?.[0]).toEqual({
      name: "Standard",
      currency: "EUR",
      unlockFee: 1.5,
      perKm: 0.28,
      perHour: 1.9,
      description: undefined,
      free: false,
    });
  });

  it("shows 'Free' when pricing has no rates", () => {
    const detail = mapStationToDetail(
      makeStation({
        pricingDetails: [{ name: "Free Plan", currency: "EUR" }],
      }),
    );
    const section = findSection(detail.sections, "shared.section.pricing");
    expect(section?.type).toBe("pricing");
    expect(section?.pricingPlans?.[0]).toEqual({
      name: "Free Plan",
      currency: "EUR",
      description: undefined,
      free: true,
      unlockFee: undefined,
      perKm: undefined,
      perHour: undefined,
    });
  });

  it("includes Book section with rental URIs", () => {
    const detail = mapStationToDetail(
      makeStation({
        rentalUris: {
          web: "https://book.example.com",
          android: "android://example",
          ios: "ios://example",
        },
      }),
    );
    const section = findSection(detail.sections, "section.book");
    expect(section).toBeDefined();
    expect(section?.sectionIcon).toBe("open_in_new");
    expect(section?.rows).toEqual([
      [{ $t: "row.web" }, "https://book.example.com"],
      [{ $t: "row.android" }, "android://example"],
      [{ $t: "row.ios" }, "ios://example"],
    ]);
  });

  it("includes Directions section when locationHint is present", () => {
    const detail = mapStationToDetail(makeStation({ locationHint: "Behind the train station" }));
    const section = findSection(detail.sections, "section.directions");
    expect(section).toBeDefined();
    expect(section?.type).toBe("text");
    expect(section?.content).toBe("Behind the train station");
  });

  it("includes Notes section when operatorNotes is present", () => {
    const detail = mapStationToDetail(makeStation({ operatorNotes: "Return with full tank" }));
    const section = findSection(detail.sections, "section.notes");
    expect(section).toBeDefined();
    expect(section?.type).toBe("text");
    expect(section?.content).toBe("Return with full tank");
  });

  it("maps detail-level fields correctly", () => {
    const detail = mapStationToDetail(
      makeStation({
        address: { street: "Hauptstr. 1", city: "Berlin", postcode: "10115", country: "DE" },
        operator: "TestBikes",
        website: "https://testbikes.example.com",
        accessMethod: "App",
      }),
    );

    expect(detail.id).toBe("s:station-1");
    expect(detail.sources).toEqual(["gbfs/test"]);
    expect(detail.name).toBe("Test Station");
    expect(detail.coordinates).toEqual([13.41, 52.52]);
    expect(detail.address).toEqual({
      line1: "Hauptstr. 1",
      town: "Berlin",
      postcode: "10115",
      country: "DE",
    });
    expect(detail.operator).toEqual({
      name: "TestBikes",
      url: "https://testbikes.example.com",
    });
    // usageInfo.type emits the format.accessMethod token; the client resolver
    // interpolates the raw access method against the integration catalog.
    expect(detail.usageInfo).toEqual({
      type: { $t: "format.accessMethod", values: { method: "App" } },
    });
  });

  it("omits address when station has no address", () => {
    const detail = mapStationToDetail(makeStation({ address: undefined }));
    expect(detail.address).toBeUndefined();
  });

  it("omits operator when station has no operator", () => {
    const detail = mapStationToDetail(makeStation({ operator: undefined }));
    expect(detail.operator).toBeUndefined();
  });

  it("omits usageInfo when station has no accessMethod", () => {
    const detail = mapStationToDetail(makeStation({ accessMethod: undefined }));
    expect(detail.usageInfo).toBeUndefined();
  });
});

describe("mapVehicleToDetail", () => {
  it("includes Vehicle Info section with type and status tokens", () => {
    const detail = mapVehicleToDetail(makeVehicle({ formFactor: "scooter_standing" }));
    const section = findSection(detail.sections, "section.vehicleInfo");
    expect(section).toBeDefined();
    expect(section?.type).toBe("table");
    expect(section?.sectionIcon).toBe("info");
    expect(findRow(section, "shared.row.type")?.[1]).toEqual({
      $t: "value.formFactor.scooter_standing",
    });
    expect(findRow(section, "shared.row.status")?.[1]).toEqual({ $t: "value.available" });
  });

  it("shows propulsion as a token when defined", () => {
    const detail = mapVehicleToDetail(makeVehicle({ propulsion: "electric" }));
    const section = findSection(detail.sections, "section.vehicleInfo");
    expect(findRow(section, "row.propulsion")?.[1]).toEqual({
      $t: "value.propulsionKind.electric",
    });
  });

  it("omits propulsion row when undefined", () => {
    const detail = mapVehicleToDetail(makeVehicle({ propulsion: undefined }));
    const section = findSection(detail.sections, "section.vehicleInfo");
    expect(findRow(section, "row.propulsion")).toBeUndefined();
  });

  it("shows battery percentage as a format token when defined", () => {
    const detail = mapVehicleToDetail(makeVehicle({ batteryLevel: 85 }));
    const section = findSection(detail.sections, "section.vehicleInfo");
    expect(findRow(section, "row.battery")?.[1]).toEqual({
      $t: "format.batteryPercent",
      values: { value: 85 },
    });
  });

  it("shows range as a format token in km when defined", () => {
    const detail = mapVehicleToDetail(makeVehicle({ rangeMeters: 15500 }));
    const section = findSection(detail.sections, "section.vehicleInfo");
    expect(findRow(section, "row.range")?.[1]).toEqual({
      $t: "format.distanceKm",
      values: { value: "15.5" },
    });
  });

  it("status shows Reserved token when isReserved", () => {
    const detail = mapVehicleToDetail(makeVehicle({ isReserved: true }));
    const section = findSection(detail.sections, "section.vehicleInfo");
    expect(findRow(section, "shared.row.status")?.[1]).toEqual({ $t: "value.reserved" });
  });

  it("status shows Disabled token when isDisabled", () => {
    const detail = mapVehicleToDetail(makeVehicle({ isDisabled: true }));
    const section = findSection(detail.sections, "section.vehicleInfo");
    expect(findRow(section, "shared.row.status")?.[1]).toEqual({ $t: "value.disabled" });
  });

  it("maps detail-level fields correctly", () => {
    const detail = mapVehicleToDetail(
      makeVehicle({ operator: "Lime", formFactor: "scooter_standing" }),
    );
    expect(detail.id).toBe("v:vehicle-1");
    expect(detail.sources).toEqual(["gbfs/lime"]);
    expect(detail.name).toBe("Lime E-Scooter");
    expect(detail.coordinates).toEqual([13.41, 52.52]);
    expect(detail.operator).toEqual({ name: "Lime" });
  });

  it("name uses English form factor fallback alone when no operator", () => {
    const detail = mapVehicleToDetail(makeVehicle({ operator: undefined, formFactor: "bicycle" }));
    expect(detail.name).toBe("Bicycle");
    expect(detail.operator).toBeUndefined();
  });

  it("name fallbacks cover every known form factor", () => {
    const factors: Record<string, string> = {
      bicycle: "Bicycle",
      cargo_bicycle: "Cargo Bicycle",
      scooter_standing: "E-Scooter",
      scooter_seated: "Seated Scooter",
      car: "Car",
      moped: "Moped",
      other: "Vehicle",
    };

    for (const [formFactor, expectedLabel] of Object.entries(factors)) {
      const detail = mapVehicleToDetail(
        makeVehicle({
          operator: undefined,
          formFactor: formFactor as SharedMobilityVehicle["formFactor"],
        }),
      );
      expect(detail.name).toBe(expectedLabel);
    }
  });

  it("propulsion row emits the corresponding propulsionKind token for every known kind", () => {
    const propulsions: SharedMobilityVehicle["propulsion"][] = [
      "human",
      "electric_assist",
      "electric",
      "combustion",
      "combustion_diesel",
      "hybrid",
      "plug_in_hybrid",
      "hydrogen_fuel_cell",
    ];

    for (const propulsion of propulsions) {
      const detail = mapVehicleToDetail(makeVehicle({ propulsion }));
      const section = findSection(detail.sections, "section.vehicleInfo");
      expect(findRow(section, "row.propulsion")?.[1]).toEqual({
        $t: `value.propulsionKind.${propulsion}`,
      });
    }
  });

  it("handles missing optional fields gracefully", () => {
    const detail = mapVehicleToDetail(
      makeVehicle({
        operator: undefined,
        propulsion: undefined,
        batteryLevel: undefined,
        rangeMeters: undefined,
      }),
    );
    expect(detail.name).toBe("E-Scooter");
    expect(detail.operator).toBeUndefined();
    const section = findSection(detail.sections, "section.vehicleInfo");
    expect(findRow(section, "row.propulsion")).toBeUndefined();
    expect(findRow(section, "row.battery")).toBeUndefined();
    expect(findRow(section, "row.range")).toBeUndefined();
    // Status should still be present
    expect(findRow(section, "shared.row.status")?.[1]).toEqual({ $t: "value.available" });
  });
});
