import { describe, expect, it } from "vitest";
import {
  buildLabel,
  estimateMassTonnes,
  isHybrid,
  mapConnectors,
  mapVehicle,
  pickRange,
  type RawVehicle,
} from "../map-vehicle.ts";

/** A complete, mappable record; individual tests override the fields they exercise. */
function raw(overrides: Partial<RawVehicle> = {}): RawVehicle {
  return {
    unique_code: "volkswagen:id_4:2024:id_4",
    make: { name: "Volkswagen" },
    model: { name: "ID.4" },
    year: 2024,
    vehicle_type: "suv",
    battery: { pack_capacity_kwh_net: 77 },
    charging: { ac: { max_power_kw: 11 }, dc: { max_power_kw: 135 } },
    range: { rated: [{ cycle: "wltp", range_km: 480 }] },
    weights: { curb_weight_kg: 2124 },
    charge_ports: [{ connector: "ccs2" }],
    ...overrides,
  } as RawVehicle;
}

describe("mapConnectors", () => {
  it.each([
    ["ccs2", ["ccs2"]],
    ["ccs1", ["ccs1"]],
    ["type2", ["type2"]],
    ["type1", ["type1"]],
    ["chademo", ["chademo"]],
    ["gb_t_dc", ["gbt_dc"]],
    ["gb_t_ac", ["gbt_ac"]],
  ])("maps %s to %o", (connector, expected) => {
    expect(mapConnectors(raw({ charge_ports: [{ connector }] }))).toEqual(expected);
  });

  it("fans a European NACS car out to tesla_ccs and ccs2", () => {
    const connectors = mapConnectors(
      raw({ charge_ports: [{ connector: "nacs" }], markets: ["US", "DE", "NL"] }),
    );
    expect(connectors).toContain("nacs");
    expect(connectors).toContain("tesla_ccs");
    expect(connectors).toContain("ccs2");
    expect(connectors).not.toContain("ccs1");
  });

  it("fans a non-European NACS car out to tesla_ccs and ccs1", () => {
    const connectors = mapConnectors(
      raw({ charge_ports: [{ connector: "nacs" }], markets: ["US", "CA"] }),
    );
    expect(connectors).toContain("nacs");
    expect(connectors).toContain("tesla_ccs");
    expect(connectors).toContain("ccs1");
    expect(connectors).not.toContain("ccs2");
  });

  it("reads a European market from object-shaped markets entries", () => {
    const connectors = mapConnectors(
      raw({
        charge_ports: [{ connector: "nacs" }],
        markets: [{ country: "FR" }] as unknown as RawVehicle["markets"],
      }),
    );
    expect(connectors).toContain("ccs2");
  });

  it("treats a missing markets list as non-European", () => {
    const connectors = mapConnectors(raw({ charge_ports: [{ connector: "nacs" }], markets: [] }));
    expect(connectors).toContain("ccs1");
  });

  it("drops unknown connectors", () => {
    expect(mapConnectors(raw({ charge_ports: [{ connector: "inductive_magic" }] }))).toEqual([]);
    expect(
      mapConnectors(
        raw({ charge_ports: [{ connector: "inductive_magic" }, { connector: "ccs2" }] }),
      ),
    ).toEqual(["ccs2"]);
  });

  it("dedupes while preserving first-seen order", () => {
    expect(
      mapConnectors(
        raw({
          charge_ports: [{ connector: "type2" }, { connector: "ccs2" }, { connector: "type2" }],
        }),
      ),
    ).toEqual(["type2", "ccs2"]);
  });
});

describe("pickRange", () => {
  it("prefers wltp over epa", () => {
    const picked = pickRange(
      raw({
        range: {
          rated: [
            { cycle: "epa", range_km: 400 },
            { cycle: "wltp", range_km: 480 },
          ],
        },
      }),
    );
    expect(picked).toEqual({ km: 480, cycle: "wltp", notes: undefined });
  });

  it("falls back to the first usable entry for an unlisted cycle", () => {
    const picked = pickRange(raw({ range: { rated: [{ cycle: "other", range_km: 300 }] } }));
    expect(picked?.cycle).toBe("other");
    expect(picked?.km).toBe(300);
  });

  it("returns null without any usable rated range", () => {
    expect(pickRange(raw({ range: { rated: [] } }))).toBeNull();
    expect(pickRange(raw({ range: undefined }))).toBeNull();
    expect(pickRange(raw({ range: { rated: [{ cycle: "wltp", range_km: 0 }] } }))).toBeNull();
  });
});

describe("isHybrid", () => {
  it("is true for a phev unique_code", () => {
    expect(
      isHybrid(raw({ unique_code: "land_rover:range_rover_phev:2024:range_rover_phev" })),
    ).toBe(true);
  });

  it("is true for a range-extender or electric-only note", () => {
    expect(
      isHybrid(
        raw({
          range: {
            rated: [{ cycle: "cltc", range_km: 1645, notes: "Total range with range extender" }],
          },
        }),
      ),
    ).toBe(true);
    expect(
      isHybrid(
        raw({ range: { rated: [{ cycle: "wltp", range_km: 88, notes: "Electric-only range" }] } }),
      ),
    ).toBe(true);
  });

  it("is false for an Extended Range battery trim", () => {
    expect(
      isHybrid(
        raw({
          unique_code: "ford:mustang_mach_e:2024:mustang_mach_e_extended_range",
          trim: { name: "Extended Range" },
        }),
      ),
    ).toBe(false);
  });
});

