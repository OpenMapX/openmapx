import { describe, expect, it } from "vitest";
import {
  type GofsCalendar,
  type GofsFare,
  type GofsOperatingRule,
  type GofsZoneFeature,
  gofsCalendarActive,
  gofsEstimateFare,
  gofsFeedUrl,
  gofsMatchingRules,
  gofsWaitTimeFor,
  gofsZonesContaining,
  parseGofsDiscovery,
  parseGofsRealtimeBooking,
  parseGofsWaitTimes,
} from "../gofs.js";

/**
 * The language container is mandatory per `schema/gofs.json`
 * (`patternProperties: ^[a-z]{2,3}(-[A-Z]{2})?$`), and the live Freebee feed
 * uses it. `reference.md`'s prose showing a flat `data.feeds` is wrong; we
 * accept it anyway because a producer may have followed the prose.
 */
const discovery = {
  last_updated: 1786269849,
  ttl: 300,
  version: "1.0",
  data: {
    en: {
      feeds: [
        { name: "system_information", url: "https://feed.example/system_information.json" },
        { name: "zones", url: "https://feed.example/zones.json" },
        { name: "realtime_booking", url: "https://feed.example/realtime_booking" },
        { name: "", url: "https://feed.example/broken.json" },
        { name: "fares", url: "" },
      ],
    },
  },
};

describe("parseGofsDiscovery", () => {
  it("reads feeds out of the language container", () => {
    expect(parseGofsDiscovery(discovery).map((f) => f.name)).toEqual([
      "system_information",
      "zones",
      "realtime_booking",
    ]);
  });

  it("prefers the requested language when several are published", () => {
    const multi = {
      data: {
        en: { feeds: [{ name: "zones", url: "https://feed.example/en/zones" }] },
        fr: { feeds: [{ name: "zones", url: "https://feed.example/fr/zones" }] },
      },
    };
    expect(gofsFeedUrl(parseGofsDiscovery(multi, "fr"), "zones")).toBe(
      "https://feed.example/fr/zones",
    );
  });

  it("falls back to the first language when the requested one is absent", () => {
    const multi = { data: { fr: { feeds: [{ name: "zones", url: "https://x/fr" }] } } };
    expect(gofsFeedUrl(parseGofsDiscovery(multi, "en"), "zones")).toBe("https://x/fr");
  });

  it("also accepts the flat data.feeds shape the prose reference shows", () => {
    const flat = { data: { feeds: [{ name: "zones", url: "https://x/zones" }] } };
    expect(gofsFeedUrl(parseGofsDiscovery(flat), "zones")).toBe("https://x/zones");
  });

  it("drops references missing a name or url", () => {
    expect(parseGofsDiscovery(discovery)).toHaveLength(3);
  });

  it("returns an empty list for a malformed document", () => {
    expect(parseGofsDiscovery(null)).toEqual([]);
    expect(parseGofsDiscovery({ data: {} })).toEqual([]);
  });
});

describe("gofsFeedUrl", () => {
  it("finds a feed by name", () => {
    expect(gofsFeedUrl(parseGofsDiscovery(discovery), "zones")).toBe(
      "https://feed.example/zones.json",
    );
  });

  it("returns null for an unpublished feed", () => {
    expect(gofsFeedUrl(parseGofsDiscovery(discovery), "fares")).toBeNull();
  });

  it("treats wait_time and wait_times as the same endpoint", () => {
    const feeds = parseGofsDiscovery({
      data: { en: { feeds: [{ name: "wait_times", url: "https://x/wait_times" }] } },
    });
    expect(gofsFeedUrl(feeds, "wait_time")).toBe("https://x/wait_times");
  });
});

const square = (
  zone_id: string,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): GofsZoneFeature => ({
  type: "Feature",
  zone_id,
  geometry: {
    type: "Polygon",
    coordinates: [
      [
        [x0, y0],
        [x1, y0],
        [x1, y1],
        [x0, y1],
        [x0, y0],
      ],
    ],
  },
});

