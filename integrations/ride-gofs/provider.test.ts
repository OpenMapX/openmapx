import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import { describe, expect, it, vi } from "vitest";
import {
  FEED_DOCUMENTS,
  LEAN_FEED_CONFIG,
  LEAN_FEED_DOCUMENTS,
  LEAN_IN_ZONE,
  REALTIME_BOOKING,
  SYSTEM_INFORMATION,
} from "./__fixtures__/feed.js";
import { createGofsRideProvider } from "./provider.js";

const feedConfig = { id: "example", name: "Example Taxi", url: "https://feed.example/gofs.json" };
const inZone = [-73.57, 45.5] as [number, number];
const outOfZone = [2.35, 48.85] as [number, number];

function providerWith(extra: Record<string, unknown> = {}) {
  const docs: Record<string, unknown> = { ...FEED_DOCUMENTS, ...extra };
  const ctx = createMockIntegrationContext({ id: "ride-gofs", config: {} });
  const fetchJson = vi.fn(async (url: string) => {
    const base = url.split("?")[0];
    if (base === "https://feed.example/realtime_booking") return REALTIME_BOOKING;
    if (base === "https://feed.example/wait_time") {
      return { data: { wait_times: [{ brand_id: "large", wait_time: 600 }] } };
    }
    if (!(base in docs)) throw new Error(`404 ${base}`);
    return docs[base];
  });
  return { provider: createGofsRideProvider(ctx, feedConfig, fetchJson), fetchJson };
}

describe("getAvailability", () => {
  it("is available inside the service zone, with the matching brands", async () => {
    const { provider } = providerWith();
    const result = await provider.getAvailability({ pickup: inZone, dropoff: inZone });
    expect(result.data.available).toBe(true);
    expect(result.data.coverageChecked).toBe(true);
    expect(result.data.products.map((p) => p.id)).toEqual(["regular", "large"]);
    expect(result.data.products[0].name).toBe("Regular Ride");
    expect(result.data.products[0].color).toBe("#0055AA");
  });

  it("is unavailable outside every zone", async () => {
    const { provider } = providerWith();
    const result = await provider.getAvailability({ pickup: outOfZone });
    expect(result.data.available).toBe(false);
    expect(result.data.reason).toBe("outside-service-area");
  });

  it("surfaces the feed's booking rules", async () => {
    const { provider } = providerWith();
    const result = await provider.getAvailability({ pickup: inZone });
    expect(result.data.bookingRules?.bookingType).toBe(0);
    expect(result.data.bookingRules?.infoUrl).toBe("https://feed.example/how-to-book");
  });

  it("applies a rule with no brand_id to every service brand", async () => {
    // The spec: "If this field is not provided, the operating rule applies to
    // every service brand defined in service_brands.json." Skipping such a
    // rule would report no products and drop a feed that does cover the trip.
    const { provider } = providerWith({
      "https://feed.example/operating_rules.json": {
        ttl: 3600,
        data: {
          operating_rules: [
            { from_zone_id: "city", to_zone_id: "city", calendars: ["all"], fare_id: "std" },
          ],
        },
      },
    });
    const result = await provider.getAvailability({ pickup: inZone, dropoff: inZone });
    expect(result.data.available).toBe(true);
    expect(result.data.products.map((p) => p.id)).toEqual(["regular", "large"]);
  });

  it("attributes to the feed's system name", async () => {
    const { provider } = providerWith();
    const result = await provider.getAvailability({ pickup: inZone });
    expect(result.attributions[0].name).toBe("Example Taxi Registry");
  });
});

describe("getQuotes", () => {
  it("prefers realtime_booking, marking the fare as quoted", async () => {
    const { provider } = providerWith();
    const result = await provider.getQuotes?.({ pickup: inZone, dropoff: inZone });
    const quote = result?.data.find((q) => q.productId === "regular");
    expect(quote?.pickupEtaSeconds).toBe(240);
    expect(quote?.travelSeconds).toBe(900);
    expect(quote?.fare).toEqual({ amount: 18.75, currency: "CAD", basis: "quoted" });
    expect(quote?.handoff?.webUrl).toContain("https://feed.example/book");
    expect(quote?.handoff?.androidUrl).toBe("exampletaxi://book");
    expect(quote?.handoff?.carriesCoordinates).toBe(true);
  });

  it("preserves the scheduled instant in realtime booking handoffs after a DST change", async () => {
    const { provider } = providerWith();
    const result = await provider.getQuotes?.({
      pickup: inZone,
      dropoff: inZone,
      pickupAt: "2026-11-01T03:30",
    });
    const handoff = result?.data.find((quote) => quote.productId === "regular")?.handoff;
    expect(handoff).toBeDefined();
    const url = new URL(handoff?.webUrl ?? "");
    expect(url.searchParams.get("pickup_time")).toBe(
      String(Date.parse("2026-11-01T08:30:00Z") / 1000),
    );
    expect(url.searchParams.get("pickup_lat")).toBe("45.5");
    expect(handoff?.androidUrl).toBe("exampletaxi://book");
  });

  it("falls back to wait_time plus the static tariff, marking the fare estimated", async () => {
    const { provider } = providerWith();
    const result = await provider.getQuotes?.({
      pickup: inZone,
      dropoff: inZone,
      route: { distanceMeters: 8000, durationSeconds: 900 },
    });
    const quote = result?.data.find((q) => q.productId === "large");
    // 3.50 rider + (8 km x 1.75) + (15 min x 0.65) = 3.50 + 14 + 9.75
    expect(quote?.pickupEtaSeconds).toBe(600);
    expect(quote?.fare?.basis).toBe("estimated");
    expect(quote?.fare?.amount).toBeCloseTo(27.25, 2);
  });

  it("omits the fare when there is no route to price against", async () => {
    const { provider } = providerWith();
    const result = await provider.getQuotes?.({ pickup: inZone, dropoff: inZone });
    const quote = result?.data.find((q) => q.productId === "large");
    expect(quote?.pickupEtaSeconds).toBe(600);
    expect(quote?.fare).toBeUndefined();
  });

  it("returns nothing outside the service area", async () => {
    const { provider } = providerWith();
    const result = await provider.getQuotes?.({ pickup: outOfZone });
    expect(result?.data).toEqual([]);
  });
});

