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

      expect(result.id).toBe("station-1");
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
    it("includes available count", () => {
      const result = mapStationToResult(makeStation({ availableVehicles: 5 }));
      expect(result.summary).toContain("5 available");
    });

    it("includes slot count when emptySlots is defined", () => {
      const result = mapStationToResult(makeStation({ emptySlots: 3 }));
      expect(result.summary).toContain("3 slots");
    });

    it("omits slot count when emptySlots is undefined", () => {
      const result = mapStationToResult(makeStation({ emptySlots: undefined }));
      expect(result.summary).not.toContain("slots");
    });

    it("includes accessMethod when present", () => {
      const result = mapStationToResult(makeStation({ accessMethod: "App" }));
      expect(result.summary).toContain("App");
    });

    it("includes pricingSummary when present", () => {
      const result = mapStationToResult(makeStation({ pricingSummary: "from 0.28 \u20AC/km" }));
      expect(result.summary).toContain("from 0.28 \u20AC/km");
    });

    it("joins parts with middle dot separator", () => {
      const result = mapStationToResult(
        makeStation({ availableVehicles: 2, emptySlots: 4, accessMethod: "Chipkarte" }),
      );
      expect(result.summary).toBe("2 available \u00B7 4 slots \u00B7 Chipkarte");
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

      expect(result.id).toBe("vehicle-1");
      expect(result.coordinates).toEqual([13.41, 52.52]);
      expect(result.source).toBe("gbfs/lime");
      expect(result.operator).toBe("Lime");
    });

    it("name includes operator and form factor label", () => {
      const result = mapVehicleToResult(
        makeVehicle({ operator: "Lime", formFactor: "scooter_standing" }),
      );
      expect(result.name).toBe("Lime E-Scooter");
    });

    it("name is just form factor label when no operator", () => {
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
    it("includes battery percentage", () => {
      const result = mapVehicleToResult(makeVehicle({ batteryLevel: 75 }));
      expect(result.summary).toContain("75%");
    });

    it("includes range in km", () => {
      const result = mapVehicleToResult(makeVehicle({ rangeMeters: 12000 }));
      expect(result.summary).toContain("12.0 km");
    });

    it("joins battery and range with middle dot", () => {
      const result = mapVehicleToResult(makeVehicle({ batteryLevel: 80, rangeMeters: 25000 }));
      expect(result.summary).toBe("80% \u00B7 25.0 km");
    });

    it("returns empty string when no battery or range", () => {
      const result = mapVehicleToResult(
        makeVehicle({ batteryLevel: undefined, rangeMeters: undefined }),
      );
      expect(result.summary).toBe("");
    });
  });
});

