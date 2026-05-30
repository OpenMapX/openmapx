import { toYYMMDD } from "../dates.js";
import type { FlightProvider, FlightProviderConfig, FlightSearchQuery } from "../types.js";

/**
 * Plain consumer URL — no account required. Path dates are `YYMMDD`, airport
 * codes lowercase. Passengers/cabin/direct are query params.
 *   /transport/flights/{from}/{to}/{outYYMMDD}[/{inYYMMDD}]/?adults=&cabinclass=&rtn=
 */
function buildConsumerUrl(q: FlightSearchQuery): string {
  const segs = [toYYMMDD(q.departDate)];
  if (q.returnDate) segs.push(toYYMMDD(q.returnDate));
  const path = `/transport/flights/${q.from.toLowerCase()}/${q.to.toLowerCase()}/${segs.join("/")}/`;

  const params = new URLSearchParams();
  params.set("adults", String(q.adults));
  if (q.children > 0) params.set("children", String(q.children));
  if (q.infants > 0) params.set("infants", String(q.infants));
  params.set("cabinclass", q.cabin);
  params.set("rtn", q.returnDate ? "1" : "0");
  if (q.directOnly) params.set("preferdirects", "true");
  return `https://www.skyscanner.net${path}?${params.toString()}`;
}

/**
 * Affiliate referral (Impact) day-view URL — used only when a mediaPartnerId
 * is configured so commissions are tracked. Dates are `YYYY-MM-DD`, passengers
 * use the `adultsv2` name. Children require ages (not collected here) so they
 * fall back to the count-only consumer URL is NOT possible here; we simply omit
 * child/infant params in affiliate mode.
 */
function buildReferralUrl(q: FlightSearchQuery, mediaPartnerId: string): string {
  const params = new URLSearchParams();
  params.set("origin", q.from.toLowerCase());
  params.set("destination", q.to.toLowerCase());
  params.set("outboundDate", q.departDate);
  if (q.returnDate) params.set("inboundDate", q.returnDate);
  params.set("adultsv2", String(q.adults));
  params.set("cabinclass", q.cabin);
  if (q.directOnly) params.set("preferDirects", "true");
  params.set("mediaPartnerId", mediaPartnerId);
  return `https://www.skyscanner.net/g/referrals/v1/flights/day-view/?${params.toString()}`;
}

export const skyscannerProvider: FlightProvider = {
  id: "skyscanner",
  name: "Skyscanner",
  homepage: "https://www.skyscanner.net/",
  capabilities: {
    returnDate: true,
    adults: true,
    children: true,
    infants: true,
    cabin: true,
    directOnly: true,
  },
  build(q: FlightSearchQuery, config: FlightProviderConfig): string {
    const partnerId = config.skyscannerMediaPartnerId?.trim();
    return partnerId ? buildReferralUrl(q, partnerId) : buildConsumerUrl(q);
  },
};
