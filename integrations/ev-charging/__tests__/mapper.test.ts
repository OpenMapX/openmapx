import type { DataSourceDetailSection } from "@openmapx/core";
import {
  type I18nToken,
  isI18nToken,
  resolveToken,
  sharedStrings,
} from "@openmapx/integration-framework/strings";
import {
  availabilityOf,
  type ChargingConnector,
  type ChargingSite,
  type EnergyTariff,
  type Evse,
  type EvseStatus,
} from "@openmapx/mobility-core/ev-charging";
import { describe, expect, it } from "vitest";
import { mapChargingSiteToDetail, mapChargingSiteToResult } from "../mapper.js";
import de from "../strings/de.json";
import en from "../strings/en.json";

const AT = "2026-10-05T08:00:00Z";

function text(t: unknown, locale = "en"): string {
  if (!isI18nToken(t)) return String(t);
  return resolveToken(t, {
    locale,
    fallbackLocale: "en",
    shared: sharedStrings,
    integration: { en, de },
  });
}

function connector(over: Partial<ChargingConnector> = {}): ChargingConnector {
  return {
    key: "e1/1",
    standard: "IEC_62196_T2",
    current: "ac",
    maxPowerKw: 22,
    tariffIds: [],
    stale: false,
    ...over,
  };
}

function evse(over: Partial<Evse> = {}): Evse {
  return {
    key: "e1",
    quantity: 1,
    stale: false,
    capabilities: [],
    parkingRestrictions: [],
    connectors: [connector()],
    ...over,
  };
}

/** A charge point with a status of its own and one Type 2 connector. */
function live(key: string, status: EvseStatus, over: Partial<Evse> = {}): Evse {
  return evse({
    key,
    status,
    statusAt: AT,
    connectors: [connector({ key: `${key}/1` })],
    ...over,
  });
}

function makeSite(over: Partial<ChargingSite> = {}): ChargingSite {
  return {
    id: "oc:feature:de-bw-mobidata-charging:DE*ABC*E1",
    name: "Ladepark Schloss",
    country: "DE",
    coordinates: [8.4, 49.01],
    payment: [],
    authentication: [],
    closed: false,
    planned: false,
    evses: [evse()],
    tariffs: [],
    sources: ["de-bw-mobidata-charging"],
    attributions: [{ sourceId: "de-bw-mobidata-charging", name: "MobiData BW" }],
    ...over,
  };
}

function tariff(over: Partial<EnergyTariff> = {}): EnergyTariff {
  return {
    id: "oc:offer:de-bw-mobidata-charging:1:T1",
    currency: "EUR",
    elements: [{ components: [{ type: "energy", price: 0.59 }] }],
    sourceId: "de-bw-mobidata-charging",
    ...over,
  };
}

function section(sections: DataSourceDetailSection[], title: string) {
  return sections.find((s) => isI18nToken(s.title) && text(s.title) === title);
}

/** Each row as plain text in `locale`, cell by cell. */
function rowsOf(s: DataSourceDetailSection | undefined, locale = "en"): string[][] {
  return (s?.rows ?? []).map((row) => row.map((cell) => text(cell, locale)));
}

