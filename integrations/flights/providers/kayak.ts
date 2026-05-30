import type { FlightProvider, FlightSearchQuery } from "../types.js";

/** Cabin → KAYAK path segment. Economy is the default and is omitted. */
const CABIN_SEG: Record<FlightSearchQuery["cabin"], string> = {
  economy: "",
  premiumeconomy: "premium",
  business: "business",
  first: "first",
};

/**
 * KAYAK encodes everything in the path: `/flights/{ORIG}-{DEST}/{out}[/{in}]`
 * with cabin and passenger count as trailing segments. Dates are `YYYY-MM-DD`,
 * codes uppercase. Direct-only via `?fs=stops=0`.
 */
export const kayakProvider: FlightProvider = {
  id: "kayak",
  name: "KAYAK",
  homepage: "https://www.kayak.com/flights",
  capabilities: {
    returnDate: true,
    adults: true,
    children: false,
    infants: false,
    cabin: true,
    directOnly: true,
  },
  build(q: FlightSearchQuery): string {
    const segs = [`${q.from}-${q.to}`, q.departDate];
    if (q.returnDate) segs.push(q.returnDate);
    const cabinSeg = CABIN_SEG[q.cabin];
    if (cabinSeg) segs.push(cabinSeg);
    if (q.adults > 1) segs.push(`${q.adults}adults`);

    const params = new URLSearchParams();
    params.set("sort", "bestflight_a");
    if (q.directOnly) params.set("fs", "stops=0");
    return `https://www.kayak.com/flights/${segs.join("/")}?${params.toString()}`;
  },
};
