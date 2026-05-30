import type { FlightProvider, FlightSearchQuery } from "../types.js";

const CABIN_TEXT: Record<FlightSearchQuery["cabin"], string> = {
  economy: "economy",
  premiumeconomy: "premium economy",
  business: "business",
  first: "first",
};

/**
 * Google Flights has no documented structured query API. The `?q=` natural-
 * language form reliably pre-fills origin/destination/date; passengers and
 * cabin are best-effort (Google parses the sentence). IATA codes work inside
 * the text.
 */
export const googleProvider: FlightProvider = {
  id: "google",
  name: "Google Flights",
  homepage: "https://www.google.com/travel/flights",
  capabilities: {
    returnDate: true,
    adults: true,
    children: true,
    infants: false,
    cabin: true,
    directOnly: true,
  },
  build(q: FlightSearchQuery): string {
    const parts = [`Flights from ${q.from} to ${q.to} on ${q.departDate}`];
    if (q.returnDate) parts.push(`returning ${q.returnDate}`);
    if (q.cabin !== "economy") parts.push(`${CABIN_TEXT[q.cabin]} class`);
    if (q.adults > 1) parts.push(`${q.adults} adults`);
    if (q.children > 0) parts.push(`${q.children} children`);
    if (q.directOnly) parts.push("nonstop");
    return `https://www.google.com/travel/flights?q=${encodeURIComponent(parts.join(" "))}`;
  },
};