describe("gofsZonesContaining", () => {
  const zones = [square("inner", 0, 0, 10, 10), square("outer", -50, -50, 50, 50)];

  it("returns every zone containing the point", () => {
    expect(gofsZonesContaining(zones, [5, 5])).toEqual(["inner", "outer"]);
  });

  it("returns only the enclosing zone when the point is outside the other", () => {
    expect(gofsZonesContaining(zones, [20, 20])).toEqual(["outer"]);
  });

  it("returns nothing when the point is outside every zone", () => {
    expect(gofsZonesContaining(zones, [100, 100])).toEqual([]);
  });

  it("treats a point on the boundary as inside", () => {
    expect(gofsZonesContaining([square("z", 0, 0, 10, 10)], [0, 5])).toEqual(["z"]);
  });
});

describe("gofsCalendarActive", () => {
  const cal: GofsCalendar = {
    calendar_id: "weekdays",
    days: ["mon", "tue", "wed", "thu", "fri"],
    start_date: "2026-01-01",
    end_date: "2026-12-31",
    excepted_dates: ["2026-08-10"],
  };

  it("is active on a listed weekday inside the range", () => {
    // 2026-08-11 is a Tuesday.
    expect(gofsCalendarActive(cal, "2026-08-11")).toBe(true);
  });

  it("is inactive on an unlisted weekday", () => {
    // 2026-08-09 is a Sunday.
    expect(gofsCalendarActive(cal, "2026-08-09")).toBe(false);
  });

  it("is inactive on an excepted date", () => {
    // 2026-08-10 is a Monday but explicitly excepted.
    expect(gofsCalendarActive(cal, "2026-08-10")).toBe(false);
  });

  it("is inactive outside the date range", () => {
    expect(gofsCalendarActive(cal, "2025-06-01")).toBe(false);
  });

  it("treats an absent days list as every day", () => {
    const always: GofsCalendar = {
      calendar_id: "all",
      start_date: "2026-01-01",
      end_date: "2026-12-31",
    };
    expect(gofsCalendarActive(always, "2026-08-09")).toBe(true);
  });

  it("accepts the compact YYYYMMDD dates the live Freebee feed sends", () => {
    const compact: GofsCalendar = {
      calendar_id: "compact",
      days: ["mon", "tue", "wed", "thu", "fri"],
      start_date: "20240101",
      end_date: "20270809",
      excepted_dates: ["20260810"],
    };
    expect(gofsCalendarActive(compact, "2026-08-11")).toBe(true);
    expect(gofsCalendarActive(compact, "20260811")).toBe(true);
    expect(gofsCalendarActive(compact, "2026-08-10")).toBe(false);
    expect(gofsCalendarActive(compact, "2023-12-31")).toBe(false);
  });
});

