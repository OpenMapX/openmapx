// integrations/hotels/providers.ts
import type { HotelProvider, HotelProviderConfig, HotelQuery } from "./types.js";

const enc = encodeURIComponent;

/** `name` (+ city), URL-encoded — the OTA free-text destination term. */
function term(q: HotelQuery): string {
  return enc([q.name, q.city].filter(Boolean).join(" ").trim());
}

const adults = (q: HotelQuery) => q.adults ?? 2;
const rooms = (q: HotelQuery) => q.rooms ?? 1;

interface ProviderSpec {
  id: string;
  name: string;
  homepage: string;
  color: string;
  regions: readonly string[] | "*";
  build: (q: HotelQuery) => string;
}

/**
 * OTA registry. Each builder produces the most location/date-scoped search URL
 * the platform supports, so the user lands on the right hotel/city with dates
 * pre-filled (see docs/plans/hotel-prices-and-booking.md). Order is the default
 * UI order. Adding an OTA is one entry here.
 */
const SPECS: readonly ProviderSpec[] = [
  {
    id: "booking",
    name: "Booking.com",
    homepage: "https://www.booking.com/",
    color: "#003580",
    regions: "*",
    build: (q) => {
      const params = new URLSearchParams({ ss: [q.name, q.city].filter(Boolean).join(" ") });
      if (q.checkIn) params.set("checkin", q.checkIn);
      if (q.checkOut) params.set("checkout", q.checkOut);
      params.set("group_adults", String(adults(q)));
      params.set("no_rooms", String(rooms(q)));
      params.set("group_children", "0");
      if (typeof q.lat === "number" && typeof q.lng === "number") {
        params.set("latitude", String(q.lat));
        params.set("longitude", String(q.lng));
      }
      return `https://www.booking.com/searchresults.html?${params.toString()}`;
    },
  },
  {
    id: "expedia",
    name: "Expedia",
    homepage: "https://www.expedia.com/",
    color: "#FFC72C",
    regions: "*",
    build: (q) => {
      const params = new URLSearchParams({
        destination: [q.name, q.city].filter(Boolean).join(", "),
        adults: String(adults(q)),
        rooms: String(rooms(q)),
      });
      if (q.checkIn) params.set("startDate", q.checkIn);
      if (q.checkOut) params.set("endDate", q.checkOut);
      return `https://www.expedia.com/Hotel-Search?${params.toString()}`;
    },
  },
  {
    id: "hotelscom",
    name: "Hotels.com",
    homepage: "https://www.hotels.com/",
    color: "#D32F2F",
    regions: "*",
    build: (q) => {
      const params = new URLSearchParams({
        destination: [q.name, q.city].filter(Boolean).join(", "),
        adults: String(adults(q)),
        rooms: String(rooms(q)),
      });
      if (q.checkIn) params.set("startDate", q.checkIn);
      if (q.checkOut) params.set("endDate", q.checkOut);
      return `https://www.hotels.com/Hotel-Search?${params.toString()}`;
    },
  },
  {
    id: "agoda",
    name: "Agoda",
    homepage: "https://www.agoda.com/",
    color: "#5C26FF",
    regions: "*",
    build: (q) => {
      const params = new URLSearchParams({
        q: [q.name, q.city].filter(Boolean).join(" "),
        adults: String(adults(q)),
        rooms: String(rooms(q)),
      });
      if (q.checkIn) params.set("checkIn", q.checkIn);
      if (q.checkOut) params.set("checkOut", q.checkOut);
      return `https://www.agoda.com/search?${params.toString()}`;
    },
  },
  {
    id: "tripcom",
    name: "Trip.com",
    homepage: "https://www.trip.com/",
    color: "#287DFA",
    regions: "*",
    build: (q) => {
      const params = new URLSearchParams({
        keyword: [q.name, q.city].filter(Boolean).join(" "),
        adult: String(adults(q)),
        crn: String(rooms(q)),
      });
      if (q.checkIn) params.set("checkin", q.checkIn);
      if (q.checkOut) params.set("checkout", q.checkOut);
      return `https://www.trip.com/hotels/list?${params.toString()}`;
    },
  },
  {
    id: "hrs",
    name: "HRS",
    homepage: "https://www.hrs.de/",
    color: "#E2001A",
    regions: ["de", "at", "ch"],
    // HRS exposes no stable name-search deep link; the city landing page is the
    // best addressable target (the user then refines). Falls back to homepage.
    build: (q) => (q.city ? `https://www.hrs.de/hotel/${term(q)}/` : "https://www.hrs.de/"),
  },
];

/**
 * Apply an operator-configured affiliate wrapper, if one exists. The template
 * must contain `{url}`, replaced with the URL-encoded destination. No template
 * ⇒ the plain link is returned unchanged. Mirrors food-delivery.
 */
function withAffiliate(id: string, url: string, config: HotelProviderConfig): string {
  const tmpl = config.affiliateTemplates?.[id]?.trim();
  if (!tmpl?.includes("{url}")) return url;
  return tmpl.replace("{url}", enc(url));
}

export const HOTEL_PROVIDERS: readonly HotelProvider[] = SPECS.map((spec) => ({
  id: spec.id,
  name: spec.name,
  homepage: spec.homepage,
  color: spec.color,
  regions: spec.regions,
  build(query: HotelQuery, config: HotelProviderConfig): string {
    let url = spec.build(query);
    if (spec.id === "booking" && config.bookingAid?.trim()) {
      url += `${url.includes("?") ? "&" : "?"}aid=${enc(config.bookingAid.trim())}`;
    }
    return withAffiliate(spec.id, url, config);
  },
}));

export function getHotelProvider(id: string): HotelProvider | undefined {
  return HOTEL_PROVIDERS.find((p) => p.id === id);
}

/** Whether a provider serves the given country (or is global). */
export function providerServes(provider: HotelProvider, countryCode?: string): boolean {
  if (provider.regions === "*") return true;
  if (!countryCode) return true; // no country known ⇒ don't pre-filter
  return provider.regions.includes(countryCode.toLowerCase());
}