describe("createHandoff", () => {
  it("uses the feed's booking_url with GOFS deep-link parameters", async () => {
    const { provider } = providerWith();
    const handoff = await provider.createHandoff({ pickup: inZone, dropoff: [-73.6, 45.52] });
    const url = new URL(handoff.webUrl);
    expect(url.origin + url.pathname).toBe("https://feed.example/book");
    expect(url.searchParams.get("pickup_lat")).toBe("45.5");
    expect(url.searchParams.get("drop_off_lon")).toBe("-73.6");
    expect(handoff.carriesCoordinates).toBe(true);
    expect(handoff.phoneNumber).toBe("+15550001111");
  });

  it("converts a wall-clock pickup time to GOFS epoch seconds in the feed's timezone", async () => {
    const { provider } = providerWith();
    // The fixture's system timezone is America/Toronto (UTC-4 in August), so
    // 14:00 local is 18:00 UTC.
    const handoff = await provider.createHandoff({
      pickup: inZone,
      dropoff: inZone,
      pickupAt: "2026-08-11T14:00",
    });
    const pickupTime = new URL(handoff.webUrl).searchParams.get("pickup_time");
    expect(pickupTime).toBe(String(Date.parse("2026-08-11T18:00:00Z") / 1000));
  });

  it.each([
    ["after the spring transition", "America/Toronto", "2026-03-08T03:30", "2026-03-08T07:30:00Z"],
    ["after the fall transition", "America/Toronto", "2026-11-01T03:30", "2026-11-01T08:30:00Z"],
    [
      "the earlier instant in a fold",
      "America/Toronto",
      "2026-11-01T01:30",
      "2026-11-01T05:30:00Z",
    ],
    [
      "the first valid instant after a gap",
      "America/Toronto",
      "2026-03-08T02:30",
      "2026-03-08T07:00:00Z",
    ],
    ["a fractional-hour offset", "Asia/Kolkata", "2026-08-11T14:00", "2026-08-11T08:30:00Z"],
    ["midnight", "America/Toronto", "2026-08-11T00:00", "2026-08-11T04:00:00Z"],
  ])("uses feed-local Unix seconds for %s", async (_label, timezone, pickupAt, expected) => {
    const { provider } = providerWith({
      "https://feed.example/system_information.json": {
        ...SYSTEM_INFORMATION,
        data: { ...SYSTEM_INFORMATION.data, timezone },
      },
    });
    const handoff = await provider.createHandoff({ pickup: inZone, dropoff: inZone, pickupAt });
    expect(new URL(handoff.webUrl).searchParams.get("pickup_time")).toBe(
      String(Date.parse(expected) / 1000),
    );
  });

  it.each([
    ["malformed input", "America/Toronto", "not-a-date"],
    ["an impossible calendar date", "America/Toronto", "2026-02-30T14:00"],
    ["an invalid hour", "America/Toronto", "2026-08-11T25:00"],
    ["an unknown timezone", "Unknown/Zone", "2026-08-11T14:00"],
    ["an empty pickup time", "America/Toronto", ""],
  ])(
    "omits unresolvable pickup_time for %s while preserving the handoff",
    async (_label, timezone, pickupAt) => {
      const { provider } = providerWith({
        "https://feed.example/system_information.json": {
          ...SYSTEM_INFORMATION,
          data: { ...SYSTEM_INFORMATION.data, timezone },
        },
      });
      const handoff = await provider.createHandoff({
        pickup: inZone,
        dropoff: [-73.6, 45.52],
        pickupAddress: "Pickup address",
        dropoffAddress: "Dropoff address",
        pickupAt,
      });
      const url = new URL(handoff.webUrl);
      expect(url.origin + url.pathname).toBe("https://feed.example/book");
      expect(Object.fromEntries(url.searchParams)).toEqual({
        pickup_lat: "45.5",
        pickup_lon: "-73.57",
        pickup_address: "Pickup address",
        drop_off_lat: "45.52",
        drop_off_lon: "-73.6",
        drop_off_address: "Dropoff address",
      });
      expect(handoff.phoneNumber).toBe("+15550001111");
      expect(handoff.carriesCoordinates).toBe(true);
    },
  );

  it("omits pickup_time when the ride is immediate", async () => {
    const { provider } = providerWith();
    const handoff = await provider.createHandoff({ pickup: inZone, dropoff: inZone });
    expect(new URL(handoff.webUrl).searchParams.has("pickup_time")).toBe(false);
  });

  it("falls back to the system URL when the feed publishes no booking url", async () => {
    const { provider } = providerWith({
      "https://feed.example/booking_rules.json": {
        ttl: 3600,
        data: { booking_rules: [{ from_zone_ids: ["city"], booking_type: 0 }] },
      },
    });
    const handoff = await provider.createHandoff({ pickup: inZone });
    expect(handoff.webUrl).toBe("https://feed.example/");
    expect(handoff.carriesCoordinates).toBe(false);
  });
});

