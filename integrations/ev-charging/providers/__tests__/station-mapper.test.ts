import { isI18nToken } from "@openmapx/integration-framework/strings";
import type {
  EvChargingPriceComponent,
  EvChargingStation,
} from "@openmapx/mobility-core/ev-charging";
import { describe, expect, it } from "vitest";
import { formatTariff, mapStationToDetail, mapStationToResult } from "../station-mapper.js";

function makeStation(overrides: Partial<EvChargingStation> = {}): EvChargingStation {
  return {
    id: "ocm:1",
    name: "Test Charger",
    coordinates: [11.575, 48.137],
    sources: ["ocm"],
    connectors: [
      { type: "CCS", powerKw: 50, currentType: "DC", quantity: 2, status: "operational" },
    ],
    ...overrides,
  };
}

describe("ev-charging station mapper", () => {
  it("emits I18nToken for section titles and row labels (no English literals cross the contract)", () => {
    const station = makeStation({
      access: "24/7",
      membershipRequired: true,
      notes: ["Open year-round"],
      paymentMethods: ["Credit card", "App"],
      sourceUrl: "https://example.com/station/1",
      updatedAt: "2026-05-06T11:00:00.000Z",
      usageCost: "0.35 EUR/kWh",
      usageType: "Public",
    });
    const detail = mapStationToDetail(station);

    expect(detail.sections.length).toBeGreaterThan(0);
    for (const section of detail.sections) {
      expect(
        isI18nToken(section.title),
        `section.title should be I18nToken, got: ${JSON.stringify(section.title)}`,
      ).toBe(true);
      if (section.columns) {
        for (const column of section.columns) {
          expect(
            isI18nToken(column),
            `column should be I18nToken, got: ${JSON.stringify(column)}`,
          ).toBe(true);
        }
      }
      // Label/value tables (no header columns) — the first cell of each row is a label.
      // Tables with `columns` (header row) carry data cells only, not labels.
      if (section.rows && !section.columns) {
        for (const [label] of section.rows) {
          expect(
            isI18nToken(label),
            `row label should be I18nToken, got: ${JSON.stringify(label)}`,
          ).toBe(true);
        }
      }
    }
  });

  it("emits I18nToken for summary on result cards", () => {
    const result = mapStationToResult(makeStation());
    expect(isI18nToken(result.summary)).toBe(true);
  });

  it("uses shared tokens for Access, Notes, and Source sections", () => {
    const detail = mapStationToDetail(
      makeStation({
        access: "24/7",
        notes: ["Free for customers"],
        sourceUrl: "https://example.com/station/1",
        updatedAt: "2026-05-06T11:00:00.000Z",
      }),
    );

    expect(detail.sections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: { $t: "shared.section.access" } }),
        expect.objectContaining({ title: { $t: "shared.section.notes" } }),
        expect.objectContaining({
          title: { $t: "shared.section.source" },
          rows: expect.arrayContaining([
            [{ $t: "shared.row.sources" }, "ocm"],
            [{ $t: "shared.row.lastUpdated" }, "2026-05-06 11:00:00 UTC"],
            [{ $t: "shared.row.sourceUrl" }, "https://example.com/station/1"],
          ]),
        }),
      ]),
    );
  });

  it("emits parameterized summary tokens with connector count and power", () => {
    const summary = mapStationToResult(makeStation()).summary;
    expect(summary).toEqual({
      $t: "summary.connectorsTypedPower",
      values: { count: 2, types: "CCS", power: 50 },
    });
  });

  it("resolves source ids to display names via the provided resolver", () => {
    const names: Record<string, string> = { ocm: "OpenChargeMap", osm: "OpenStreetMap" };
    const detail = mapStationToDetail(
      makeStation({ sources: ["ocm", "osm"] }),
      (id) => names[id] ?? id,
    );
    const sourceSection = detail.sections.find(
      (s) => isI18nToken(s.title) && s.title.$t === "shared.section.source",
    );
    const sourcesRow = sourceSection?.rows?.find(
      ([label]) => isI18nToken(label) && label.$t === "shared.row.sources",
    );
    expect(sourcesRow?.[1]).toBe("OpenChargeMap, OpenStreetMap");
  });

  it("renders payment methods as readable, brand-cased, deduped text", () => {
    const detail = mapStationToDetail(
      makeStation({ paymentMethods: ["mastercard", "visa", "apple_pay", "mastercard"] }),
    );
    const usageSection = detail.sections.find(
      (s) => isI18nToken(s.title) && s.title.$t === "section.usage",
    );
    const paymentRow = usageSection?.rows?.find(
      ([label]) => isI18nToken(label) && label.$t === "row.payment",
    );
    expect(paymentRow?.[1]).toBe("Mastercard, Visa, Apple Pay");
  });

  it("passes availability + a sortable available count into the result", () => {
    const station = makeStation({
      isLive: true,
      availability: { available: 2, total: 4, updatedAt: "2026-07-20T10:00:00Z" },
    });
    const result = mapStationToResult(station);
    expect(result.availability).toEqual({ available: 2, total: 4 });
    expect(result.sortValues?.available).toBe(2);
    expect(result.sortValues?.powerKw).toBe(50);
  });

  it("omits availability for static stations", () => {
    const result = mapStationToResult(makeStation({ isLive: undefined, availability: undefined }));
    expect(result.availability).toBeUndefined();
    expect(result.sortValues?.available).toBeUndefined();
  });

  it("adds an availability caption to the connectors section when live", () => {
    const station = makeStation({
      isLive: true,
      availability: { available: 3, total: 6, updatedAt: "2026-07-20T10:00:00Z" },
    });
    const detail = mapStationToDetail(station);
    const connectors = detail.sections.find((s) => s.sectionIcon === "bolt");
    expect(connectors?.caption).toEqual({
      $t: "availability",
      values: { available: 3, total: 6 },
    });
  });

  it("omits the connectors section caption for static stations", () => {
    const station = makeStation({ isLive: undefined, availability: undefined });
    const detail = mapStationToDetail(station);
    const connectors = detail.sections.find((s) => s.sectionIcon === "bolt");
    expect(connectors?.caption).toBeUndefined();
  });

  it("carries the availability updatedAt as captionTimestamp on the connectors section", () => {
    const station = makeStation({
      isLive: true,
      availability: { available: 3, total: 6, updatedAt: "2026-07-20T10:00:00Z" },
    });
    const detail = mapStationToDetail(station);
    const connectors = detail.sections.find((s) => s.sectionIcon === "bolt");
    expect(connectors?.captionTimestamp).toBe("2026-07-20T10:00:00Z");
  });

  it("omits captionTimestamp for static stations", () => {
    const station = makeStation({ isLive: undefined, availability: undefined });
    const detail = mapStationToDetail(station);
    const connectors = detail.sections.find((s) => s.sectionIcon === "bolt");
    expect(connectors?.captionTimestamp).toBeUndefined();
  });
});

