import type { CabinClass, FlightSearchQuery } from "./types.js";

const IATA_RE = /^[A-Za-z]{3}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CABINS = new Set<CabinClass>(["economy", "premiumeconomy", "business", "first"]);

const MAX_PAX = 9;

function clampInt(raw: string | undefined, min: number, max: number, fallback: number): number {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function isTrue(raw: string | undefined): boolean {
  return raw === "1" || raw === "true";
}

export type ParseResult = { ok: true; query: FlightSearchQuery } | { ok: false; error: string };

/**
 * Validate and normalise the raw query string of `/:provider/open` (and
 * `/url`) into a {@link FlightSearchQuery}. Codes are uppercased; passenger
 * counts are clamped to [0..9] with at least 1 adult.
 */
export function parseFlightQuery(q: Record<string, string>): ParseResult {
  const from = (q.from ?? "").trim();
  const to = (q.to ?? "").trim();
  if (!IATA_RE.test(from) || !IATA_RE.test(to)) {
    return { ok: false, error: "'from' and 'to' must be 3-letter IATA airport codes" };
  }
  if (from.toUpperCase() === to.toUpperCase()) {
    return { ok: false, error: "'from' and 'to' must differ" };
  }

  const departDate = (q.depart ?? "").trim();
  if (!DATE_RE.test(departDate)) {
    return { ok: false, error: "'depart' must be a YYYY-MM-DD date" };
  }
  const returnRaw = (q.return ?? "").trim();
  if (returnRaw && !DATE_RE.test(returnRaw)) {
    return { ok: false, error: "'return' must be a YYYY-MM-DD date" };
  }

  const cabinRaw = (q.cabin ?? "economy").toLowerCase() as CabinClass;
  const cabin: CabinClass = CABINS.has(cabinRaw) ? cabinRaw : "economy";

  return {
    ok: true,
    query: {
      from: from.toUpperCase(),
      to: to.toUpperCase(),
      departDate,
      returnDate: returnRaw || undefined,
      adults: clampInt(q.adults, 1, MAX_PAX, 1),
      children: clampInt(q.children, 0, MAX_PAX, 0),
      infants: clampInt(q.infants, 0, MAX_PAX, 0),
      cabin,
      directOnly: isTrue(q.direct),
    },
  };
}
