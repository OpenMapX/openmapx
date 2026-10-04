import { isI18nToken, resolveToken } from "@openmapx/integration-framework/strings";
import type { FuelProduct, FuelStation } from "@openmapx/mobility-core/fuel";
import { describe, expect, it } from "vitest";
import { mapFuelStationToDetail, mapFuelStationToResult } from "../mapper.js";
import de from "../strings/de.json";
import en from "../strings/en.json";

/** OpenConditions' `fuel_grade` vocabulary: every grade a provider can hand over. */
const OC_FUEL_GRADES = [
  "e5",
  "e10",
  "sp98",
  "e85",
  "diesel",
  "diesel_premium",
  "hvo100",
  "b7",
  "b10",
  "b100",
  "lpg",
  "cng",
  "lng",
  "h2_350",
  "h2_700",
  "adblue",
  "ethanol",
  "kerosene",
  "e25",
  "renewable_petrol",
  "agricultural_diesel",
  "methanol",
  "ammonia",
  "e5_premium",
  "sp98_e10",
  "cng_bio",
  "lng_bio",
];

function text(token: unknown, locale = "en"): string {
  return resolveToken(token as Parameters<typeof resolveToken>[0], {
    locale,
    fallbackLocale: "en",
    shared: {},
    integration: { en, de },
  });
}

const AT = "2026-10-01T08:00:00Z";

function product(over: Partial<FuelProduct> & Pick<FuelProduct, "grade">): FuelProduct {
  return { key: over.grade, per: "L", available: true, ...over };
}

function eur(amount: number): FuelProduct["price"] {
  return { amount, currency: "EUR" };
}

function makeStation(overrides: Partial<FuelStation> = {}): FuelStation {
  return {
    id: "oc:feature:de-mtsk-prices:abc",
    name: "Test Station",
    coordinates: [11.5, 48.5],
    products: [
      product({ grade: "diesel", price: eur(1.559), priceAt: AT }),
      product({ grade: "e5", price: eur(1.699), priceAt: AT }),
      product({ grade: "e10", price: eur(1.639), priceAt: AT }),
    ],
    productsComplete: false,
    sources: ["de-mtsk-prices"],
    attributions: [{ sourceId: "de-mtsk-prices", name: "MTS-K" }],
    ...overrides,
  };
}