describe("gofsMatchingRules", () => {
  const calendars: GofsCalendar[] = [
    { calendar_id: "all", start_date: "2026-01-01", end_date: "2026-12-31" },
  ];
  const rules: GofsOperatingRule[] = [
    { from_zone_id: "a", to_zone_id: "b", calendars: ["all"], brand_id: "regular" },
    { from_zone_id: "a", to_zone_id: "c", calendars: ["all"], brand_id: "large" },
    {
      from_zone_id: "a",
      to_zone_id: "b",
      calendars: ["all"],
      brand_id: "night",
      start_pickup_window: "22:00",
      end_pickup_window: "05:00",
    },
  ];

  it("matches rules whose zone pair is served", () => {
    const matched = gofsMatchingRules({
      rules,
      calendars,
      fromZoneIds: ["a"],
      toZoneIds: ["b"],
      at: "2026-08-11T12:00",
    });
    expect(matched.map((r) => r.brand_id)).toEqual(["regular"]);
  });

  it("includes a window rule when the pickup time falls inside a wrapped window", () => {
    const matched = gofsMatchingRules({
      rules,
      calendars,
      fromZoneIds: ["a"],
      toZoneIds: ["b"],
      at: "2026-08-11T23:30",
    });
    expect(matched.map((r) => r.brand_id)).toEqual(["regular", "night"]);
  });

  it("matches every destination zone when the dropoff is unknown", () => {
    const matched = gofsMatchingRules({
      rules,
      calendars,
      fromZoneIds: ["a"],
      toZoneIds: null,
      at: "2026-08-11T12:00",
    });
    expect(matched.map((r) => r.brand_id)).toEqual(["regular", "large"]);
  });

  it("includes a rule when the pickup time is exactly the window start in HH:MM:SS", () => {
    const seconds: GofsOperatingRule[] = [
      {
        from_zone_id: "a",
        to_zone_id: "a",
        calendars: ["all"],
        brand_id: "shared",
        start_pickup_window: "08:00:00",
        end_pickup_window: "19:45:00",
      },
    ];
    const matched = gofsMatchingRules({
      rules: seconds,
      calendars,
      fromZoneIds: ["a"],
      toZoneIds: ["a"],
      at: "2026-08-11T08:00",
    });
    expect(matched.map((r) => r.brand_id)).toEqual(["shared"]);
  });

  it("matches nothing when no calendar is active", () => {
    const matched = gofsMatchingRules({
      rules,
      calendars: [{ calendar_id: "all", start_date: "2020-01-01", end_date: "2020-12-31" }],
      fromZoneIds: ["a"],
      toZoneIds: ["b"],
      at: "2026-08-11T12:00",
    });
    expect(matched).toEqual([]);
  });
});

describe("gofsEstimateFare", () => {
  const fare: GofsFare = {
    fare_id: "std",
    currency: "CAD",
    rider: [{ amount: 3.5 }],
    kilometer: [
      { start: 0, end: 5, amount: 1.2 },
      { start: 5, amount: 0.9 },
    ],
    minute: [{ amount: 0.4 }],
    luggage: [{ amount: 1 }],
  };

  it("sums the flat rider charge with tiered distance and time", () => {
    // 3.50 base + (5 km x 1.20) + (3 km x 0.90) + (10 min x 0.40) = 3.50 + 6 + 2.70 + 4
    expect(gofsEstimateFare(fare, { kilometers: 8, minutes: 10 })).toBeCloseTo(16.2, 5);
  });

  it("charges only the first tier below its end", () => {
    // 3.50 + (2 km x 1.20) + (5 min x 0.40) = 3.50 + 2.40 + 2
    expect(gofsEstimateFare(fare, { kilometers: 2, minutes: 5 })).toBeCloseTo(7.9, 5);
  });

  it("multiplies the flat rider charge by the rider count", () => {
    expect(gofsEstimateFare(fare, { kilometers: 0, minutes: 0, riders: 3 })).toBeCloseTo(10.5, 5);
  });

  it("adds a per-item luggage charge", () => {
    expect(gofsEstimateFare(fare, { kilometers: 0, minutes: 0, luggage: 2 })).toBeCloseTo(5.5, 5);
  });

  it("returns null when no component is priced", () => {
    expect(
      gofsEstimateFare({ fare_id: "x", currency: "CAD" }, { kilometers: 5, minutes: 5 }),
    ).toBeNull();
  });

  /** The spec's own worked example for `interval`, reproduced exactly. */
  it("rounds each tier up to its charging interval", () => {
    const tiered: GofsFare = {
      fare_id: "intervals",
      currency: "CAD",
      // First 10 km at 3.30/km charged every 250 m; beyond that 4.30/km every 500 m.
      kilometer: [
        { interval: 0.25, end: 10, amount: 3.3 },
        { interval: 0.5, start: 10, amount: 4.3 },
      ],
    };
    // 2.1 km → billed as 2.25 km (9 x 250 m) x 3.30
    expect(gofsEstimateFare(tiered, { kilometers: 2.1, minutes: 0 })).toBeCloseTo(7.425, 5);
    // Exactly on a boundary, rounding is a no-op: 2 km → 8 x 250 m x 3.30
    expect(gofsEstimateFare(tiered, { kilometers: 2, minutes: 0 })).toBeCloseTo(6.6, 5);
    // 12.2 km → 10 km x 3.30 + 2.5 km (5 x 500 m) x 4.30
    expect(gofsEstimateFare(tiered, { kilometers: 12.2, minutes: 0 })).toBeCloseTo(43.75, 5);
  });

  it("charges a tier continuously when it declares no interval", () => {
    const flat: GofsFare = { fare_id: "flat", currency: "CAD", kilometer: [{ amount: 2 }] };
    expect(gofsEstimateFare(flat, { kilometers: 2.1, minutes: 0 })).toBeCloseTo(4.2, 5);
  });
});