describe("mapStationToDetail", () => {
  it("includes Availability section with vehicle count", () => {
    const detail = mapStationToDetail(makeStation());
    const section = detail.sections.find((s) => s.title === "Availability");
    expect(section).toBeDefined();
    expect(section?.type).toBe("table");
    expect(section?.sectionIcon).toBe("info");
    expect(section?.rows?.find((r) => r[0] === "Available Vehicles")?.[1]).toBe(3);
  });

  it("includes empty slots in Availability when defined", () => {
    const detail = mapStationToDetail(makeStation({ emptySlots: 7 }));
    const section = detail.sections.find((s) => s.title === "Availability");
    expect(section?.rows?.find((r) => r[0] === "Empty Slots")?.[1]).toBe(7);
  });

  it("omits empty slots from Availability when undefined", () => {
    const detail = mapStationToDetail(makeStation({ emptySlots: undefined }));
    const section = detail.sections.find((s) => s.title === "Availability");
    expect(section?.rows?.find((r) => r[0] === "Empty Slots")).toBeUndefined();
  });

  it("includes capacity in Availability when defined", () => {
    const detail = mapStationToDetail(makeStation({ capacity: 20 }));
    const section = detail.sections.find((s) => s.title === "Availability");
    expect(section?.rows?.find((r) => r[0] === "Total Capacity")?.[1]).toBe(20);
  });

  it("maps stationType 'fixed' to 'Fixed Station'", () => {
    const detail = mapStationToDetail(makeStation({ stationType: "fixed" }));
    const section = detail.sections.find((s) => s.title === "Availability");
    expect(section?.rows?.find((r) => r[0] === "Type")?.[1]).toBe("Fixed Station");
  });

  it("maps stationType 'free' to 'Free-floating Zone'", () => {
    const detail = mapStationToDetail(makeStation({ stationType: "free" }));
    const section = detail.sections.find((s) => s.title === "Availability");
    expect(section?.rows?.find((r) => r[0] === "Type")?.[1]).toBe("Free-floating Zone");
  });

  it("includes pricing summary in Availability when present", () => {
    const detail = mapStationToDetail(makeStation({ pricingSummary: "from 1.50 \u20AC/h" }));
    const section = detail.sections.find((s) => s.title === "Availability");
    expect(section?.rows?.find((r) => r[0] === "Pricing")?.[1]).toBe("from 1.50 \u20AC/h");
  });

  it("includes Transit section when transitInfo has lines", () => {
    const detail = mapStationToDetail(
      makeStation({ transitInfo: { lines: "U5, U8", stops: "Alexanderplatz" } }),
    );
    const section = detail.sections.find((s) => s.title === "Public Transit");
    expect(section).toBeDefined();
    expect(section?.sectionIcon).toBe("directions_bus");
    expect(section?.rows?.find((r) => r[0] === "Bus Lines")?.[1]).toBe("U5, U8");
    expect(section?.rows?.find((r) => r[0] === "Nearest Stops")?.[1]).toBe("Alexanderplatz");
  });

  it("omits Transit section when no transitInfo", () => {
    const detail = mapStationToDetail(makeStation({ transitInfo: undefined }));
    expect(detail.sections.find((s) => s.title === "Public Transit")).toBeUndefined();
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
    const section = detail.sections.find((s) => s.title === "Vehicle Details");
    expect(section).toBeDefined();
    expect(section?.sectionIcon).toBe("directions_car");
    expect(section?.collapsed).toBe(true);
    expect(section?.rows?.find((r) => r[0] === "Vehicle")?.[1]).toBe("Bosch CX");
    expect(section?.rows?.find((r) => r[0] === "Propulsion")?.[1]).toBe("Electric Assist");
    expect(section?.rows?.find((r) => r[0] === "Seats")?.[1]).toBe(1);
    expect(section?.rows?.find((r) => r[0] === "Features")?.[1]).toBe("Navigation");
    expect(section?.rows?.find((r) => r[0] === "CO\u2082")?.[1]).toBe("Zero emissions");
  });

  it("shows CO2 value in g/km when > 0", () => {
    const detail = mapStationToDetail(
      makeStation({
        vehicleTypeDetails: [{ name: "Car", co2PerKm: 120 }],
      }),
    );
    const section = detail.sections.find((s) => s.title === "Vehicle Details");
    expect(section?.rows?.find((r) => r[0] === "CO\u2082")?.[1]).toBe("120 g/km");
  });

  it("falls back to Vehicle Classes list when no vehicleTypeDetails", () => {
    const detail = mapStationToDetail(
      makeStation({
        vehicleTypeDetails: undefined,
        vehicleClassNames: ["Mini", "Kombi", "Estate"],
      }),
    );
    const section = detail.sections.find((s) => s.title === "Vehicle Classes");
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
    const section = detail.sections.find((s) => s.title === "Pricing");
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
    const section = detail.sections.find((s) => s.title === "Pricing");
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
    const section = detail.sections.find((s) => s.title === "Book");
    expect(section).toBeDefined();
    expect(section?.sectionIcon).toBe("open_in_new");
    expect(section?.rows).toEqual([
      ["Web", "https://book.example.com"],
      ["Android", "android://example"],
      ["iOS", "ios://example"],
    ]);
  });

  it("includes Directions section when locationHint is present", () => {
    const detail = mapStationToDetail(makeStation({ locationHint: "Behind the train station" }));
    const section = detail.sections.find((s) => s.title === "Directions");
    expect(section).toBeDefined();
    expect(section?.type).toBe("text");
    expect(section?.content).toBe("Behind the train station");
  });

  it("includes Notes section when operatorNotes is present", () => {
    const detail = mapStationToDetail(makeStation({ operatorNotes: "Return with full tank" }));
    const section = detail.sections.find((s) => s.title === "Notes");
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

    expect(detail.id).toBe("station-1");
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
    expect(detail.usageInfo).toEqual({ type: "Access: App" });
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
  it("includes Vehicle Info section with type and status", () => {
    const detail = mapVehicleToDetail(makeVehicle({ formFactor: "scooter_standing" }));
    const section = detail.sections.find((s) => s.title === "Vehicle Info");
    expect(section).toBeDefined();
    expect(section?.type).toBe("table");
    expect(section?.sectionIcon).toBe("info");
    expect(section?.rows?.find((r) => r[0] === "Type")?.[1]).toBe("E-Scooter");
    expect(section?.rows?.find((r) => r[0] === "Status")?.[1]).toBe("Available");
  });

  it("shows propulsion when defined", () => {
    const detail = mapVehicleToDetail(makeVehicle({ propulsion: "electric" }));
    const section = detail.sections.find((s) => s.title === "Vehicle Info");
    expect(section?.rows?.find((r) => r[0] === "Propulsion")?.[1]).toBe("Electric");
  });

  it("omits propulsion row when undefined", () => {
    const detail = mapVehicleToDetail(makeVehicle({ propulsion: undefined }));
    const section = detail.sections.find((s) => s.title === "Vehicle Info");
    expect(section?.rows?.find((r) => r[0] === "Propulsion")).toBeUndefined();
  });

  it("shows battery percentage when defined", () => {
    const detail = mapVehicleToDetail(makeVehicle({ batteryLevel: 85 }));
    const section = detail.sections.find((s) => s.title === "Vehicle Info");
    expect(section?.rows?.find((r) => r[0] === "Battery")?.[1]).toBe("85%");
  });

  it("shows range in km when defined", () => {
    const detail = mapVehicleToDetail(makeVehicle({ rangeMeters: 15500 }));
    const section = detail.sections.find((s) => s.title === "Vehicle Info");
    expect(section?.rows?.find((r) => r[0] === "Range")?.[1]).toBe("15.5 km");
  });

  it("status shows Reserved when isReserved", () => {
    const detail = mapVehicleToDetail(makeVehicle({ isReserved: true }));
    const section = detail.sections.find((s) => s.title === "Vehicle Info");
    expect(section?.rows?.find((r) => r[0] === "Status")?.[1]).toBe("Reserved");
  });

  it("status shows Disabled when isDisabled", () => {
    const detail = mapVehicleToDetail(makeVehicle({ isDisabled: true }));
    const section = detail.sections.find((s) => s.title === "Vehicle Info");
    expect(section?.rows?.find((r) => r[0] === "Status")?.[1]).toBe("Disabled");
  });

  it("maps detail-level fields correctly", () => {
    const detail = mapVehicleToDetail(
      makeVehicle({ operator: "Lime", formFactor: "scooter_standing" }),
    );
    expect(detail.id).toBe("vehicle-1");
    expect(detail.sources).toEqual(["gbfs/lime"]);
    expect(detail.name).toBe("Lime E-Scooter");
    expect(detail.coordinates).toEqual([13.41, 52.52]);
    expect(detail.operator).toEqual({ name: "Lime" });
  });

  it("name uses form factor label alone when no operator", () => {
    const detail = mapVehicleToDetail(makeVehicle({ operator: undefined, formFactor: "bicycle" }));
    expect(detail.name).toBe("Bicycle");
    expect(detail.operator).toBeUndefined();
  });

  it("maps all form factor labels correctly", () => {
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

  it("maps all propulsion labels correctly", () => {
    const propulsions: Record<string, string> = {
      human: "Human-powered",
      electric_assist: "Electric Assist",
      electric: "Electric",
      combustion: "Combustion",
      combustion_diesel: "Diesel",
      hybrid: "Hybrid",
      plug_in_hybrid: "Plug-in Hybrid",
      hydrogen_fuel_cell: "Hydrogen",
    };

    for (const [propulsion, expectedLabel] of Object.entries(propulsions)) {
      const detail = mapVehicleToDetail(
        makeVehicle({ propulsion: propulsion as SharedMobilityVehicle["propulsion"] }),
      );
      const section = detail.sections.find((s) => s.title === "Vehicle Info");
      expect(section?.rows?.find((r) => r[0] === "Propulsion")?.[1]).toBe(expectedLabel);
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
    const section = detail.sections.find((s) => s.title === "Vehicle Info");
    expect(section?.rows?.find((r) => r[0] === "Propulsion")).toBeUndefined();
    expect(section?.rows?.find((r) => r[0] === "Battery")).toBeUndefined();
    expect(section?.rows?.find((r) => r[0] === "Range")).toBeUndefined();
    // Status should still be present
    expect(section?.rows?.find((r) => r[0] === "Status")?.[1]).toBe("Available");
  });
});