describe("availabilityOf", () => {
  it("counts only fresh charge point statuses, weighted by quantity, with the newest time", () => {
    const site = makeSite({
      evses: [
        live("e1", "available", { statusAt: "2026-10-05T07:58:00Z" }),
        live("e2", "charging"),
        live("e3", "available", { stale: true }),
        evse({ key: "osm", quantity: 4 }),
      ],
    });

    expect(availabilityOf(site)).toEqual({ available: 1, total: 2, updatedAt: AT });
  });

  it("reads a charge point's status from its connectors when it has none of its own", () => {
    const site = makeSite({
      evses: [
        evse({
          key: "e1",
          connectors: [
            connector({ key: "e1/1", status: "occupied", statusAt: AT }),
            connector({ key: "e1/2", status: "available", statusAt: AT }),
          ],
        }),
      ],
    });

    expect(availabilityOf(site)).toEqual({ available: 1, total: 1, updatedAt: AT });
  });

  it("is undefined when no status is fresh", () => {
    expect(availabilityOf(makeSite())).toBeUndefined();
    expect(
      availabilityOf(makeSite({ evses: [live("e1", "available", { stale: true })] })),
    ).toBeUndefined();
  });

  it("a planned or removed status is no live status: it counts neither as free nor as out", () => {
    const site = makeSite({
      evses: [live("e1", "planned"), live("e2", "removed"), live("e3", "available")],
    });

    expect(availabilityOf(site)).toEqual({ available: 1, total: 1, updatedAt: AT });
    expect(
      availabilityOf(makeSite({ evses: [live("e1", "planned"), live("e2", "removed")] })),
    ).toBeUndefined();
    expect(
      mapChargingSiteToResult(
        makeSite({ evses: [live("e1", "out_of_order"), live("e2", "planned")] }),
      ).status,
    ).toBe("non-operational");
    expect(mapChargingSiteToResult(makeSite({ evses: [live("e1", "planned")] })).status).toBe(
      "unknown",
    );
  });
});

describe("mapChargingSiteToResult", () => {
  it("a stale EVSE status is not counted available and the result is unknown, not operational", () => {
    const result = mapChargingSiteToResult(
      makeSite({ evses: [live("e1", "available", { stale: true })] }),
    );

    expect(result.status).toBe("unknown");
    expect(result.availability).toBeUndefined();
    expect(result.sortValues).toEqual({ powerKw: 22 });

    const fresh = mapChargingSiteToResult(makeSite({ evses: [live("e1", "available")] }));
    expect(fresh.status).toBe("operational");
    expect(fresh.availability).toEqual({ available: 1, total: 1 });
    expect(fresh.sortValues).toEqual({ powerKw: 22, available: 1 });
  });

  it("every EVSE out of order makes the site non-operational and dims it", () => {
    const broken = makeSite({
      evses: [live("e1", "out_of_order"), live("e2", "inoperative")],
    });

    expect(mapChargingSiteToResult(broken).status).toBe("non-operational");
    expect(mapChargingSiteToResult(makeSite({ closed: true })).status).toBe("non-operational");
    expect(mapChargingSiteToResult(makeSite({ planned: true })).status).toBe("planned");
    expect(
      mapChargingSiteToResult(
        makeSite({ evses: [live("e1", "out_of_order"), live("e2", "charging")] }),
      ).status,
    ).toBe("operational");
  });

  it("the variant is the highest connector power: unknown, slow, fast or ultra-rapid", () => {
    const at = (kw: number | undefined) =>
      mapChargingSiteToResult(
        makeSite({ evses: [evse({ connectors: [connector({ maxPowerKw: kw })] })] }),
      ).variant;

    expect(at(undefined)).toBe("unknown");
    expect(at(0)).toBe("unknown");
    expect(at(22)).toBe("slow");
    expect(at(50)).toBe("fast");
    expect(at(100)).toBe("fast");
    expect(at(150)).toBe("ultra-rapid");
  });

  it("the summary counts connectors, names their types and the top power", () => {
    const site = makeSite({
      evses: [
        evse({
          key: "e1",
          connectors: [
            connector({
              key: "e1/1",
              standard: "IEC_62196_T2_COMBO",
              current: "dc",
              maxPowerKw: 150,
            }),
            connector({ key: "e1/2", standard: "CHADEMO", current: "dc", maxPowerKw: 50 }),
          ],
        }),
        evse({ key: "osm", quantity: 2, connectors: [connector({ key: "osm/1" })] }),
      ],
    });

    expect(text(mapChargingSiteToResult(site).summary)).toBe(
      "4x CCS (Type 2), CHAdeMO, Type 2 · 150 kW",
    );
    expect(text(mapChargingSiteToResult(site).summary, "de")).toBe(
      "4× CCS (Typ 2), CHAdeMO, Typ 2 · 150 kW",
    );
  });

  it("carries the operator, its logo and the credits", () => {
    const result = mapChargingSiteToResult(
      makeSite({
        operator: { name: "EWE Go" },
        attributions: [
          {
            sourceId: "de-bw-mobidata-charging",
            name: "MobiData BW",
            url: "https://mobidata-bw.de",
            spdxLicense: "DL-DE-BY-2.0",
          },
        ],
      }),
    );

    expect(result.operator).toBe("EWE Go");
    expect(result.branding?.logoUrl).toMatch(/^https:\/\/.*EWE/);
    expect(
      mapChargingSiteToResult(makeSite({ operator: { name: "EWE Go" }, country: "FR" })).branding,
    ).toBeUndefined();
    expect(result.attributions).toEqual([
      { text: "MobiData BW", url: "https://mobidata-bw.de", license: "DL-DE-BY-2.0" },
    ]);
  });
});

