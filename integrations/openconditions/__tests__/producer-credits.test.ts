import { describe, expect, it } from "vitest";
import { recordToChargingSite } from "../charging/map.js";
import type { Rec } from "../features/record.js";
import { recordToParkingSite } from "../parking/map.js";
import { situationToRoadConditionEvent } from "../road-conditions/situation.js";
import charging from "./fixtures/features-charging.json" with { type: "json" };
import parking from "./fixtures/features-parking.json" with { type: "json" };

const licensing = {
  version: 1,
  bindings: [
    {
      scope: "data",
      subject: "Captured product",
      license: { kind: "spdx", expression: "CC-BY-4.0" },
    },
  ],
};
const provenance = {
  sourceId: "captured-feed",
  attribution: {
    provider: "Captured notice",
    name: "Captured product",
    publisher: { name: "Captured publisher" },
    licensing,
    licenseUrl: "https://captured.example/terms",
  },
  upstream: [
    {
      publisher: "Historical publisher",
      source: {
        sourceId: "historical-feed",
        attribution: {
          provider: "Historical notice",
          name: "Historical product",
          licensing,
          licenseUrl: "https://historical.example/terms",
        },
      },
    },
  ],
};
const expected = [
  expect.objectContaining({
    sourceId: "captured-feed",
    name: "Captured product",
    publisher: { name: "Captured publisher" },
    licensing: expect.objectContaining({
      declarations: [{ url: "https://captured.example/terms" }],
    }),
  }),
  expect.objectContaining({
    sourceId: "historical-feed",
    name: "Historical product",
    licensing: expect.objectContaining({
      declarations: [{ url: "https://historical.example/terms" }],
    }),
  }),
];

describe("captured producer receipts", () => {
  it("keeps a derived situation's full captured source and historical suppliers", () => {
    const event = situationToRoadConditionEvent({
      id: "derived",
      location: { geometry: { type: "Point", coordinates: [6, 51] } },
      provenance,
      freshness: {},
    });
    expect(event?.contributors).toEqual(expect.arrayContaining(expected));
  });

  it.each([
    { contributors: [] },
    { contributors: null },
    { contributors: [{ sourceId: "native", name: "Native receipt" }] },
  ])("keeps native situation receipts authoritative: $contributors", ({ contributors }) => {
    const event = situationToRoadConditionEvent({
      id: "derived",
      contributors,
      location: { geometry: { type: "Point", coordinates: [6, 51] } },
      provenance,
      freshness: {},
    });
    expect(event?.contributors).toEqual(contributors ?? []);
  });

  it("retains a fresh crowd situation's captured structured grant", () => {
    const event = situationToRoadConditionEvent({
      id: "crowd",
      location: { geometry: { type: "Point", coordinates: [6, 51] } },
      provenance: {
        sourceId: "crowd",
        origin: "crowd",
        attribution: {
          provider: "Captured crowd",
          licensing: {
            version: 1,
            bindings: [
              {
                scope: "data",
                subject: "Captured crowd",
                license: { kind: "spdx", expression: "ODbL-1.0" },
              },
            ],
          },
        },
      },
      freshness: {},
    });
    expect(event?.contributors).toEqual([
      expect.objectContaining({
        sourceId: "crowd",
        name: "Captured crowd",
        licensing: {
          version: 1,
          bindings: [
            {
              scope: "data",
              subject: "Captured crowd",
              license: { kind: "spdx", expression: "ODbL-1.0" },
            },
          ],
        },
      }),
    ]);
  });

  for (const domain of ["charging", "parking"] as const) {
    const fixture = domain === "charging" ? charging : parking;
    const map = (offers: Rec[]) =>
      domain === "charging"
        ? recordToChargingSite(fixture.records[0]!, [], offers, (id) => id === "excluded")
        : recordToParkingSite(fixture.records[0]!, [], offers, (id) => id === "excluded");
    const offer = {
      id: "price",
      kind: domain === "charging" ? "energy_tariff" : "parking_rate",
      currency: "EUR",
      elements: [
        {
          components: [
            {
              type: domain === "charging" ? "energy" : "parking_time",
              price: { amount: "0.5", currency: "EUR" },
            },
          ],
        },
      ],
      provenance,
    };
    it(`carries accepted ${domain} prices' own captured receipts into site credits`, () => {
      const result = map([offer])!;
      const prices = "tariffs" in result ? result.tariffs : result.rates;
      expect(prices).toHaveLength(1);
      expect(prices[0]?.contributors).toEqual(expect.arrayContaining(expected));
      expect(result.attributions).toEqual(expect.arrayContaining(expected));
      provenance.attribution.publisher.name = "Changed later";
      expect(JSON.stringify(prices[0]?.contributors)).toContain("Captured publisher");
      provenance.attribution.publisher.name = "Captured publisher";
    });
    it(`does not credit excluded or unusable ${domain} prices`, () => {
      const result = map([
        { ...offer, elements: [] },
        { ...offer, provenance: { ...provenance, sourceId: "excluded" } },
      ])!;
      expect(
        result.attributions.some(
          (c) => c.sourceId === "captured-feed" || c.sourceId === "historical-feed",
        ),
      ).toBe(false);
    });
    it.each([
      { contributors: [] },
      { contributors: null },
      { contributors: [{ sourceId: "native", name: "Native price" }] },
    ])(`preserves native ${domain} offer receipts: $contributors`, ({ contributors }) => {
      const result = map([{ ...offer, contributors }])!;
      const prices = "tariffs" in result ? result.tariffs : result.rates;
      expect(prices[0]?.contributors).toEqual(contributors ?? []);
      expect(result.attributions.some((c) => c.sourceId === "captured-feed")).toBe(false);
    });
  }
});
