import type { FlightProvider, FlightSearchQuery } from "../types.js";

/** Cabin → momondo path segment. Economy is the default and is omitted. */
const CABIN_SEG: Record<FlightSearchQuery["cabin"], string> = {
  economy: "",
  premiumeconomy: "premium",
  business: "business",
  first: "first",
};

/**
 * momondo (Booking Holdings, same URL family as KAYAK):
 * `/flight-search/{ORIG}-{DEST}/{out}[/{in}]` with cabin/passenger trailing
 * segments. Dates `YYYY-MM-DD`, codes uppercase.
 */
export const momondoProvider: FlightProvider = {
  id: "momondo",
  name: "momondo",
  homepage: "https://www.momondo.com/",
  capabilities: {
    returnDate: true,
    adults: true,
    children: false,
    infants: false,
    cabin: true,
    directOnly: false,
  },
  build(q: FlightSearchQuery): string {
    const segs = [`${q.from}-${q.to}`, q.departDate];
    if (q.returnDate) segs.push(q.returnDate);
    const cabinSeg = CABIN_SEG[q.cabin];
    if (cabinSeg) segs.push(cabinSeg);
    if (q.adults > 1) segs.push(`${q.adults}adults`);
    return `https://www.momondo.com/flight-search/${segs.join("/")}`;
  },
};