describe("mapChargingSiteToDetail", () => {
  it("an OSM EVSE of quantity 4 shows Qty 4 and no availability", () => {
    const detail = mapChargingSiteToDetail(
      makeSite({ evses: [evse({ key: "osm", quantity: 4 })] }),
    );
    const connectors = section(detail.sections, "Connectors");

    expect(rowsOf(connectors)).toEqual([["Type 2", "22 kW", "AC", "4", "", "unknown"]]);
    expect(connectors?.caption).toBeUndefined();
    expect(connectors?.rowLayout).toBe("connector");
  });

  it("groups connectors by standard, power and status, with a translated status and its kind", () => {
    const detail = mapChargingSiteToDetail(
      makeSite({
        evses: [
          live("e1", "available", {
            connectors: [
              connector({
                key: "e1/1",
                standard: "IEC_62196_T2_COMBO",
                current: "dc",
                maxPowerKw: 150,
              }),
            ],
          }),
          live("e2", "available", {
            connectors: [
              connector({
                key: "e2/1",
                standard: "IEC_62196_T2_COMBO",
                current: "dc",
                maxPowerKw: 150,
              }),
            ],
          }),
          live("e3", "charging", {
            connectors: [
              connector({
                key: "e3/1",
                standard: "IEC_62196_T2_COMBO",
                current: "dc",
                maxPowerKw: 150,
              }),
            ],
          }),
          live("e4", "out_of_order"),
          live("e5", "available", { stale: true }),
        ],
      }),
    );
    const connectors = section(detail.sections, "Connectors");

    expect(rowsOf(connectors)).toEqual([
      ["CCS (Type 2)", "150 kW", "DC", "2", "Available", "available"],
      ["CCS (Type 2)", "150 kW", "DC", "1", "Charging", "busy"],
      ["Type 2", "22 kW", "AC", "1", "Out of order", "out"],
      ["Type 2", "22 kW", "AC", "1", "", "unknown"],
    ]);
    expect(rowsOf(connectors, "de")[2]).toEqual([
      "Typ 2",
      "22 kW",
      "AC",
      "1",
      "Außer Betrieb",
      "out",
    ]);
    expect(text(connectors?.caption)).toBe("2 of 4 available");
    expect(connectors?.captionTimestamp).toBe(AT);
  });

  it("a weekday night tariff row reads its days and hours", () => {
    const detail = mapChargingSiteToDetail(
      makeSite({
        tariffs: [
          tariff({
            elements: [
              {
                components: [{ type: "energy", price: 0.39 }],
                restrictions: {
                  days: ["MO", "TU", "WE", "TH", "FR"],
                  startTime: "18:00",
                  endTime: "08:00",
                },
              },
              { components: [{ type: "energy", price: 0.59 }] },
            ],
          }),
        ],
      }),
    );
    const pricing = section(detail.sections, "Pricing");

    expect(rowsOf(pricing)).toEqual([
      ["Energy", "€0.39/kWh", "Mon–Fri · 18:00–08:00"],
      ["Energy", "€0.59/kWh", ""],
    ]);
    expect(rowsOf(pricing, "de")[0]).toEqual(["Energie", "0,39 €/kWh", "Mo–Fr · 18:00–08:00"]);
    expect(pricing?.rowLayout).toBe("pricing");
  });

  it("prices read in the reader's locale, with the digits the source gives", () => {
    const detail = mapChargingSiteToDetail(
      makeSite({
        tariffs: [
          tariff({
            currency: "CHF",
            elements: [{ components: [{ type: "energy", price: 0.389 }] }],
          }),
        ],
      }),
    );
    const pricing = section(detail.sections, "Pricing");

    expect(rowsOf(pricing)[0]?.[1]).toBe("CHF 0.389/kWh");
    expect(rowsOf(pricing, "de")[0]?.[1]).toBe("0,389 CHF/kWh");
  });

  it("a pricing row carries every restriction it has", () => {
    const detail = mapChargingSiteToDetail(
      makeSite({
        tariffs: [
          tariff({
            priceIncludesVat: false,
            elements: [
              {
                components: [
                  { type: "time", price: 6 },
                  { type: "flat", price: 1 },
                ],
                restrictions: {
                  days: ["SA", "SU"],
                  startDate: "2026-12-24",
                  endDate: "2026-12-26",
                  minPowerKw: 50,
                  maxKwh: 30,
                  minDurationSec: 7200,
                  maxCurrentA: 32,
                },
              },
              {
                components: [{ type: "parking_time", price: 0.1 }],
                restrictions: { startTime: "22:00", minDurationSec: 5400, days: ["MO", "WE"] },
              },
            ],
          }),
        ],
      }),
    );

    expect(rowsOf(section(detail.sections, "Pricing"))).toEqual([
      [
        "Charging time, Flat fee",
        "€6.00/h + €1.00/session",
        "Sat, Sun · 2026-12-24 – 2026-12-26 · ≥50 kW · ≤30 kWh · ≤32 A · from 2 h · excl. VAT",
      ],
      ["Parking", "€0.10/h parking", "Mon, Wed · from 22:00 · from 90 min · excl. VAT"],
    ]);
  });

  it("labels the rows by connector group when the tariffs differ by connector", () => {
    const dc = tariff({
      id: "T-DC",
      elements: [
        {
          components: [
            { type: "energy", price: 0.69 },
            { type: "parking_time", price: 6 },
          ],
        },
      ],
    });
    const ac = tariff({
      id: "T-AC",
      elements: [{ components: [{ type: "energy", price: 0.49 }] }],
    });
    const detail = mapChargingSiteToDetail(
      makeSite({
        evses: [
          evse({
            key: "e1",
            connectors: [
              connector({
                key: "e1/1",
                standard: "IEC_62196_T2_COMBO",
                current: "dc",
                maxPowerKw: 150,
                tariffIds: ["T-DC"],
              }),
            ],
          }),
          evse({ key: "e2", connectors: [connector({ key: "e2/1", tariffIds: ["T-AC"] })] }),
        ],
        tariffs: [dc, ac],
      }),
    );

    expect(rowsOf(section(detail.sections, "Pricing"))).toEqual([
      ["CCS (Type 2) · DC · 150 kW", "€0.69/kWh + €6.00/h parking", ""],
      ["Type 2 · AC · 22 kW", "€0.49/kWh", ""],
    ]);
  });

  it("shows tariffs of identical content for the same connectors once, without a tariff label", () => {
    const repeated = {
      currency: "EUR",
      elements: [{ components: [{ type: "energy" as const, price: 0.59 }] }],
      priceIncludesVat: true,
    };
    const detail = mapChargingSiteToDetail(
      makeSite({ tariffs: [tariff({ id: "A", ...repeated }), tariff({ id: "B", ...repeated })] }),
    );

    expect(rowsOf(section(detail.sections, "Pricing"))).toEqual([["Energy", "€0.59/kWh", ""]]);
  });

  it("drops upstream URLs that are not http(s)", () => {
    const site = makeSite({
      operator: { name: "EnBW", website: "javascript:alert(1)" },
      website: "data:text/html,<script>alert(1)</script>",
      tariffs: [tariff({ url: "javascript:alert(1)", altText: "Ad hoc" })],
      attributions: [
        {
          sourceId: "de-bw-mobidata-charging",
          name: "MobiData BW",
          url: "javascript:alert(1)",
          licenseUrl: "data:text/html,x",
        },
      ],
    });
    const emitted = JSON.stringify([mapChargingSiteToResult(site), mapChargingSiteToDetail(site)]);

    expect(emitted).not.toMatch(/javascript:|data:/);
    expect(mapChargingSiteToDetail(site).operator).toEqual({ name: "EnBW" });

    const fallback = mapChargingSiteToDetail(
      makeSite({
        operator: { name: "EnBW", website: "javascript:x" },
        website: "https://enbw.com",
      }),
    );
    // The site's website is the site's, not the operator's: it stands on its own.
    expect(fallback.operator).toEqual({ name: "EnBW" });
    expect(fallback.website).toBe("https://enbw.com");
  });

  it("keeps a site's website when the site names no operator", () => {
    const detail = mapChargingSiteToDetail(
      makeSite({ operator: undefined, website: "https://ladepark.example" }),
    );
    expect(detail.operator).toBeUndefined();
    expect(detail.website).toBe("https://ladepark.example");

    // An operator website is the link already; the site's is not repeated.
    const both = mapChargingSiteToDetail(
      makeSite({
        operator: { name: "EnBW", website: "https://enbw.com" },
        website: "https://ladepark.example",
      }),
    );
    expect(both.operator).toEqual({ name: "EnBW", url: "https://enbw.com" });
    expect(both.website).toBeUndefined();
  });

  it("labels the rows of several tariffs for the same connectors by tariff", () => {
    const pricing = (tariffs: EnergyTariff[], evses?: Evse[]) =>
      rowsOf(
        section(
          mapChargingSiteToDetail(makeSite({ tariffs, ...(evses ? { evses } : {}) })).sections,
          "Pricing",
        ),
      ).map((row) => row[0]);
    const twoElements = [
      { components: [{ type: "energy" as const, price: 0.59 }] },
      { components: [{ type: "parking_time" as const, price: 6 }] },
    ];

    expect(
      pricing([
        tariff({ id: "A", type: "ad_hoc", elements: twoElements }),
        tariff({ id: "B", type: "regular" }),
      ]),
    ).toEqual(["Ad hoc", "", "Regular"]);
    expect(
      pricing([
        tariff({ id: "A", type: "regular", altText: "Night owl", elements: twoElements }),
        tariff({ id: "B", type: "regular", altText: "Day" }),
      ]),
    ).toEqual(["Night owl", "", "Day"]);
    expect(pricing([tariff({ id: "A" }), tariff({ id: "B", elements: twoElements })])).toEqual([
      "Tariff 1",
      "Tariff 2",
      "",
    ]);
    expect(
      pricing(
        [
          tariff({ id: "DC1", type: "ad_hoc" }),
          tariff({ id: "DC2", type: "member", elements: twoElements }),
          tariff({ id: "AC" }),
        ],
        [
          evse({
            key: "e1",
            connectors: [
              connector({
                key: "e1/1",
                standard: "IEC_62196_T2_COMBO",
                current: "dc",
                maxPowerKw: 150,
                tariffIds: ["DC1", "DC2"],
              }),
            ],
          }),
          evse({ key: "e2", connectors: [connector({ key: "e2/1", tariffIds: ["AC"] })] }),
        ],
      ),
    ).toEqual([
      "CCS (Type 2) · DC · 150 kW · Ad hoc",
      "CCS (Type 2) · DC · 150 kW · Member",
      "",
      "Type 2 · AC · 22 kW",
    ]);
    expect(pricing([tariff({ id: "A", type: "ad_hoc" })])).toEqual(["Energy"]);
  });

  it("without tariff rows the pricing is the tariff text; ad-hoc tariffs say the price is direct", () => {
    const textOnly = mapChargingSiteToDetail(makeSite({ tariffText: "0,49 €/kWh" }));
    const pricing = section(textOnly.sections, "Pricing");
    expect(pricing?.type).toBe("text");
    expect(pricing?.content).toBe("0,49 €/kWh");

    const adHoc = mapChargingSiteToDetail(
      makeSite({
        tariffs: [tariff({ type: "ad_hoc", url: "https://example.org/t", altText: "Ad hoc" })],
      }),
    );
    const adHocPricing = section(adHoc.sections, "Pricing");
    expect(text(adHocPricing?.caption)).toMatch(/^Direct payment price/);
    expect(adHocPricing?.links).toEqual([{ label: "Ad hoc", url: "https://example.org/t" }]);

    const regular = mapChargingSiteToDetail(makeSite({ tariffs: [tariff()] }));
    expect(text(section(regular.sections, "Pricing")?.caption)).toMatch(/^Price published/);
  });

  it("shows usage, opening-hours text without OSM hours, and the notes", () => {
    const detail = mapChargingSiteToDetail(
      makeSite({
        audience: "customers",
        payment: ["credit_card", "app"],
        authentication: ["rfid"],
        openingHoursText: "Mo–Fr 7–19",
        notes: "Entrance from the rear",
        operator: { name: "EnBW", website: "https://enbw.com" },
        address: "Schlossplatz 1, 76131 Karlsruhe",
      }),
    );

    expect(rowsOf(section(detail.sections, "Usage"))).toEqual([
      ["Access", "Customers"],
      ["Payment", "Credit Card, App"],
      ["Authentication", "RFID"],
    ]);
    expect(section(detail.sections, "Opening Hours")?.content).toBe("Mo–Fr 7–19");
    expect(section(detail.sections, "Notes")?.content).toBe("Entrance from the rear");
    expect(section(detail.sections, "Notes")?.collapsed).toBe(true);
    expect(text(detail.usageInfo?.type)).toBe("Customers");
    expect(detail.identity).toEqual({ operator: "EnBW", brand: "EnBW" });
    expect(detail.operator).toEqual({ name: "EnBW", url: "https://enbw.com" });
    expect(detail.address).toEqual({ line1: "Schlossplatz 1, 76131 Karlsruhe" });

    const withHours = mapChargingSiteToDetail(
      makeSite({ openingHours: "24/7", openingHoursText: "always" }),
    );
    expect(withHours.openingHours).toBe("24/7");
    expect(section(withHours.sections, "Opening Hours")).toBeUndefined();
  });

  it("a site without a name gets a fallback name", () => {
    const detail = mapChargingSiteToDetail(makeSite({ name: "" }));
    expect(text(detail.fallbackName)).toBe("Charging station");
    expect(text(mapChargingSiteToResult(makeSite({ name: "" })).fallbackName)).toBe(
      "Charging station",
    );
  });
});