describe("mapFuelStationToResult", () => {
  it("sorts each grade by its lowest self-service or standard per-litre price", () => {
    const result = mapFuelStationToResult(
      makeStation({
        products: [
          product({ key: "diesel:self", grade: "diesel", service: "self", price: eur(1.599) }),
          product({ key: "diesel:served", grade: "diesel", service: "served", price: eur(1.399) }),
          product({ key: "diesel", grade: "diesel", price: eur(1.649) }),
          product({ grade: "cng", per: "kg", price: eur(1.199) }),
          product({ grade: "e5", price: { amount: 1.9, currency: "CHF" } }),
          product({ grade: "e10", price: eur(1.689) }),
        ],
      }),
    );

    expect(result.sortValues).toEqual({ diesel: 1.599, e10: 1.689 });
    expect(result.currency).toBe("EUR");
  });

  it("summarises the six summary grades as a token", () => {
    const result = mapFuelStationToResult(makeStation());
    expect(isI18nToken(result.summary)).toBe(true);
    expect(text(result.summary)).toBe("D 1.559 EUR · E5 1.699 EUR · E10 1.639 EUR");
  });

  it("summarises served and per-kg prices too, with their unit, but sorts by neither", () => {
    const served = mapFuelStationToResult(
      makeStation({
        products: [product({ grade: "e5", service: "served", price: eur(1.899), priceAt: AT })],
      }),
    );
    expect(served.sortValues).toBeUndefined();
    expect(text(served.summary)).toBe("E5 1.899 EUR");

    const gas = mapFuelStationToResult(
      makeStation({
        products: [
          product({ grade: "cng", per: "kg", price: eur(1.299), priceAt: AT }),
          product({ grade: "lng", per: "kg", price: eur(1.459), priceAt: AT }),
        ],
      }),
    );
    expect(gas.sortValues).toBeUndefined();
    expect(text(gas.summary)).toBe("CNG 1.299 EUR/kg · LNG 1.459 EUR/kg");

    // A self-service price is the grade's summary; the served one only stands in.
    const both = mapFuelStationToResult(
      makeStation({
        products: [
          product({ key: "diesel:served", grade: "diesel", service: "served", price: eur(1.699) }),
          product({ key: "diesel:self", grade: "diesel", service: "self", price: eur(1.599) }),
          product({ grade: "cng", per: "kg", price: eur(1.299) }),
        ],
      }),
    );
    expect(both.sortValues).toEqual({ diesel: 1.599 });
    expect(text(both.summary)).toBe("D 1.599 EUR · CNG 1.299 EUR/kg");
  });

  it("gives every station pricesOnly keeps a price summary", () => {
    const only = (p: FuelProduct) => mapFuelStationToResult(makeStation({ products: [p] }));
    for (const p of [
      product({ grade: "hvo100", service: "served", price: eur(1.999) }),
      product({ grade: "h2_700", per: "kg", price: eur(13.85) }),
      product({ grade: "diesel", vehicleScope: "hgv", price: eur(1.489) }),
    ]) {
      expect(only(p).summary, p.grade).toBeDefined();
    }
  });

  it("a lorry-only grade summary uses the translated HGV suffix", () => {
    const station = (...products: FuelProduct[]) =>
      mapFuelStationToResult(makeStation({ products }));
    const lorry = (grade: string, per: FuelProduct["per"] = "L") =>
      product({ grade, vehicleScope: "hgv", per, price: eur(1.489) });
    const mixed = station(lorry("diesel"), product({ grade: "e5", price: eur(1.699) })).summary;
    expect(text(mixed, "en")).toBe("E5 1.699 EUR · D 1.489 EUR (HGV)");
    expect(text(mixed, "de")).toBe("E5 1.699 EUR · D 1.489 EUR (Lkw)");
    const only = station(lorry("diesel")).summary;
    expect(text(only, "en")).toBe("D 1.489 EUR (HGV)");
    expect(text(only, "de")).toBe("D 1.489 EUR (Lkw)");
    const lng = station(lorry("lng", "kg")).summary;
    expect(text(lng, "de")).toBe("LNG 1.489 EUR/kg (Lkw)");
    expect(text(lng, "de")).not.toContain("summary.");
  });

  it("labels every grade on the card in every locale, never as an uppercase code", () => {
    for (const grade of OC_FUEL_GRADES) {
      const summary = mapFuelStationToResult(
        makeStation({ products: [product({ grade, price: eur(1.5) })] }),
      ).summary;
      for (const locale of ["en", "de"]) {
        const shown = text(summary, locale);
        const label = (locale === "en" ? en : de).summary.grade[
          grade as keyof typeof en.summary.grade
        ];
        expect(label, `${grade} ${locale}`).toBeTruthy();
        expect(shown, `${grade} ${locale}`).toBe(`${label} 1.500 EUR`);
      }
    }
    const kerosene = mapFuelStationToResult(
      makeStation({ products: [product({ grade: "kerosene", price: eur(2.1) })] }),
    ).summary;
    expect(text(kerosene, "de")).toBe("Kerosin 2.100 EUR");
    expect(text(kerosene, "en")).toBe("Kerosene 2.100 EUR");
    const unknown = mapFuelStationToResult(
      makeStation({ products: [product({ grade: "new_fuel", price: eur(2.1) })] }),
    ).summary;
    expect(text(unknown)).toBe("NEW FUEL 2.100 EUR");
  });

  it("has no sort values, summary or time without a priced product", () => {
    const result = mapFuelStationToResult(
      makeStation({ products: [product({ grade: "diesel", available: "unknown" })] }),
    );
    expect(result.sortValues).toBeUndefined();
    expect(result.summary).toBeUndefined();
    expect(result.observedAt).toBeUndefined();
    expect(result.currency).toBeUndefined();
  });

  it("takes the first source as the result's source", () => {
    const result = mapFuelStationToResult(makeStation({ sources: ["fr-roulez-eco", "osm"] }));
    expect(result.source).toBe("fr-roulez-eco");
    expect(result.sources).toEqual(["fr-roulez-eco", "osm"]);
  });

  it("reads open or closed from the opening hours", () => {
    expect(mapFuelStationToResult(makeStation({ openingHours: "24/7" })).variant).toBe("open");
    expect(mapFuelStationToResult(makeStation({ openingHours: "off" })).variant).toBe("closed");
    expect(mapFuelStationToResult(makeStation()).variant).toBe("unknown");
    expect(mapFuelStationToResult(makeStation({ openingHours: "nonsense" })).variant).toBe(
      "unknown",
    );
  });

  it("leaves branding unset for a brand the catalog does not hold", () => {
    expect(mapFuelStationToResult(makeStation({ brand: "Zzyzx Fuel" })).branding).toBeUndefined();
  });
});

