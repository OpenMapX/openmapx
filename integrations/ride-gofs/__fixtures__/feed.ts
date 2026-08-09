/** A spec-shaped GOFS 1.0 feed: two brands, one zone, a tariff, realtime booking. */
export const DISCOVERY = {
  last_updated: 1786269849,
  ttl: 300,
  version: "1.0",
  data: {
    en: {
      feeds: [
        { name: "system_information", url: "https://feed.example/system_information.json" },
        { name: "service_brands", url: "https://feed.example/service_brands.json" },
        { name: "zones", url: "https://feed.example/zones.json" },
        { name: "operating_rules", url: "https://feed.example/operating_rules.json" },
        { name: "calendars", url: "https://feed.example/calendars.json" },
        { name: "fares", url: "https://feed.example/fares.json" },
        { name: "booking_rules", url: "https://feed.example/booking_rules.json" },
        { name: "realtime_booking", url: "https://feed.example/realtime_booking" },
        { name: "wait_time", url: "https://feed.example/wait_time" },
      ],
    },
  },
};

export const SYSTEM_INFORMATION = {
  last_updated: 1786269849,
  ttl: 3600,
  version: "1.0",
  data: {
    language: "en",
    timezone: "America/Toronto",
    name: "Example Taxi Registry",
    operator: "Example City",
    url: "https://feed.example/",
    phone_number: "+15550001111",
  },
};

export const SERVICE_BRANDS = {
  last_updated: 1786269849,
  ttl: 3600,
  version: "1.0",
  data: {
    service_brands: [
      { brand_id: "regular", brand_name: "Regular Ride", brand_color: "#0055AA" },
      { brand_id: "large", brand_name: "Large Ride" },
    ],
  },
};

export const ZONES = {
  last_updated: 1786269849,
  ttl: 3600,
  version: "1.0",
  data: {
    zones: {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          zone_id: "city",
          properties: { name: "City" },
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [-74, 45],
                [-73, 45],
                [-73, 46],
                [-74, 46],
                [-74, 45],
              ],
            ],
          },
        },
      ],
    },
  },
};

export const OPERATING_RULES = {
  last_updated: 1786269849,
  ttl: 3600,
  version: "1.0",
  data: {
    operating_rules: [
      {
        from_zone_id: "city",
        to_zone_id: "city",
        calendars: ["all"],
        brand_id: "regular",
        fare_id: "std",
      },
      {
        from_zone_id: "city",
        to_zone_id: "city",
        calendars: ["all"],
        brand_id: "large",
        fare_id: "std",
      },
    ],
  },
};

export const CALENDARS = {
  last_updated: 1786269849,
  ttl: 3600,
  version: "1.0",
  data: {
    calendars: [{ calendar_id: "all", start_date: "2026-01-01", end_date: "2026-12-31" }],
  },
};

export const FARES = {
  last_updated: 1786269849,
  ttl: 3600,
  version: "1.0",
  data: {
    fares: [
      {
        fare_id: "std",
        currency: "CAD",
        rider: [{ amount: 3.5 }],
        kilometer: [{ amount: 1.75 }],
        minute: [{ amount: 0.65 }],
      },
    ],
  },
};

export const BOOKING_RULES = {
  last_updated: 1786269849,
  ttl: 3600,
  version: "1.0",
  data: {
    booking_rules: [
      {
        from_zone_ids: ["city"],
        booking_type: 0,
        info_url: "https://feed.example/how-to-book",
        booking_url: "https://feed.example/book",
        phone_number: "+15550001111",
      },
    ],
  },
};

export const REALTIME_BOOKING = {
  last_updated: 1786269849,
  ttl: 30,
  version: "1.0",
  data: {
    realtime_booking: [
      {
        brand_id: "regular",
        wait_time: 240,
        travel_time: 900,
        travel_cost: 18.75,
        travel_cost_currency: "CAD",
        booking_detail: {
          service_name: "Example Taxi",
          web_uri: "https://feed.example/book",
          android_uri: "exampletaxi://book",
          ios_uri: "exampletaxi://book",
          phone_number: "+15550001111",
        },
      },
    ],
  },
};

/** URL → document, for stubbing the feed client's fetcher in tests. */
export const FEED_DOCUMENTS: Record<string, unknown> = {
  "https://feed.example/gofs.json": DISCOVERY,
  "https://feed.example/system_information.json": SYSTEM_INFORMATION,
  "https://feed.example/service_brands.json": SERVICE_BRANDS,
  "https://feed.example/zones.json": ZONES,
  "https://feed.example/operating_rules.json": OPERATING_RULES,
  "https://feed.example/calendars.json": CALENDARS,
  "https://feed.example/fares.json": FARES,
  "https://feed.example/booking_rules.json": BOOKING_RULES,
};