describe("formatTariff", () => {
  it("emits a per-dimension price token with the formatted money as its amount param", () => {
    const component: EvChargingPriceComponent = { type: "energy", price: 0.59, currency: "EUR" };
    expect(formatTariff(component)).toEqual({
      $t: "priceEnergy",
      values: { amount: "€0.59" },
    });
  });

  it("uses the time price token", () => {
    const component: EvChargingPriceComponent = { type: "time", price: 0.05, currency: "EUR" };
    expect(formatTariff(component)).toEqual({
      $t: "priceTime",
      values: { amount: "€0.05" },
    });
  });

  it("uses the flat/session price token", () => {
    const component: EvChargingPriceComponent = { type: "flat", price: 0.5, currency: "EUR" };
    expect(formatTariff(component)).toEqual({
      $t: "priceFlat",
      values: { amount: "€0.50" },
    });
  });

  it("uses the parking price token", () => {
    const component: EvChargingPriceComponent = { type: "parking", price: 2, currency: "EUR" };
    expect(formatTariff(component)).toEqual({
      $t: "priceParking",
      values: { amount: "€2.00" },
    });
  });

  it("formats a non-EUR currency using its symbol", () => {
    const component: EvChargingPriceComponent = { type: "energy", price: 0.45, currency: "USD" };
    expect(formatTariff(component)).toEqual({
      $t: "priceEnergy",
      values: { amount: "$0.45" },
    });
  });

  it("falls back to the raw currency code when no symbol is known", () => {
    const component: EvChargingPriceComponent = { type: "energy", price: 3.5, currency: "SEK" };
    expect(formatTariff(component)).toEqual({
      $t: "priceEnergy",
      values: { amount: "SEK 3.50" },
    });
  });
});

