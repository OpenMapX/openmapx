import type { DataSourceDetailSection } from "@openmapx/core";
import {
  type I18nToken,
  isI18nToken,
  resolveToken,
  sharedStrings,
} from "@openmapx/integration-framework/strings";
import type { ParkingArea, ParkingSite } from "@openmapx/mobility-core/parking";
import { describe, expect, it } from "vitest";
import { mapParkingSiteToDetail, mapParkingSiteToResult } from "../mapper.js";
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

function makeSite(over: Partial<ParkingSite> = {}): ParkingSite {
  return {
    id: "oc:feature:de-bw-mobidata-parking:42",
    name: "Parkhaus Schloss",
    country: "DE",
    coordinates: [8.4, 49.01],
    closed: false,
    stale: false,
    areas: [],
    rates: [],
    sources: ["de-bw-mobidata-parking"],
    attributions: [{ sourceId: "de-bw-mobidata-parking", name: "MobiData BW" }],
    ...over,
  };
}

function area(
  vehicleType: string,
  userGroup: string,
  over: Partial<ParkingArea> = {},
): ParkingArea {
  return { key: `${vehicleType}:${userGroup}`, vehicleType, userGroup, stale: false, ...over };
}

function section(sections: DataSourceDetailSection[], title: string) {
  return sections.find((s) => isI18nToken(s.title) && text(s.title) === title);
}

/** Each row as plain text, label and value; a list value joined as the client joins it. */
function rowsOf(s: DataSourceDetailSection | undefined, locale = "en"): [string, string][] {
  return (s?.rows ?? []).map((row) => [
    text(row[0], locale),
    Array.isArray(row[1])
      ? row[1].map((cell) => text(cell, locale)).join(", ")
      : text(row[1], locale),
  ]);
}

/** OpenConditions' `PARKING_VEHICLE_TYPES` and `PARKING_USER_GROUPS`. */
const OC_VEHICLE_TYPES = [
  "car",
  "truck",
  "bus",
  "coach",
  "motorcycle",
  "bicycle",
  "cargo_bike",
  "caravan",
  "any",
];
const OC_USER_GROUPS = [
  "disabled",
  "women",
  "family",
  "ev_charging",
  "car_sharing",
  "residents",
  "customers",
  "taxi",
  "delivery",
  "short_term",
  "long_term",
  "hazmat",
];