describe("estimateMassTonnes", () => {
  it("uses the curb weight when present", () => {
    expect(estimateMassTonnes(raw({ weights: { curb_weight_kg: 2124 } }))).toBeCloseTo(2.124);
  });

  it.each([
    ["passenger_car", 1.9],
    ["suv", 2.2],
    ["van", 2.6],
    ["pickup", 2.9],
    ["other", 2.1],
  ])("falls back to %s -> %s t", (vehicleType, expected) => {
    expect(estimateMassTonnes(raw({ weights: undefined, vehicle_type: vehicleType }))).toBe(
      expected,
    );
  });
});

describe("buildLabel", () => {
  it("omits a Base trim", () => {
    expect(
      buildLabel(
        raw({
          make: { name: "Audi" },
          model: { name: "A6 e-tron" },
          trim: { name: "Base" },
          variant: { name: "Sportback" },
          year: 2024,
        }),
      ),
    ).toBe("Audi A6 e-tron Sportback (2024)");
  });

  it("includes a real trim name", () => {
    expect(
      buildLabel(
        raw({
          make: { name: "Tesla" },
          model: { name: "Model 3" },
          trim: { name: "Long Range" },
          variant: undefined,
          year: 2024,
        }),
      ),
    ).toBe("Tesla Model 3 Long Range (2024)");
  });

  it("collapses whitespace and survives a missing year", () => {
    expect(
      buildLabel(
        raw({
          make: { name: "Kia" },
          model: { name: "EV6 " },
          trim: undefined,
          variant: undefined,
          year: undefined,
        }),
      ),
    ).toBe("Kia EV6");
  });
});

describe("mapVehicle", () => {
  it("derives plausible consumption for a known car", () => {
    const r = mapVehicle({
      unique_code: "volkswagen:id_4:2024:id_4",
      make: { name: "Volkswagen" },
      model: { name: "ID.4" },
      year: 2024,
      vehicle_type: "suv",
      battery: { pack_capacity_kwh_net: 77 },
      charging: { ac: { max_power_kw: 11 }, dc: { max_power_kw: 135 } },
      range: { rated: [{ cycle: "wltp", range_km: 480 }] },
      weights: { curb_weight_kg: 2124 },
      charge_ports: [{ connector: "ccs2" }],
    } as never);
    if (!("ok" in r)) throw new Error("expected a mapped vehicle");
    expect(r.ok.baseWhPerKm).toBeGreaterThan(150);
    expect(r.ok.baseWhPerKm).toBeLessThan(230);
  });

  it("applies a different realism factor per cycle", () => {
    const wltp = mapVehicle(raw({ range: { rated: [{ cycle: "wltp", range_km: 480 }] } }));
    const cltc = mapVehicle(raw({ range: { rated: [{ cycle: "cltc", range_km: 480 }] } }));
    const epa = mapVehicle(raw({ range: { rated: [{ cycle: "epa", range_km: 480 }] } }));
    if (!("ok" in wltp) || !("ok" in cltc) || !("ok" in epa))
      throw new Error("expected mapped vehicles");
    expect(cltc.ok.baseWhPerKm).toBeGreaterThan(wltp.ok.baseWhPerKm);
    expect(wltp.ok.baseWhPerKm).toBeGreaterThan(epa.ok.baseWhPerKm);
  });

  it("carries the identity and spec fields through", () => {
    const r = mapVehicle(raw());
    if (!("ok" in r)) throw new Error("expected a mapped vehicle");
    expect(r.ok.id).toBe("volkswagen:id_4:2024:id_4");
    expect(r.ok.label).toBe("Volkswagen ID.4 (2024)");
    expect(r.ok.batteryKwh).toBe(77);
    expect(r.ok.maxDcKw).toBe(135);
    expect(r.ok.maxAcKw).toBe(11);
    expect(r.ok.massTonnes).toBeCloseTo(2.124);
    expect(r.ok.vehicleTaperSocPct).toBe(80);
    expect(r.ok.connectors).toEqual(["ccs2"]);
  });

  it("defaults a missing AC power to zero", () => {
    const r = mapVehicle(raw({ charging: { dc: { max_power_kw: 135 } } }));
    if (!("ok" in r)) throw new Error("expected a mapped vehicle");
    expect(r.ok.maxAcKw).toBe(0);
  });

  it.each([
    ["no-battery", { battery: undefined }],
    ["no-dc", { charging: { ac: { max_power_kw: 11 } } }],
    ["hybrid", { unique_code: "land_rover:range_rover_phev:2024:range_rover_phev" }],
    ["no-range", { range: { rated: [] } }],
    ["no-connectors", { charge_ports: [{ connector: "inductive_magic" }] }],
  ])("drops with reason %s", (reason, overrides) => {
    const r = mapVehicle(raw(overrides as Partial<RawVehicle>));
    expect(r).toEqual({ drop: reason });
  });
});