describe("contract shape", () => {
  it("declares quote capability and permits comparison", () => {
    const { provider } = providerWith();
    expect(provider.id).toBe("gofs-example");
    expect(provider.capabilities).toEqual({
      deepLink: true,
      quote: true,
      booking: false,
      tracking: false,
    });
    expect(provider.permitsComparison).toBe(true);
  });
});

/**
 * The lean feed is the realistic baseline: no fares, no booking rules, no
 * realtime booking, a language container, YYYYMMDD dates, HH:MM:SS windows,
 * unprefixed colours and zone-scoped wait times. If the provider only works
 * against the spec-shaped fixture it does not work against the one feed that
 * is actually live.
 */
describe("against the live Freebee feed shape", () => {
  function leanProvider() {
    const ctx = createMockIntegrationContext({ id: "ride-gofs", config: {} });
    const fetchJson = vi.fn(async (url: string) => {
      const base = url.split("?")[0];
      const doc = LEAN_FEED_DOCUMENTS[base];
      if (!doc) throw new Error(`404 ${base}`);
      return doc;
    });
    return createGofsRideProvider(ctx, LEAN_FEED_CONFIG, fetchJson);
  }

  it("reads the service brand through the language container", async () => {
    const result = await leanProvider().getAvailability({
      pickup: LEAN_IN_ZONE,
      dropoff: LEAN_IN_ZONE,
      pickupAt: "2026-08-11T09:00",
    });
    expect(result.data.available).toBe(true);
    expect(result.data.products.map((p) => p.id)).toEqual(["shared_ride"]);
  });

  it("normalises the unprefixed brand colours into CSS colours", async () => {
    const result = await leanProvider().getAvailability({
      pickup: LEAN_IN_ZONE,
      pickupAt: "2026-08-11T09:00",
    });
    expect(result.data.products[0].color).toBe("#042553");
    expect(result.data.products[0].textColor).toBe("#FFFFFF");
  });

  it("takes seats and accessibility from the rule's vehicle types", async () => {
    const result = await leanProvider().getAvailability({
      pickup: LEAN_IN_ZONE,
      pickupAt: "2026-08-11T09:00",
    });
    expect(result.data.products[0].seats).toBe(6);
    expect(result.data.products[0].wheelchairAccessible).toBe(false);
  });

  it("is unavailable outside the HH:MM:SS pickup window", async () => {
    const result = await leanProvider().getAvailability({
      pickup: LEAN_IN_ZONE,
      pickupAt: "2026-08-11T23:00",
    });
    expect(result.data.available).toBe(false);
  });

  it("is unavailable on a day the YYYYMMDD calendar excludes", async () => {
    // 2026-08-09 is a Sunday; the calendar covers mon–fri only.
    const result = await leanProvider().getAvailability({
      pickup: LEAN_IN_ZONE,
      pickupAt: "2026-08-09T09:00",
    });
    expect(result.data.available).toBe(false);
  });

  it("quotes a wait time from the zone-scoped entry, with no fare", async () => {
    const result = await leanProvider().getQuotes?.({
      pickup: LEAN_IN_ZONE,
      dropoff: LEAN_IN_ZONE,
      pickupAt: "2026-08-11T09:00",
      route: { distanceMeters: 5000, durationSeconds: 600 },
    });
    expect(result?.data).toHaveLength(1);
    expect(result?.data[0].pickupEtaSeconds).toBe(300);
    // The feed publishes no fares, so there is nothing to price against.
    expect(result?.data[0].fare).toBeUndefined();
  });

  it("falls back to the system URL for a feed with no booking rules", async () => {
    const handoff = await leanProvider().createHandoff({ pickup: LEAN_IN_ZONE });
    expect(handoff.webUrl).toBe("https://lean.example");
    expect(handoff.carriesCoordinates).toBe(false);
  });
});
