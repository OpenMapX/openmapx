import { describe, expect, it } from "vitest";
import {
  buildLabel,
  dedupeVehicles,
  disambiguateLabels,
  estimateMassTonnes,
  type GeneratedVehicle,
  isHybrid,
  mapConnectors,
  mapVehicle,
  pickRange,
  type RawVehicle,
} from "../map-vehicle.ts";

/** A distilled record; individual tests override the fields they exercise. */
function generated(overrides: Partial<GeneratedVehicle> = {}): GeneratedVehicle {
  return {
    id: "bmw:i4:2024:i4",
    label: "BMW i4 eDrive40 (2024)",
    batteryKwh: 81.3,
    baseWhPerKm: 168,
    massTonnes: 2.05,
    maxDcKw: 207,
    maxAcKw: 11,
    vehicleTaperSocPct: 80,
    connectors: ["ccs2", "type2"],
    ...overrides,
  };
}

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
    ["ccs2", ["ccs2", "type2"]],
    ["ccs1", ["ccs1", "type1"]],
    ["type2", ["type2"]],
    ["type1", ["type1"]],
    ["chademo", ["chademo"]],
    ["gb_t_dc", ["gbt_dc"]],
    ["gb_t_ac", ["gbt_ac"]],
  ])("maps %s to %o", (connector, expected) => {
    expect(mapConnectors(raw({ charge_ports: [{ connector }] }))).toEqual(expected);
  });

  it("gives every CCS car the AC half of its own inlet", () => {
    expect(mapConnectors(raw({ charge_ports: [{ connector: "ccs2" }] }))).toContain("type2");
    expect(mapConnectors(raw({ charge_ports: [{ connector: "ccs1" }] }))).toContain("type1");
  });

  it("fans a European NACS car out to tesla_ccs and ccs2", () => {
    const connectors = mapConnectors(
      raw({ charge_ports: [{ connector: "nacs" }], markets: ["US", "DE", "NL"] }),
    );
    expect(connectors).toContain("nacs");
    expect(connectors).toContain("tesla_ccs");
    expect(connectors).toContain("ccs2");
    expect(connectors).toContain("type2");
    expect(connectors).not.toContain("ccs1");
  });

  it("fans a non-European NACS car out to tesla_ccs and ccs1", () => {
    const connectors = mapConnectors(
      raw({ charge_ports: [{ connector: "nacs" }], markets: ["US", "CA"] }),
    );
    expect(connectors).toContain("nacs");
    expect(connectors).toContain("tesla_ccs");
    expect(connectors).toContain("ccs1");
    expect(connectors).toContain("type1");
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
    ).toEqual(["ccs2", "type2"]);
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
  it("takes the entry implying the highest consumption, not a preferred cycle", () => {
    // wltp 480 * 0.82 = 393.6 effective; epa 400 * 1.0 = 400 effective — wltp is
    // the shorter corrected range, so it is the conservative pick here.
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

  it("rejects an over-optimistic wltp figure in favour of a sane epa one", () => {
    // The real 2024 Model Y Long Range AWD record: 719 km wltp * 0.82 = 589.6
    // effective vs 500 km epa * 1.0 = 500 — epa is the conservative candidate.
    const picked = pickRange(
      raw({
        range: {
          rated: [
            { cycle: "epa", range_km: 500 },
            { cycle: "wltp", range_km: 719 },
          ],
        },
      }),
    );
    expect(picked?.cycle).toBe("epa");
    expect(picked?.km).toBe(500);
  });

  it("uses the single usable entry for an unlisted cycle", () => {
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

  it("does not repeat a variant name that already matches the trim", () => {
    expect(
      buildLabel(
        raw({
          make: { name: "Tesla" },
          model: { name: "Model 3" },
          trim: { name: "Long Range" },
          variant: { name: "Long Range" },
          year: 2024,
        }),
      ),
    ).toBe("Tesla Model 3 Long Range (2024)");
  });

  it("folds a variant that merely extends the trim", () => {
    expect(
      buildLabel(
        raw({
          make: { name: "Tesla" },
          model: { name: "Model Y" },
          trim: { name: "Long Range" },
          variant: { name: "Long Range AWD" },
          year: 2024,
        }),
      ),
    ).toBe("Tesla Model Y Long Range AWD (2024)");
  });

  it("does not repeat the make when the model already starts with it", () => {
    expect(
      buildLabel(
        raw({
          make: { name: "Polestar" },
          model: { name: "Polestar 2" },
          trim: { name: "Long Range Dual Motor" },
          variant: undefined,
          year: 2024,
        }),
      ),
    ).toBe("Polestar 2 Long Range Dual Motor (2024)");
  });

  it("drops a trim the model name already ends with", () => {
    expect(
      buildLabel(
        raw({
          make: { name: "Mini" },
          model: { name: "Cooper SE" },
          trim: { name: "SE" },
          variant: undefined,
          year: 2024,
        }),
      ),
    ).toBe("Mini Cooper SE (2024)");
    expect(
      buildLabel(
        raw({
          make: { name: "BMW" },
          model: { name: "iX3" },
          trim: { name: "iX3" },
          variant: undefined,
          year: 2025,
        }),
      ),
    ).toBe("BMW iX3 (2025)");
  });

  it("merges a make and model that share a word", () => {
    expect(
      buildLabel(
        raw({
          make: { name: "GAC Aion" },
          model: { name: "Aion ES" },
          trim: { name: "Base" },
          variant: undefined,
          year: 2024,
        }),
      ),
    ).toBe("GAC Aion ES (2024)");
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
    expect(r.ok.connectors).toEqual(["ccs2", "type2"]);
  });

  it("derives consumption from the most pessimistic rated cycle", () => {
    // Real 2024 Tesla Model Y Long Range AWD: the 719 km wltp figure is not
    // physical and would yield 134 Wh/km, under the ~165 the car really uses.
    const r = mapVehicle(
      raw({
        unique_code: "tesla:model_y:2024:model_y_long_range_awd",
        make: { name: "Tesla" },
        model: { name: "Model Y" },
        trim: { name: "Long Range" },
        variant: { name: "Long Range AWD" },
        battery: { pack_capacity_kwh_net: 79 },
        weights: { curb_weight_kg: 2003 },
        range: {
          rated: [
            { cycle: "epa", range_km: 500 },
            { cycle: "wltp", range_km: 719 },
          ],
        },
      }),
    );
    if (!("ok" in r)) throw new Error("expected a mapped vehicle");
    expect(r.ok.baseWhPerKm).toBe(158);
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

describe("dedupeVehicles", () => {
  it("collapses two records that distil to the same car", () => {
    const { kept, collapsed } = dedupeVehicles([
      generated({ id: "bmw:i4:2024:i4_edrive40" }),
      generated({ id: "bmw:i4:2024:i4" }),
    ]);
    expect(collapsed).toBe(1);
    expect(kept).toHaveLength(1);
    // Deterministic: the lowest id wins regardless of input order.
    expect(kept[0].id).toBe("bmw:i4:2024:i4");
  });

  it("ignores connector order when comparing but leaves the stored order alone", () => {
    const { kept, collapsed } = dedupeVehicles([
      generated({ id: "a:b:2024:x", connectors: ["type2", "ccs2"] }),
      generated({ id: "a:b:2024:y", connectors: ["ccs2", "type2"] }),
    ]);
    expect(collapsed).toBe(1);
    expect(kept[0].connectors).toEqual(["type2", "ccs2"]);
  });

  it.each([
    ["label", { label: "BMW i4 M50 (2024)" }],
    ["batteryKwh", { batteryKwh: 70 }],
    ["baseWhPerKm", { baseWhPerKm: 200 }],
    ["massTonnes", { massTonnes: 2.3 }],
    ["maxDcKw", { maxDcKw: 150 }],
    ["maxAcKw", { maxAcKw: 22 }],
    ["vehicleTaperSocPct", { vehicleTaperSocPct: 70 }],
    ["connectors", { connectors: ["ccs1", "type1"] }],
  ])("keeps both records when %s differs", (_field, difference) => {
    const { kept, collapsed } = dedupeVehicles([
      generated({ id: "a:b:2024:x" }),
      generated({ id: "a:b:2024:y", ...(difference as Partial<GeneratedVehicle>) }),
    ]);
    expect(collapsed).toBe(0);
    expect(kept).toHaveLength(2);
  });

  it("returns an empty result for an empty list", () => {
    expect(dedupeVehicles([])).toEqual({ kept: [], collapsed: 0 });
  });
});

describe("disambiguateLabels", () => {
  it("leaves every label alone when none collide", () => {
    const list = [
      generated({ id: "a:b:2024:x" }),
      generated({ id: "a:b:2024:y", label: "BMW i4 M50 (2024)" }),
    ];
    expect(disambiguateLabels(list).map((v) => v.label)).toEqual([
      "BMW i4 eDrive40 (2024)",
      "BMW i4 M50 (2024)",
    ]);
  });

  it("appends the battery size when two different cars share a name", () => {
    const list = [
      generated({ id: "a:b:2024:x", batteryKwh: 81.3 }),
      generated({ id: "a:b:2024:y", batteryKwh: 70.2 }),
    ];
    expect(disambiguateLabels(list).map((v) => v.label)).toEqual([
      "BMW i4 eDrive40 (2024) · 81.3 kWh",
      "BMW i4 eDrive40 (2024) · 70.2 kWh",
    ]);
  });

  it("falls back to DC power when the battery is equal too", () => {
    const list = [
      generated({ id: "a:b:2024:x", maxDcKw: 207 }),
      generated({ id: "a:b:2024:y", maxDcKw: 150 }),
    ];
    expect(disambiguateLabels(list).map((v) => v.label)).toEqual([
      "BMW i4 eDrive40 (2024) · 207 kW",
      "BMW i4 eDrive40 (2024) · 150 kW",
    ]);
  });
});
