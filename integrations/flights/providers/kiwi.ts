import type { FlightProvider, FlightSearchQuery } from "../types.js";

/**
 * Kiwi.com `/deep` redirector — the cleanest pure consumer deep link, lands on
 * a fully pre-filled results page. Schema covers route + dates only; it defaults
 * to 1 adult / economy (passengers & cabin would require the keyed Tequila API).
 */
export const kiwiProvider: FlightProvider = {
  id: "kiwi",
  name: "Kiwi.com",
  homepage: "https://www.kiwi.com/",
  capabilities: {
    returnDate: true,
    adults: false,
    children: false,
    infants: false,
    cabin: false,
    directOnly: false,
  },
  build(q: FlightSearchQuery): string {
    const params = new URLSearchParams();
    params.set("from", q.from);
    params.set("to", q.to);
    params.set("departure", q.departDate);
    if (q.returnDate) params.set("return", q.returnDate);
    return `https://www.kiwi.com/deep?${params.toString()}`;
  },
};