describe("parseGofsRealtimeBooking", () => {
  it("returns entries with a brand and a wait time", () => {
    const entries = parseGofsRealtimeBooking({
      data: {
        realtime_booking: [
          {
            brand_id: "regular",
            wait_time: 240,
            travel_time: 600,
            travel_cost: 14.5,
            travel_cost_currency: "CAD",
            booking_detail: { web_uri: "https://book.example/ride" },
          },
          { wait_time: 100 },
          { brand_id: "broken", wait_time: "soon" },
        ],
      },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].brand_id).toBe("regular");
    expect(entries[0].booking_detail?.web_uri).toBe("https://book.example/ride");
  });

  it("returns an empty list for a malformed document", () => {
    expect(parseGofsRealtimeBooking({ data: {} })).toEqual([]);
    expect(parseGofsRealtimeBooking(null)).toEqual([]);
  });
});

describe("parseGofsWaitTimes", () => {
  it("parses the spec's brand-scoped entries", () => {
    const entries = parseGofsWaitTimes({
      data: { wait_times: [{ brand_id: "regular", wait_time: 300 }, { wait_time: 100 }] },
    });
    expect(entries).toEqual([
      { brand_id: "regular", wait_time: 300, from_zone_ids: undefined, to_zone_ids: undefined },
    ]);
  });

  it("parses the zone-scoped entries the live Freebee feed returns", () => {
    const entries = parseGofsWaitTimes({
      data: { wait_times: [{ from_zone_ids: ["11"], to_zone_ids: ["11"], wait_time: 300 }] },
    });
    expect(entries[0].brand_id).toBeNull();
    expect(entries[0].wait_time).toBe(300);
    expect(entries[0].from_zone_ids).toEqual(["11"]);
  });
});

describe("gofsWaitTimeFor", () => {
  it("prefers a brand-scoped entry", () => {
    const entries = parseGofsWaitTimes({
      data: {
        wait_times: [
          { brand_id: "regular", wait_time: 120 },
          { from_zone_ids: ["11"], to_zone_ids: ["11"], wait_time: 300 },
        ],
      },
    });
    expect(gofsWaitTimeFor(entries, "regular", ["11"], ["11"])).toBe(120);
  });

  it("falls back to a zone-scoped entry covering the pair", () => {
    const entries = parseGofsWaitTimes({
      data: { wait_times: [{ from_zone_ids: ["11"], to_zone_ids: ["11"], wait_time: 300 }] },
    });
    expect(gofsWaitTimeFor(entries, "shared_ride", ["11"], ["11"])).toBe(300);
  });

  it("applies a zone-scoped entry when the dropoff zone is unknown", () => {
    const entries = parseGofsWaitTimes({
      data: { wait_times: [{ from_zone_ids: ["11"], to_zone_ids: ["11"], wait_time: 300 }] },
    });
    expect(gofsWaitTimeFor(entries, "shared_ride", ["11"], null)).toBe(300);
  });

  it("returns null when no entry covers the pair", () => {
    const entries = parseGofsWaitTimes({
      data: { wait_times: [{ from_zone_ids: ["11"], to_zone_ids: ["11"], wait_time: 300 }] },
    });
    expect(gofsWaitTimeFor(entries, "shared_ride", ["99"], ["99"])).toBeNull();
  });
});