/** Every token in `value`, nested ones included. */
function tokensIn(value: unknown, into: I18nToken[] = []): I18nToken[] {
  if (Array.isArray(value)) {
    for (const item of value) tokensIn(item, into);
  } else if (isI18nToken(value)) {
    into.push(value);
    for (const v of Object.values(value.values ?? {})) tokensIn(v, into);
  } else if (value !== null && typeof value === "object") {
    for (const v of Object.values(value)) tokensIn(v, into);
  }
  return into;
}

function lookup(catalog: unknown, key: string): unknown {
  return key
    .split(".")
    .reduce<unknown>(
      (node, part) =>
        node !== null && typeof node === "object"
          ? (node as Record<string, unknown>)[part]
          : undefined,
      catalog,
    );
}

const STATUSES: EvseStatus[] = [
  "available",
  "charging",
  "occupied",
  "reserved",
  "blocked",
  "out_of_order",
  "inoperative",
  "planned",
  "removed",
  "unknown",
];

const STANDARDS = Object.keys(en.connector);

describe("ev-charging strings", () => {
  it("every token the mapper emits exists in en and de", () => {
    const everything = makeSite({
      name: "",
      audience: "restricted",
      payment: ["app"],
      authentication: ["rfid"],
      openingHoursText: "daily",
      notes: "note",
      evses: [
        ...STATUSES.map((status, i) =>
          live(`s${i}`, status, {
            connectors: [connector({ key: `s${i}/1`, standard: STANDARDS[i], current: "dc" })],
          }),
        ),
        ...STANDARDS.map((standard, i) =>
          evse({
            key: `c${i}`,
            connectors: [connector({ key: `c${i}/1`, standard, tariffIds: ["T2"] })],
          }),
        ),
      ],
      tariffs: [
        tariff({
          id: "T1",
          type: "ad_hoc",
          priceIncludesVat: false,
          elements: [
            {
              components: (
                [
                  "energy",
                  "time",
                  "flat",
                  "parking_time",
                  "session",
                  "idle",
                  "reservation",
                  "distance",
                ] as const
              ).map((type) => ({ type, price: 1 })),
              restrictions: {
                days: ["MO", "TU", "WE", "TH", "FR", "SA", "SU"],
                startTime: "08:00",
                startDate: "2026-01-01",
                minKwh: 1,
                maxKwh: 5,
                minCurrentA: 6,
                minPowerKw: 3,
                maxPowerKw: 11,
                minDurationSec: 60,
                maxDurationSec: 7200,
                reservation: "reservation",
              },
            },
            {
              components: [{ type: "energy", price: 1 }],
              restrictions: {
                days: ["SU"],
                endTime: "06:00",
                endDate: "2026-02-01",
                maxCurrentA: 32,
                maxDurationSec: 90,
                reservation: "reservation_expires",
              },
            },
            {
              components: [{ type: "energy", price: 1 }],
              restrictions: {
                minCurrentA: 6,
                maxCurrentA: 32,
                minDurationSec: 60,
                maxDurationSec: 120,
              },
            },
          ],
        }),
        tariff({ id: "T2" }),
      ],
    });
    const variants = [
      everything,
      ...(["public", "customers", "permit", "private", "restricted", "unknown"] as const).map(
        (audience) => makeSite({ audience }),
      ),
      makeSite({ tariffText: "text" }),
      makeSite({
        tariffs: [
          "ad_hoc",
          "profile_cheap",
          "profile_fast",
          "profile_green",
          "regular",
          "member",
          "roaming",
        ].map((type) => tariff({ id: type, type })),
      }),
      makeSite({
        evses: [evse({ connectors: [connector({ tariffIds: ["A", "B"] })] })],
        tariffs: [tariff({ id: "A" }), tariff({ id: "B" }), tariff({ id: "C" })],
      }),
      makeSite({ closed: true }),
      makeSite({ planned: true }),
      makeSite({ evses: [evse({ connectors: [connector({ maxPowerKw: undefined })] })] }),
      makeSite({ evses: [evse({ connectors: [] })] }),
      makeSite({ evses: [] }),
      makeSite({ evses: [evse({ lifecycle: "planned" })] }),
    ];

    const keys = new Set<string>();
    for (const s of variants) {
      for (const t of tokensIn([mapChargingSiteToResult(s), mapChargingSiteToDetail(s)])) {
        keys.add(t.$t);
      }
    }

    expect(keys.size).toBeGreaterThan(90);
    for (const key of keys) {
      if (key.startsWith("shared.")) {
        expect(lookup(sharedStrings.en, key), key).toBeTypeOf("string");
        expect(lookup(sharedStrings.de, key), key).toBeTypeOf("string");
      } else {
        expect(lookup(en, key), `en ${key}`).toBeTypeOf("string");
        expect(lookup(de, key), `de ${key}`).toBeTypeOf("string");
      }
    }
  });

  it("have the same keys in en and de, and no per-source entries", () => {
    const flatten = (node: unknown, prefix = ""): string[] =>
      node !== null && typeof node === "object"
        ? Object.entries(node).flatMap(([k, v]) => flatten(v, prefix ? `${prefix}.${k}` : k))
        : [prefix];
    expect(flatten(de).sort()).toEqual(flatten(en).sort());
    expect(en).not.toHaveProperty("dataSources");
  });
});
