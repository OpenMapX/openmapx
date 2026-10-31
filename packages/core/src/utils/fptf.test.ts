import { describe, expect, it } from "vitest";
import { mapFptfLoadFactor, normalizeFptfDeparture } from "./fptf";

describe("mapFptfLoadFactor", () => {
  it("maps the four DB load-factor levels to OccupancyLevel", () => {
    expect(mapFptfLoadFactor("low-to-medium")).toBe("low");
    expect(mapFptfLoadFactor("high")).toBe("medium");
    expect(mapFptfLoadFactor("very-high")).toBe("high");
    expect(mapFptfLoadFactor("exceptionally-high")).toBe("overcrowded");
  });

  it("returns undefined for missing or unknown values", () => {
    expect(mapFptfLoadFactor(undefined)).toBeUndefined();
    expect(mapFptfLoadFactor("")).toBeUndefined();
    expect(mapFptfLoadFactor("nonsense")).toBeUndefined();
  });
});

describe("normalizeFptfDeparture occupancy", () => {
  it("derives occupancy from the FPTF loadFactor field", () => {
    const dep = normalizeFptfDeparture(
      { line: { name: "ICE 1", product: "nationalExpress" }, loadFactor: "very-high" },
      "db:",
    );
    expect(dep.occupancy).toBe("high");
  });

  it("leaves occupancy undefined when no loadFactor is present", () => {
    const dep = normalizeFptfDeparture({ line: { name: "RB 1", product: "regional" } }, "db:");
    expect(dep.occupancy).toBeUndefined();
  });
});

describe("normalizeFptfDeparture stop", () => {
  it("names the stop a HAFAS departure leaves from, which can be a related station", () => {
    const dep = normalizeFptfDeparture(
      {
        line: { name: "ICE 127", product: "nationalExpress" },
        stop: { type: "stop", id: "8000207", name: "Köln Hbf" },
      },
      "oebb:",
    );
    expect(dep.stop).toEqual({ id: "oebb:8000207", name: "Köln Hbf" });
  });

  it("leaves the stop out when the departure names none", () => {
    const dep = normalizeFptfDeparture({ line: { name: "RB 1", product: "regional" } }, "db:");
    expect(dep.stop).toBeUndefined();
  });
});

describe("normalizeFptfDeparture line name", () => {
  it("shows the line riders know and keeps the train number apart", () => {
    const dep = normalizeFptfDeparture(
      {
        line: {
          name: "DB S11 (Zug-Nr. 33192)",
          fahrtNr: "33192",
          productName: "DB",
          product: "suburban",
        },
      },
      "oebb:",
    );
    expect(dep.route.shortName).toBe("S11");
    expect(dep.serviceInfo?.trainNumber).toBe("33192");
  });

  it("leaves a plain line name and sets no train number", () => {
    const dep = normalizeFptfDeparture({ line: { name: "RE1", product: "regional" } }, "vsn:");
    expect(dep.route.shortName).toBe("RE1");
    expect(dep.serviceInfo).toBeUndefined();
  });
});