/**
 * Transcribed from the live Freebee Miami Beach feed on 2026-08-09 (the
 * upstream registry lists its URL). Hostnames are rewritten to lean.example so
 * the data-flow guard does not read a fixture literal as a real contacted
 * host. Every other field is kept verbatim in shape:
 * the discovery document is served at the base URL with no
 * `/gofs.json` suffix, dates are `YYYYMMDD`, pickup windows are `HH:MM:SS`,
 * brand colours have no `#`, every `ttl` is 0, `last_updated` is in
 * milliseconds rather than the schema's seconds, and wait times are scoped by
 * zone pair rather than by brand. There are no fares, no booking rules and no
 * realtime booking — so this feed yields availability and a wait time only.
 */
const LEAN_BASE = "https://lean.example/gofs/11";

export const LEAN_FEED_DOCUMENTS: Record<string, unknown> = {
  [LEAN_BASE]: {
    last_updated: 1786269849429,
    ttl: 0,
    version: "1.0",
    data: {
      en: {
        feeds: [
          { name: "system_information", url: `${LEAN_BASE}/system_information` },
          { name: "gofs_versions", url: `${LEAN_BASE}/gofs_versions` },
          { name: "service_brands", url: `${LEAN_BASE}/service_brands` },
          { name: "zones", url: `${LEAN_BASE}/zones` },
          { name: "operating_rules", url: `${LEAN_BASE}/operating_rules` },
          { name: "calendars", url: `${LEAN_BASE}/calendars` },
          { name: "vehicle_types", url: `${LEAN_BASE}/vehicle_types` },
          { name: "wait_times", url: `${LEAN_BASE}/wait_times` },
        ],
      },
    },
  },
  [`${LEAN_BASE}/system_information`]: {
    last_updated: 1786269864565,
    ttl: 0,
    version: "1.0",
    data: {
      language: "en",
      timezone: "America/New_York",
      name: "Freebee",
      url: "https://lean.example",
      email: "support@lean.example",
    },
  },
  [`${LEAN_BASE}/service_brands`]: {
    last_updated: 1786269865019,
    ttl: 0,
    version: "1.0",
    data: {
      service_brands: [
        {
          brand_id: "shared_ride",
          brand_name: "Shared Ride",
          brand_color: "042553",
          brand_text_color: "FFFFFF",
        },
      ],
    },
  },
  [`${LEAN_BASE}/vehicle_types`]: {
    last_updated: 1786269865400,
    ttl: 0,
    version: "1.0",
    data: {
      vehicle_types: [
        {
          vehicle_type_id: "vehicle_type_zone_11_5_boarding_inaccessible",
          max_capacity: 5,
          wheelchair_boarding: "boarding_inaccessible",
        },
        {
          vehicle_type_id: "vehicle_type_zone_11_6_boarding_inaccessible",
          max_capacity: 6,
          wheelchair_boarding: "boarding_inaccessible",
        },
      ],
    },
  },
  [`${LEAN_BASE}/calendars`]: {
    last_updated: 1786269865212,
    ttl: 0,
    version: "1.0",
    data: {
      calendars: [
        {
          calendar_id: "calendar_zone_11_390_1305_mon_tue_wed_thu_fri",
          days: ["mon", "tue", "wed", "thu", "fri"],
          start_date: "20240101",
          end_date: "20270809",
        },
      ],
    },
  },
  [`${LEAN_BASE}/operating_rules`]: {
    last_updated: 1786269865626,
    ttl: 0,
    version: "1.0",
    data: {
      operating_rules: [
        {
          from_zone_id: "11",
          to_zone_id: "11",
          start_pickup_window: "06:30:00",
          end_pickup_window: "21:45:00",
          calendars: ["calendar_zone_11_390_1305_mon_tue_wed_thu_fri"],
          brand_id: "shared_ride",
          vehicle_type_id: [
            "vehicle_type_zone_11_5_boarding_inaccessible",
            "vehicle_type_zone_11_6_boarding_inaccessible",
          ],
        },
      ],
    },
  },
  [`${LEAN_BASE}/zones`]: {
    last_updated: 1786269865800,
    ttl: 0,
    version: "1.0",
    data: {
      zones: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            zone_id: "11",
            geometry: {
              type: "Polygon",
              coordinates: [
                [
                  [-80.14, 25.77],
                  [-80.11, 25.77],
                  [-80.11, 25.88],
                  [-80.14, 25.88],
                  [-80.14, 25.77],
                ],
              ],
            },
          },
        ],
      },
    },
  },
  [`${LEAN_BASE}/wait_times`]: {
    last_updated: 1786269865995,
    ttl: 0,
    version: "1.0",
    data: { wait_times: [{ from_zone_ids: ["11"], to_zone_ids: ["11"], wait_time: 300 }] },
  },
};

export const LEAN_FEED_CONFIG = { id: "lean", name: "Freebee", url: LEAN_BASE };
/** Inside the lean feed's zone, on a weekday inside its pickup window. */
export const LEAN_IN_ZONE: [number, number] = [-80.13, 25.79];
