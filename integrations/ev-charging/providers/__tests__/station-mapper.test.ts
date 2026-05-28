import { isI18nToken } from "@openmapx/integration-framework/strings";
import type { EvChargingStation } from "@openmapx/mobility-core/ev-charging";
import { describe, expect, it } from "vitest";
import { mapStationToDetail, mapStationToResult } from "../station-mapper.js";

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
});