describe("mapParkingSiteToResult", () => {
  it("a stale reading shows as unknown with the stale summary, never as available", () => {
    const result = mapParkingSiteToResult(
      makeSite({ capacity: 400, available: 250, status: "spaces_available", stale: true, at: AT }),
    );

    expect(result.variant).toBe("unknown");
    expect(result.summary).toEqual({ $t: "summary.stale" });
    expect(result.sortValues).toBeUndefined();
  });

  it("almost_full and 20% of capacity are limited; 0 available or full is full", () => {
    const variant = (over: Partial<ParkingSite>) => mapParkingSiteToResult(makeSite(over)).variant;

    expect(variant({ capacity: 400, available: 250 })).toBe("available");
    expect(variant({ capacity: 400, available: 80 })).toBe("limited");
    expect(variant({ capacity: 400, available: 81 })).toBe("available");
    expect(variant({ capacity: 400, available: 200, status: "almost_full" })).toBe("limited");
    expect(variant({ status: "almost_full" })).toBe("limited");
    expect(variant({ capacity: 400, available: 0 })).toBe("full");
    expect(variant({ capacity: 400, available: 12, status: "full" })).toBe("full");
    expect(variant({ status: "full" })).toBe("full");
    expect(variant({ available: 5 })).toBe("available");
    expect(variant({ capacity: 400 })).toBe("unknown");
    expect(variant({ capacity: 400, status: "open" })).toBe("unknown");

    const full = mapParkingSiteToResult(makeSite({ capacity: 400, available: 0 }));
    expect(full.summary).toEqual({ $t: "summary.full" });
    expect(full.sortValues).toEqual({ freeSpaces: 0 });

    const limited = mapParkingSiteToResult(makeSite({ capacity: 400, available: 80 }));
    expect(limited.summary).toEqual({
      $t: "summary.spacesOf",
      values: { free: 80, capacity: 400 },
    });
    expect(text(limited.summary)).toBe("80/400 free");
    expect(text(limited.summary, "de")).toBe("80/400 frei");
    expect(limited.sortValues).toEqual({ freeSpaces: 80 });

    expect(mapParkingSiteToResult(makeSite({ available: 5 })).summary).toEqual({
      $t: "summary.spaces",
      values: { count: 5 },
    });
    expect(text(mapParkingSiteToResult(makeSite({ status: "almost_full" })).summary)).toBe(
      "Almost full",
    );
  });

  it("a closed site is closed whatever its counts", () => {
    for (const over of [
      { closed: true, capacity: 400, available: 300 },
      { status: "closed" as const, capacity: 400, available: 300 },
      { status: "closed_abnormally" as const, available: 0 },
    ]) {
      const result = mapParkingSiteToResult(makeSite(over));
      expect(result.variant).toBe("closed");
      expect(result.status).toBe("non-operational");
      expect(result.summary).toEqual({ $t: "summary.closed" });
    }
  });

  it("without counts the summary is the capacity, else what the site is", () => {
    expect(mapParkingSiteToResult(makeSite({ capacity: 120 })).summary).toEqual({
      $t: "summary.totalSpaces",
      values: { count: 120 },
    });
    expect(text(mapParkingSiteToResult(makeSite({ layout: "underground" })).summary)).toBe(
      "Underground Garage",
    );
    expect(
      text(mapParkingSiteToResult(makeSite({ type: "park_and_ride", layout: "surface" })).summary),
    ).toBe("Park & Ride");
    expect(mapParkingSiteToResult(makeSite()).summary).toBeUndefined();
  });

  it("keeps the operator, credits and fallback name without uncredited Commons bytes", () => {
    const result = mapParkingSiteToResult(
      makeSite({
        name: "",
        operator: "APCOA",
        attributions: [
          {
            sourceId: "de-bw-mobidata-parking",
            name: "MobiData BW",
            url: "https://mobidata-bw.de",
            licensing: {
              version: 1,
              bindings: [
                {
                  scope: "data",
                  subject: "Data",
                  license: { kind: "spdx", expression: "DL-DE-BY-2.0" },
                },
              ],
            } as const,
          },
        ],
      }),
    );

    expect(result.operator).toBe("APCOA");
    expect(result.branding?.logoUrl).toBeUndefined();
    expect(result.branding?.catalogueLogo).toEqual({
      qid: expect.stringMatching(/^Q\d+$/),
      file: expect.any(String),
    });
    expect(result.attributions).toEqual([
      {
        sourceId: "de-bw-mobidata-parking",
        name: "MobiData BW",
        url: "https://mobidata-bw.de",
        licensing: {
          version: 1,
          bindings: [
            {
              scope: "data",
              subject: "Data",
              license: { kind: "spdx", expression: "DL-DE-BY-2.0" },
            },
          ],
        } as const,
      },
    ]);
    expect(result.fallbackName).toEqual({ $t: "siteFallbackName" });
    expect(mapParkingSiteToResult(makeSite())).not.toHaveProperty("fallbackName");
  });
});

