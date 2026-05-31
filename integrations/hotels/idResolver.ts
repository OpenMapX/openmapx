// integrations/hotels/idResolver.ts
import type { HotelProviderConfig, HotelQuery } from "./types.js";

const enc = encodeURIComponent;

/**
 * Build the exact-hotel deep link for an OTA from its resolved hotel id + the
 * stay (dates/occupancy). Returns null when the id is empty or the OTA isn't
 * id-buildable. Pure + unit-testable; the network resolution that produces `id`
 * lives elsewhere.
 *
 * Each base path matches the OTA's authoritative Wikidata formatter URL (P1630),
 * confirmed 2026-05-31: Expedia `…/$1.Hotel-Information`, Booking `…/hotel/$1.html`,
 * Hotels.com `…/$1/` (trailing slash), Agoda `…/$1.html`, Trip.com — we use the
 * `hotels/detail?hotelid=$1` form Google links to (cleanly accepts date params)
 * over the formatter's SEO path. The date/occupancy query params are best-effort
 * for Expedia/Hotels.com/Agoda (their sites are CAPTCHA-walled to live checks);
 * the exact-hotel base path is the verified part. Booking + Trip.com were also
 * confirmed live.
 */
export function buildExactDeepLink(
  ota: string,
  id: string,
  q: HotelQuery,
  _config: HotelProviderConfig,
): string | null {
  if (!id) return null;
  const adults = q.adults ?? 2;
  const rooms = q.rooms ?? 1;
  switch (ota) {
    case "tripcom": {
      const p = new URLSearchParams({ hotelid: id, adult: String(adults), crn: String(rooms) });
      if (q.checkIn) p.set("checkin", q.checkIn);
      if (q.checkOut) p.set("checkout", q.checkOut);
      return `https://www.trip.com/hotels/detail?${p.toString()}`;
    }
    case "expedia": {
      const p = new URLSearchParams();
      if (q.checkIn) p.set("chkin", q.checkIn);
      if (q.checkOut) p.set("chkout", q.checkOut);
      p.set("rm1", `a${adults}`);
      return `https://www.expedia.com/${enc(id)}.Hotel-Information?${p.toString()}`;
    }
    case "hotelscom": {
      const p = new URLSearchParams();
      if (q.checkIn) p.set("chkin", q.checkIn);
      if (q.checkOut) p.set("chkout", q.checkOut);
      p.set("rm1", `a${adults}`);
      // P3898 formatter is `…/$1/` — the trailing slash matters for routing.
      return `https://www.hotels.com/${enc(id)}/?${p.toString()}`;
    }
    case "agoda": {
      // id is the P6008 slug path (e.g. "paradise-inn-.../hotel/alexandria-eg");
      // the P6008 formatter appends `.html`.
      const p = new URLSearchParams({ adults: String(adults), rooms: String(rooms) });
      if (q.checkIn) p.set("checkIn", q.checkIn);
      if (q.checkOut) p.set("checkOut", q.checkOut);
      return `https://www.agoda.com/${id.replace(/^\//, "")}.html?${p.toString()}`;
    }
    case "booking": {
      const p = new URLSearchParams({
        group_adults: String(adults),
        no_rooms: String(rooms),
        group_children: "0",
      });
      if (q.checkIn) p.set("checkin", q.checkIn);
      if (q.checkOut) p.set("checkout", q.checkOut);
      return `https://www.booking.com/hotel/${id}.html?${p.toString()}`;
    }
    default:
      return null;
  }
}
