import type { HotelOffer } from "@openmapx/core/server";
import { fetchLiteApiOffer, type RateOptions } from "./liteapi.js";
import type { HotelQuery } from "./types.js";

/**
 * A live hotel-rates provider. `searchOffer` does read-only price display.
 * Optional `prebook`/`book` (booking) methods can be added to the SAME object
 * later — the shape is fixed now so booking drops in without touching call sites.
 */
export interface HotelRatesProvider {
  readonly id: string;
  /** Lowest live offer for the place, or null when no match/availability/error. */
  searchOffer(query: HotelQuery, opts: RateOptions): Promise<HotelOffer | null>;
  // --- Phase C (future, NOT implemented in Phase B) ---
  // prebook?(rateId: string): Promise<PrebookSession>;
  // book?(session: PrebookSession, guest: GuestDetails, payment: PaymentRef): Promise<BookingConfirmation>;
}

/** LiteAPI-backed provider. The route holds one instance per configured key. */
export function createLiteApiProvider(apiKey: string): HotelRatesProvider {
  return {
    id: "liteapi",
    searchOffer: (query, opts) => fetchLiteApiOffer(apiKey, opts, query),
  };
}