describe("mapStationToDetail connectors section grouping", () => {
  it("collapses six identical connectors into one grouped row with quantity 6", () => {
    const station = makeStation({
      connectors: Array.from({ length: 6 }, () => ({
        type: "Type 2",
        powerKw: 22,
        currentType: "AC",
        quantity: 1,
        status: "operational",
      })),
    });
    const detail = mapStationToDetail(station);
    const connectors = detail.sections.find((s) => s.sectionIcon === "bolt");
    expect(connectors?.rows).toHaveLength(1);
    expect(connectors?.rows?.[0]).toEqual(["Type 2", "22 kW", "AC", 6, "operational"]);
  });

  it("groups a mixed-connector station into the correct distinct rows", () => {
    const station = makeStation({
      connectors: [
        { type: "Type 2", powerKw: 22, currentType: "AC", quantity: 1, status: "operational" },
        { type: "Type 2", powerKw: 22, currentType: "AC", quantity: 1, status: "operational" },
        { type: "CCS", powerKw: 150, currentType: "DC", quantity: 1, status: "operational" },
        { type: "CHAdeMO", powerKw: 50, currentType: "DC", quantity: 2, status: "operational" },
      ],
    });
    const detail = mapStationToDetail(station);
    const connectors = detail.sections.find((s) => s.sectionIcon === "bolt");
    expect(connectors?.rows).toEqual([
      ["CCS", "150 kW", "DC", 1, "operational"],
      ["CHAdeMO", "50 kW", "DC", 2, "operational"],
      ["Type 2", "22 kW", "AC", 2, "operational"],
    ]);
  });
});

