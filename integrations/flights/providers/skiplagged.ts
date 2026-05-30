import type { FlightProvider, FlightSearchQuery } from "../types.js";

/**
 * Skiplagged — hidden-city / "skiplagging" search. Consumer path is
 * `/flights/{ORIG}/{DEST}/{out}[/{in}]/`, IATA codes uppercase, dates
 * `YYYY-MM-DD`. The product is one-way / single-traveller oriented, so it has
 * no passenger or cabin parameters.
 */
export const skiplaggedProvider: FlightProvider = {
  id: "skiplagged",
  name: "Skiplagged",
  homepage: "https://skiplagged.com/",
  capabilities: {
    returnDate: true,
    adults: false,
    children: false,
    infants: false,
    cabin: false,
    directOnly: false,
  },
  build(q: FlightSearchQuery): string {
    const segs = [q.from, q.to, q.departDate];
    if (q.returnDate) segs.push(q.returnDate);
    return `https://skiplagged.com/flights/${segs.join("/")}/`;
  },
};