describe("mapParkingSiteToDetail", () => {
  it("areas render with their own counts and capacity-less areas as features", () => {
    const detail = mapParkingSiteToDetail(
      makeSite({
        capacity: 400,
        available: 120,
        status: "spaces_available",
        trend: "filling",
        at: AT,
        layout: "multi_storey",
        heightLimitCm: 210,
        areas: [
          area("car", "any", { capacity: 400, available: 120 }),
          area("car", "disabled", { capacity: 8, available: 3 }),
          area("car", "women", { capacity: 12 }),
          area("car", "ev_charging"),
          area("truck", "any", { capacity: 20, available: 4, stale: true }),
          area("motorcycle", "any", { capacity: 30, available: 9 }),
        ],
      }),
    );

    expect(rowsOf(section(detail.sections, "Availability"))).toEqual([
      ["Free Spaces", "120 / 400"],
      ["Occupancy", "70%"],
      ["Status", "Spaces available"],
      ["Trend", "Filling up"],
      ["Last Updated", "2026-10-05 08:00:00 UTC"],
      ["Disabled Spaces", "3 / 8"],
      ["Motorcycles", "9 / 30"],
    ]);
    expect(rowsOf(section(detail.sections, "Facility"))).toEqual([
      ["Layout", "Parking Garage"],
      ["Capacity", "400"],
      ["Max Height", "2.10 m"],
      ["Women's Spaces", "12"],
      ["EV Charging", "Available"],
      ["Trucks", "20"],
    ]);
  });

  it("labels every vehicle type, user group and layout OpenConditions sends, in every locale", () => {
    const detail = mapParkingSiteToDetail(
      makeSite({
        layout: "underground_and_multi_storey",
        areas: [
          area("cargo_bike", "any", { capacity: 6 }),
          area("car", "customers", { capacity: 20 }),
          area("car", "taxi", { capacity: 3 }),
          area("truck", "delivery", { capacity: 2 }),
          area("hovercraft", "astronauts"),
        ],
      }),
    );
    expect(rowsOf(section(detail.sections, "Facility"))).toEqual([
      ["Layout", "Underground and Multi-Storey Garage"],
      ["Cargo Bikes", "6"],
      ["Customers", "20"],
      ["Taxis", "3"],
      ["Deliveries (Trucks)", "2"],
      ["astronauts (hovercraft)", "Available"],
    ]);
    expect(rowsOf(detail.sections[0], "de")).toEqual([
      ["Bauart", "Tief- und Hochgarage"],
      ["Lastenräder", "6"],
      ["Kunden", "20"],
      ["Taxis", "3"],
      ["Lieferverkehr (Lkw)", "2"],
      ["astronauts (hovercraft)", "Vorhanden"],
    ]);
  });

  it("shows an area's maximum stay and hours, and the site's maximum stay, reservation and amenities", () => {
    const detail = mapParkingSiteToDetail(
      makeSite({
        capacity: 100,
        available: 40,
        maxStayMin: 1_440,
        reservation: false,
        amenities: ["toilets", "shower", "truck_wash", "moon_base"],
        areas: [
          area("car", "disabled", {
            capacity: 4,
            available: 1,
            maxStayMin: 180,
            hours: "Mo-Fr 08:00-18:00",
          }),
          area("car", "delivery", { capacity: 2, maxStayMin: 30 }),
          area("car", "short_term", { hours: "Mo-Sa 09:00-20:00" }),
          area("car", "any", { capacity: 100, available: 40, maxStayMin: 240 }),
        ],
      }),
    );
    expect(rowsOf(section(detail.sections, "Availability"))).toEqual([
      ["Free Spaces", "40 / 100"],
      ["Occupancy", "60%"],
      ["Disabled Spaces", "1 / 4, max. 3 hours, applies Mo-Fr 08:00-18:00"],
      ["Cars", "40 / 100, max. 4 hours"],
    ]);
    expect(rowsOf(section(detail.sections, "Facility"))).toEqual([
      ["Capacity", "100"],
      ["Max Stay", "1 day"],
      ["Deliveries", "2 spaces, max. 30 min"],
      ["Short-Term", "Available, applies Mo-Sa 09:00-20:00"],
      ["Reservable", "No"],
      ["Amenities", "Toilets, Showers, Truck wash, Moon base"],
    ]);
    expect(rowsOf(detail.sections[1], "de")).toEqual([
      ["Kapazität", "100"],
      ["Höchstparkdauer", "1 Tag"],
      ["Lieferverkehr", "2 Plätze, höchstens 30 Min."],
      ["Kurzparker", "Vorhanden, gilt Mo-Sa 09:00-20:00"],
      ["Reservierbar", "Nein"],
      ["Ausstattung", "Toiletten, Duschen, Lkw-Wäsche, Moon base"],
    ]);
  });

  it("an area open around the clock or the same hours daily reads in the reader's clock", () => {
    const detail = mapParkingSiteToDetail(
      makeSite({
        areas: [
          area("car", "short_term", { hours: "07:00-22:30" }),
          area("car", "disabled", { hours: "24/7" }),
          area("car", "family", { hours: "Mo-Su 00:00-24:00" }),
          area("car", "ev_charging", { hours: "Mo-Su 06:30-24:00" }),
          area("car", "delivery", { hours: "Mo-Fr 06:30-22:15; Sa 08:30-22:15" }),
        ],
      }),
    );
    const facility = section(detail.sections, "Facility");

    expect(rowsOf(facility)).toEqual([
      ["Short-Term", "Available, applies 7:00 AM–10:30 PM"],
      ["Disabled Spaces", "Available, around the clock"],
      ["Families", "Available, around the clock"],
      ["EV Charging", "Available, applies 6:30 AM–12:00 AM"],
      ["Deliveries", "Available, applies Mo-Fr 06:30-22:15; Sa 08:30-22:15"],
    ]);
    expect(rowsOf(facility, "de")).toEqual([
      ["Kurzparker", "Vorhanden, gilt 07:00–22:30"],
      ["Behindertenplätze", "Vorhanden, rund um die Uhr"],
      ["Familien", "Vorhanden, rund um die Uhr"],
      ["E-Ladeplätze", "Vorhanden, gilt 06:30–00:00"],
      ["Lieferverkehr", "Vorhanden, gilt Mo-Fr 06:30-22:15; Sa 08:30-22:15"],
    ]);
  });

  it("a stale reading keeps its counts and says it is stale", () => {
    const detail = mapParkingSiteToDetail(
      makeSite({ capacity: 400, available: 120, stale: true, at: AT }),
    );

    expect(rowsOf(section(detail.sections, "Availability"))).toEqual([
      ["Free Spaces", "120 / 400"],
      ["Occupancy", "70%"],
      ["Data Freshness", "Stale"],
      ["Last Updated", "2026-10-05 08:00:00 UTC"],
    ]);
  });

  it("occupancy stays within 0–100% when the free count exceeds the static capacity", () => {
    const occupancy = (available: number) =>
      rowsOf(
        section(
          mapParkingSiteToDetail(makeSite({ capacity: 137, available, at: AT })).sections,
          "Availability",
        ),
      ).find(([label]) => label === "Occupancy")?.[1];

    expect(occupancy(143)).toBe("0%");
    expect(occupancy(0)).toBe("100%");
  });

  it("a rate row reads 'Up to 1 hour' and 'Up to 1 month (P-Card)'", () => {
    const detail = mapParkingSiteToDetail(
      makeSite({
        rates: [
          {
            currency: "EUR",
            rows: [
              { kind: "flat", amount: 2, toMin: 60 },
              { kind: "flat", amount: 12, toMin: 1440 },
              { kind: "flat", amount: 30, toMin: 43830, userGroups: ["p_card"] },
              { kind: "flat", amount: 300, toMin: 525960, userGroups: ["yearly_ticket"] },
            ],
          },
          {
            currency: "CHF",
            rows: [
              { kind: "per_hour", amount: 2, toMin: 60, stepMin: 30 },
              { kind: "per_hour", amount: 1, fromMin: 300, stepMin: 6 },
              { kind: "per_hour", amount: 1.5, fromMin: 60, toMin: 180, stepMin: 60 },
              {
                kind: "flat",
                amount: 100,
                toMin: 43200,
                userGroups: ["monthly_ticket", "public_transport_season_ticket"],
              },
            ],
          },
        ],
      }),
    );

    const pricing = section(detail.sections, "Pricing");
    expect(pricing?.sectionIcon).toBe("payments");
    expect(rowsOf(pricing)).toEqual([
      ["Up to 1 hour", "€2.00"],
      ["Up to 1 day", "€12.00"],
      ["Up to 1 month (P-Card)", "€30.00"],
      ["Up to 1 year (Yearly ticket)", "€300.00"],
      ["Up to 1 hour", "CHF 2.00 per hour (billed per 30 min)"],
      ["From 5 hours", "CHF 1.00 per hour (billed per 6 min)"],
      // Billed by the hour: a price per hour says so already.
      ["1 hour to 3 hours", "CHF 1.50 per hour"],
      ["Up to 1 month (Monthly ticket, Public transport season ticket)", "CHF 100.00"],
    ]);
    // The reader's locale places the symbol and the decimal separator.
    expect(text(pricing?.rows?.[0][1], "de")).toBe("2,00 €");
    expect(text(pricing?.rows?.[6][1], "de")).toBe("1,50 CHF pro Stunde");
    expect(text(pricing?.rows?.[2][0], "de")).toBe("Bis 1 Monat (P-Card)");
    expect(text(pricing?.rows?.[4][1], "de")).toMatch(/pro Stunde \(abgerechnet je 30\s?Min/);
  });

  it("without rate rows the pricing shows the tariff text, else free or paid", () => {
    const pricing = (over: Partial<ParkingSite>) =>
      section(mapParkingSiteToDetail(makeSite(over)).sections, "Pricing");

    expect(pricing({ tariffText: "1 € je Stunde", free: false })?.content).toBe("1 € je Stunde");
    expect(text(pricing({ free: true })?.content)).toBe("Free Parking");
    expect(text(pricing({ free: false })?.content)).toBe("Paid Parking");
    expect(pricing({})).toBeUndefined();
  });

  it("shows the opening-hours text only without OSM hours, and the notes collapsed", () => {
    const withText = mapParkingSiteToDetail(
      makeSite({ openingHoursText: "Mo-Fr 7-20 Uhr", notes: "Einfahrt über die Kaiserstraße" }),
    );
    expect(section(withText.sections, "Opening Hours")?.content).toBe("Mo-Fr 7-20 Uhr");
    const notes = withText.sections.find((s) => text(s.title) === "Notes");
    expect(notes).toMatchObject({ content: "Einfahrt über die Kaiserstraße", collapsed: true });

    const withHours = mapParkingSiteToDetail(
      makeSite({ openingHours: "Mo-Fr 07:00-20:00", openingHoursText: "Mo-Fr 7-20 Uhr" }),
    );
    expect(withHours.openingHours).toBe("Mo-Fr 07:00-20:00");
    expect(section(withHours.sections, "Opening Hours")).toBeUndefined();
  });

  it("names the site's type, its operator and its audience", () => {
    const detail = mapParkingSiteToDetail(
      makeSite({
        type: "truck_parking",
        operator: "APCOA",
        website: "https://apcoa.de",
        audience: "customers",
      }),
    );

    expect(rowsOf(section(detail.sections, "Facility"))).toEqual([
      ["Type", "Truck Parking"],
      ["Access", "Customers"],
    ]);
    expect(detail.operator).toEqual({ name: "APCOA", url: "https://apcoa.de" });
    expect(detail.identity).toEqual({ operator: "APCOA" });
    expect(detail.branding?.logoUrl).toBeUndefined();
    expect(detail.branding?.catalogueLogo).toEqual({
      qid: expect.stringMatching(/^Q\d+$/),
      file: expect.any(String),
    });
    expect(detail.parkAndRide).toBeUndefined();
  });

  it("drops upstream URLs that are not http(s)", () => {
    const site = makeSite({
      operator: "APCOA",
      website: "javascript:alert(1)",
      attributions: [
        {
          sourceId: "de-bw-mobidata-parking",
          name: "MobiData BW",
          url: "data:text/html,<script>alert(1)</script>",
          licenseUrl: "javascript:alert(1)",
        },
      ],
    });
    const emitted = JSON.stringify([mapParkingSiteToResult(site), mapParkingSiteToDetail(site)]);

    expect(emitted).not.toMatch(/"(?:javascript:|data:)/);
    expect(mapParkingSiteToDetail(site).operator).toEqual({ name: "APCOA" });
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

describe("parking strings", () => {
  it("every token the mapper emits exists in en and de", () => {
    const site = makeSite({
      name: "",
      type: "rest_area_parking",
      layout: "single_level",
      capacity: 50,
      available: 10,
      status: "almost_full",
      trend: "clearing",
      at: AT,
      audience: "restricted",
      free: false,
      openingHoursText: "daily",
      notes: "note",
      heightLimitCm: 200,
      maxStayMin: 120,
      reservation: true,
      amenities: ["toilets"],
      areas: [
        ...OC_VEHICLE_TYPES.map((v) => area(v, "any", { capacity: 5, available: 1 })),
        ...OC_USER_GROUPS.flatMap((g) => [area("car", g), area("truck", g, { capacity: 2 })]),
        area("bus", "taxi", { capacity: 2, maxStayMin: 30, hours: "Mo-Fr 08:00-18:00" }),
      ],
      rates: [
        {
          currency: "EUR",
          rows: [
            { kind: "flat", amount: 1 },
            { kind: "flat", amount: 1, fromMin: 30 },
            { kind: "flat", amount: 1, fromMin: 30, toMin: 20160 },
            { kind: "per_hour", amount: 1 },
            { kind: "per_hour", amount: 1, stepMin: 15 },
            ...["p_card", "reservation", "monthly_ticket", "yearly_ticket", "long_term"].map(
              (g) => ({ kind: "flat" as const, amount: 1, toMin: 90, userGroups: [g] }),
            ),
            {
              kind: "flat",
              amount: 1,
              toMin: 120,
              userGroups: ["public_transport_season_ticket"],
            },
          ],
        },
      ],
    });
    const layouts = [
      "single_level",
      "multi_storey",
      "underground",
      "underground_and_multi_storey",
      "surface",
      "automated",
      "covered",
      "nested",
    ] as const;
    const types = [
      "off_street",
      "on_street",
      "park_and_ride",
      "truck_parking",
      "rest_area_parking",
    ] as const;
    const variants = [
      site,
      ...layouts.map((layout) => makeSite({ layout })),
      ...types.map((type) => makeSite({ type })),
      ...(
        ["open", "closed", "full", "almost_full", "spaces_available", "closed_abnormally"] as const
      ).map((status) => makeSite({ status, available: 3 })),
      ...(["filling", "clearing", "steady"] as const).map((trend) =>
        makeSite({ trend, available: 3 }),
      ),
      ...(["public", "customers", "permit", "private", "restricted"] as const).map((audience) =>
        makeSite({ audience }),
      ),
      makeSite({ free: true }),
      makeSite({ closed: true }),
      makeSite({ stale: true, available: 1 }),
      makeSite({ capacity: 3 }),
    ];

    const keys = new Set<string>();
    for (const s of variants) {
      for (const t of tokensIn([mapParkingSiteToResult(s), mapParkingSiteToDetail(s)])) {
        keys.add(t.$t);
      }
    }

    expect(keys.size).toBeGreaterThan(40);
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
    expect(en).not.toHaveProperty("quality");
  });
});

it("captures complete canonical receipts before mapping results and details", () => {
  const receipt = {
    sourceId: "exact-feed",
    name: "Publisher",
    url: "https://example.com",
    licensing: {
      version: 1,
      bindings: [
        { scope: "data", subject: "Data", license: { kind: "spdx", expression: "CC-BY-4.0" } },
      ],
    } as const,
    attributionText: "Required upstream notice",
    publisher: { name: "Original publisher", url: "https://publisher.example" },
  };
  const record = makeSite({ attributions: [receipt] });
  const result = mapParkingSiteToResult(record);
  const detail = mapParkingSiteToDetail(record);
  receipt.attributionText = "changed later";
  expect(result.contributors).toEqual([
    { ...receipt, attributionText: "Required upstream notice" },
  ]);
  expect(detail.contributors).toEqual(result.contributors);
});