describe("mapFuelStationToDetail", () => {
  it("emits tokens for the title, columns and every row label", () => {
    const detail = mapFuelStationToDetail(makeStation());
    const table = detail.sections.find((s) => s.sectionIcon === "fuel");
    expect(table?.title).toEqual({ $t: "section.fuelPrices" });
    expect(table?.columns).toEqual([{ $t: "column.fuelType" }, { $t: "column.price" }]);
    for (const [label] of table?.rows ?? []) expect(isI18nToken(label)).toBe(true);
  });

  it("names the service and the unit of a product", () => {
    const detail = mapFuelStationToDetail(
      makeStation({
        products: [
          product({
            key: "diesel:served",
            grade: "diesel",
            service: "served",
            price: eur(1.799),
            priceAt: AT,
          }),
          product({ key: "diesel:self", grade: "diesel", service: "self" }),
          product({ grade: "cng", per: "kg", price: eur(1.199) }),
          product({ grade: "lng", per: "m3", price: eur(2.5) }),
        ],
      }),
    );
    expect(detail.sections[0].rows).toEqual([
      [
        { $t: "fuel.diesel" },
        "1.799 EUR/L",
        { $t: "product.servicePriceAt", values: { service: "served", at: Date.parse(AT) } },
      ],
      [
        { $t: "fuel.diesel" },
        { $t: "product.noPrice" },
        { $t: "product.service", values: { service: "self" } },
      ],
      [{ $t: "fuel.cng" }, "1.199 EUR/kg", ""],
      [{ $t: "fuel.lng" }, "2.500 EUR/m³", ""],
    ]);
  });

  it("labels lorry diesel apart and keeps it out of the price sort", () => {
    const station = makeStation({
      products: [
        product({ grade: "diesel", price: eur(1.659), priceAt: AT }),
        product({ key: "diesel:hgv", grade: "diesel", vehicleScope: "hgv", price: eur(1.459) }),
      ],
    });

    expect(mapFuelStationToResult(station).sortValues).toEqual({ diesel: 1.659 });
    const rows = mapFuelStationToDetail(station).sections[0].rows;
    expect(rows.map(([label]) => label)).toEqual([
      { $t: "fuel.diesel" },
      { $t: "fuelHgv", values: { grade: { $t: "fuel.diesel" } } },
    ]);
    expect(text(rows[1][0], "en")).toBe("Diesel (HGV)");
    expect(text(rows[1][0], "de")).toBe("Diesel (Lkw)");
  });

  it("has no price table for a station without products", () => {
    expect(mapFuelStationToDetail(makeStation({ products: [] })).sections).toEqual([]);
  });

  it("carries the brand as identity and operator", () => {
    const detail = mapFuelStationToDetail(makeStation({ brand: "Aral", country: "DE" }));
    expect(detail.identity).toEqual({ brand: "Aral", operator: "Aral" });
    expect(detail.operator).toEqual({ name: "Aral" });
    expect(detail.branding?.logoUrl).toBeTruthy();
  });
});

describe("fuel strings", () => {
  it("label every grade of the vocabulary on the card, and only those", () => {
    for (const catalog of [en, de]) {
      expect(Object.keys(catalog.summary.grade).sort()).toEqual([...OC_FUEL_GRADES].sort());
    }
  });

  it("label every grade of the vocabulary in every locale", () => {
    for (const catalog of [en, de]) {
      const labels = catalog.fuel as Record<string, string>;
      for (const grade of OC_FUEL_GRADES) expect(labels[grade], grade).toBeTruthy();
    }
  });

  it("format each product caption with its own time", () => {
    const resolve = (t: { $t: string; values?: Record<string, string | number> }) =>
      resolveToken(t, { locale: "en", fallbackLocale: "en", shared: {}, integration: { en } });
    const at = Date.parse("2026-10-01T08:00:00Z");
    expect(resolve({ $t: "product.priceAt", values: { at } })).toMatch(/^Updated \S.*\d/);
    expect(resolve({ $t: "product.servicePriceAt", values: { service: "self", at } })).toMatch(
      /^Self-service · updated \S.*\d/,
    );
    expect(resolve({ $t: "product.service", values: { service: "served" } })).toBe("Served");
  });
});