describe("mapStationToDetail pricing section", () => {
  it("renders a payments-icon Pricing table from structured tariffs, with a direct-price caption", () => {
    const station = makeStation({
      tariffs: [
        {
          elements: [{ type: "energy", price: 0.59, currency: "EUR" }],
          scope: "evse",
          isDirectPayment: true,
          source: "ocm",
          updatedAt: "2026-07-01T00:00:00.000Z",
        },
      ],
    });
    const detail = mapStationToDetail(station);
    const pricing = detail.sections.find((s) => s.sectionIcon === "payments" && s.caption);
    expect(pricing).toBeDefined();
    expect(pricing?.rows).toEqual(
      expect.arrayContaining([
        [expect.anything(), { $t: "priceEnergy", values: { amount: "€0.59" } }],
      ]),
    );
    expect(isI18nToken(pricing?.caption)).toBe(true);
  });

  it("collects rows from all price components across all tariffs, with no Conditions column when no tariff has restrictions", () => {
    const station = makeStation({
      tariffs: [
        {
          elements: [
            { type: "energy", price: 0.59, currency: "EUR" },
            { type: "parking", price: 2, currency: "EUR" },
          ],
          scope: "evse",
          source: "ocm",
          updatedAt: "2026-07-01T00:00:00.000Z",
        },
        {
          elements: [{ type: "flat", price: 0.5, currency: "EUR" }],
          scope: "cpo",
          source: "ocm",
          updatedAt: "2026-07-01T00:00:00.000Z",
        },
      ],
    });
    const detail = mapStationToDetail(station);
    const pricing = detail.sections.find((s) => s.sectionIcon === "payments" && s.caption);
    expect(pricing?.columns).toBeUndefined();
    expect(pricing?.rows).toHaveLength(3);
    expect(pricing?.rows).toEqual(
      expect.arrayContaining([
        [expect.anything(), { $t: "priceEnergy", values: { amount: "€0.59" } }],
        [expect.anything(), { $t: "priceParking", values: { amount: "€2.00" } }],
        [expect.anything(), { $t: "priceFlat", values: { amount: "€0.50" } }],
      ]),
    );
  });

  it("adds a Conditions column when an AC and a DC energy tariff would otherwise collide on the same row label", () => {
    const station = makeStation({
      tariffs: [
        {
          elements: [{ type: "energy", price: 0.35, currency: "EUR" }],
          restrictions: { currentType: "ac", maxPowerKw: 22 },
          scope: "evse",
          source: "ocm",
          updatedAt: "2026-07-01T00:00:00.000Z",
        },
        {
          elements: [{ type: "energy", price: 0.55, currency: "EUR" }],
          restrictions: { currentType: "dc", minPowerKw: 50 },
          scope: "evse",
          source: "ocm",
          updatedAt: "2026-07-01T00:00:00.000Z",
        },
      ],
    });
    const detail = mapStationToDetail(station);
    const pricing = detail.sections.find((s) => s.sectionIcon === "payments" && s.caption);
    expect(pricing?.columns).toEqual([
      { $t: "shared.row.type" },
      { $t: "column.price" },
      { $t: "column.conditions" },
    ]);
    expect(pricing?.rows).toEqual(
      expect.arrayContaining([
        [expect.anything(), expect.anything(), "AC · ≤22 kW"],
        [expect.anything(), expect.anything(), "DC · ≥50 kW"],
      ]),
    );
  });

  it("gives rows without restrictions an empty conditions cell once the column exists", () => {
    const station = makeStation({
      tariffs: [
        {
          elements: [{ type: "energy", price: 0.35, currency: "EUR" }],
          restrictions: { currentType: "ac" },
          scope: "evse",
          source: "ocm",
          updatedAt: "2026-07-01T00:00:00.000Z",
        },
        {
          elements: [{ type: "parking", price: 2, currency: "EUR" }],
          scope: "evse",
          source: "ocm",
          updatedAt: "2026-07-01T00:00:00.000Z",
        },
      ],
    });
    const detail = mapStationToDetail(station);
    const pricing = detail.sections.find((s) => s.sectionIcon === "payments" && s.caption);
    expect(pricing?.rows).toEqual(
      expect.arrayContaining([
        [expect.anything(), expect.anything(), "AC"],
        [expect.anything(), expect.anything(), "-"],
      ]),
    );
  });

  it("falls back to the free-text usageCost row when there are no structured tariffs", () => {
    const station = makeStation({ usageCost: "0.35 EUR/kWh" });
    const detail = mapStationToDetail(station);
    const pricing = detail.sections.find((s) => s.sectionIcon === "payments" && s.caption);
    expect(pricing).toBeUndefined();
    const usageSection = detail.sections.find(
      (s) => isI18nToken(s.title) && s.title.$t === "section.usage",
    );
    const costRow = usageSection?.rows?.find(
      ([label]) => isI18nToken(label) && label.$t === "row.cost",
    );
    expect(costRow?.[1]).toBe("0.35 EUR/kWh");
  });

  it("exposes a distinct blurb+link on the pricing section for tariffs carrying altText/sourceUrl", () => {
    const station = makeStation({
      tariffs: [
        {
          elements: [{ type: "energy", price: 0.48, currency: "EUR" }],
          scope: "cpo",
          source: "netherlands-ev",
          sourceUrl: "https://example.org/tariffs/1",
          altText: "Night rate applies 00:00-07:00",
          updatedAt: "2026-07-01T00:00:00.000Z",
        },
        // Same (altText, sourceUrl) pair again — must be deduped.
        {
          elements: [{ type: "parking", price: 2, currency: "EUR" }],
          scope: "cpo",
          source: "netherlands-ev",
          sourceUrl: "https://example.org/tariffs/1",
          altText: "Night rate applies 00:00-07:00",
          updatedAt: "2026-07-01T00:00:00.000Z",
        },
        // Distinct pair.
        {
          elements: [{ type: "flat", price: 0.5, currency: "EUR" }],
          scope: "cpo",
          source: "netherlands-ev",
          sourceUrl: "https://example.org/tariffs/2",
          updatedAt: "2026-07-01T00:00:00.000Z",
        },
      ],
    });
    const detail = mapStationToDetail(station);
    const pricing = detail.sections.find((s) => s.sectionIcon === "payments" && s.caption);
    expect(pricing?.links).toEqual([
      { label: "Night rate applies 00:00-07:00", url: "https://example.org/tariffs/1" },
      { label: { $t: "tariffDetails" }, url: "https://example.org/tariffs/2" },
    ]);
  });

  it("omits links when no tariff has altText or sourceUrl", () => {
    const station = makeStation({
      tariffs: [
        {
          elements: [{ type: "energy", price: 0.48, currency: "EUR" }],
          scope: "cpo",
          source: "ocm",
          updatedAt: "2026-07-01T00:00:00.000Z",
        },
      ],
    });
    const detail = mapStationToDetail(station);
    const pricing = detail.sections.find((s) => s.sectionIcon === "payments" && s.caption);
    expect(pricing?.links).toBeUndefined();
  });
});
