import type { Itinerary, Leg, Mode, PlanData, PlanResponse } from "@motis-project/motis-client";

export type PlanQuery = NonNullable<PlanData["query"]>;
type RunPlan = (
  query: PlanQuery,
  signal?: AbortSignal,
) => Promise<{ data?: PlanResponse; error?: unknown; response?: { ok: boolean } }>;
const PREFIX = "omxmotis1.";
const LONG_DISTANCE = new Set(["HIGHSPEED_RAIL", "LONG_DISTANCE", "NIGHT_RAIL"]);
const LOCAL = new Set([
  "REGIONAL_RAIL",
  "SUBURBAN",
  "SUBWAY",
  "TRAM",
  "BUS",
  "FERRY",
  "FUNICULAR",
  "AERIAL_LIFT",
]);
const RAIL = [
  "HIGHSPEED_RAIL",
  "LONG_DISTANCE",
  "NIGHT_RAIL",
  "REGIONAL_RAIL",
  "SUBURBAN",
  "SUBWAY",
];
const TRANSIT = [
  "TRAM",
  "FERRY",
  "AIRPLANE",
  "BUS",
  "COACH",
  "RAIL",
  "ODM",
  "RIDE_SHARING",
  "FUNICULAR",
  "AERIAL_LIFT",
  "OTHER",
];
const aliases: Record<string, string> = {
  REGIONAL_FAST_RAIL: "REGIONAL_RAIL",
  METRO: "SUBWAY",
  AREAL_LIFT: "AERIAL_LIFT",
  CABLE_CAR: "AERIAL_LIFT",
};
export function expandedModes(modes?: readonly string[]): Set<string> {
  return new Set(
    (modes?.length ? modes : ["TRANSIT"])
      .flatMap((m) => (m === "TRANSIT" ? TRANSIT : [m]))
      .flatMap((m) => (m === "RAIL" ? RAIL : [aliases[m] ?? m])),
  );
}
export function regionalModes(modes?: readonly string[]): Mode[] | undefined {
  const expanded = expandedModes(modes);
  const local = [...expanded].filter((m) => LOCAL.has(m)).sort() as Mode[];
  return [...expanded].some((m) => LONG_DISTANCE.has(m)) && local.length ? local : undefined;
}
export const isTransit = (leg: Leg): boolean =>
  Boolean(leg.routeShortName || leg.routeLongName || leg.routeId);
export function isRegional(it: { legs: Leg[] }): boolean {
  const transit = it.legs.filter(isTransit);
  return transit.length > 0 && transit.every((l) => LOCAL.has(aliases[l.mode] ?? l.mode));
}
/** Identity describes the actual rides and street context, never their display names or opaque plan IDs. */
export function rawItineraryKey(it: Itinerary): string {
  return JSON.stringify(
    it.legs.map((l) => [
      l.mode,
      l.tripId,
      l.from.stopId ?? [l.from.lat, l.from.lon],
      l.to.stopId ?? [l.to.lat, l.to.lon],
      l.startTime,
      l.endTime,
      l.rental?.systemId,
    ]),
  );
}
interface Lane {
  previous?: string;
  next?: string;
}
interface Cursor {
  v: 1;
  i: string;
  e: string;
  d: "previous" | "next";
  p: Lane;
  r: Lane;
}
const laneState = (data: PlanResponse): Lane => ({
  previous: data.previousPageCursor || undefined,
  next: data.nextPageCursor || undefined,
});
function decode(cursor: string, instance: string, epoch: string): Cursor {
  if (cursor.length > 4096) throw new Error("Invalid MOTIS paging cursor");
  let c: Cursor;
  try {
    c = JSON.parse(Buffer.from(cursor.slice(PREFIX.length), "base64url").toString());
  } catch {
    throw new Error("Invalid MOTIS paging cursor");
  }
  const validLane = (l: Lane) =>
    l &&
    typeof l === "object" &&
    [l.previous, l.next].every(
      (v) => v === undefined || (typeof v === "string" && v.length > 0 && v.length <= 512),
    );
  if (
    !c ||
    c.v !== 1 ||
    c.i !== instance ||
    c.e !== epoch ||
    !["previous", "next"].includes(c.d) ||
    !validLane(c.p) ||
    !validLane(c.r) ||
    !(c.p[c.d] || c.r[c.d])
  )
    throw new Error("Invalid MOTIS paging cursor");
  return c;
}
function encode(state: Omit<Cursor, "d">, d: Cursor["d"]): string {
  return state.p[d] || state.r[d]
    ? PREFIX + Buffer.from(JSON.stringify({ ...state, d })).toString("base64url")
    : "";
}
function usable(
  result: Awaited<ReturnType<RunPlan>>,
): result is Awaited<ReturnType<RunPlan>> & { data: PlanResponse } {
  return (
    !result.error &&
    result.response?.ok !== false &&
    Array.isArray(result.data?.itineraries) &&
    result.data.itineraries.every(
      (it) =>
        it &&
        typeof it.startTime === "string" &&
        typeof it.endTime === "string" &&
        Array.isArray(it.legs) &&
        it.legs.length > 0 &&
        it.legs.every(
          (l) =>
            l &&
            typeof l.mode === "string" &&
            l.from &&
            l.to &&
            typeof l.startTime === "string" &&
            typeof l.endTime === "string" &&
            Number.isFinite(Date.parse(l.startTime)) &&
            Number.isFinite(Date.parse(l.endTime)),
        ),
    )
  );
}
/** Two bounded lanes share one provider and constraints but never upstream cursors. */
export async function diversifyPlan(
  query: PlanQuery,
  run: RunPlan,
  options: { enabled?: boolean; instance: string; epoch: string },
): Promise<{ data: PlanResponse; supplemented: boolean } | null> {
  const local = regionalModes(query.transitModes);
  const regionalQuery = { ...query, transitModes: local, directModes: undefined };
  const regional = (cursor?: string) =>
    run({ ...regionalQuery, pageCursor: cursor }, AbortSignal.timeout(4000));
  let primary: PlanResponse | undefined;
  let supplement: PlanResponse | undefined;
  let p: Lane = {},
    r: Lane = {};
  const composite = query.pageCursor?.startsWith(PREFIX);
  if (composite) {
    if (!options.enabled || !local) throw new Error("MOTIS paging request changed");
    const state = decode(query.pageCursor ?? "", options.instance, options.epoch);
    p = state.p;
    r = state.r;
    const [a, b] = await Promise.allSettled([
      p[state.d] ? run({ ...query, pageCursor: p[state.d] }) : Promise.resolve(null),
      r[state.d] ? regional(r[state.d]) : Promise.resolve(null),
    ]);
    if (a.status === "rejected") throw a.reason;
    if (a.value) {
      if (!usable(a.value)) throw new Error("MOTIS page unavailable");
      primary = a.value.data;
      p = laneState(primary);
    }
    if (b.status === "fulfilled" && b.value && usable(b.value)) {
      supplement = b.value.data;
      r = laneState(supplement);
    }
    if (!primary && !supplement) throw new Error("MOTIS page unavailable");
  } else {
    const initial = await run(query);
    if (!usable(initial)) return null;
    primary = initial.data;
    if (
      !options.enabled ||
      !local ||
      query.pageCursor ||
      !primary.itineraries.some((it) => it.legs.some((l) => LONG_DISTANCE.has(l.mode)))
    )
      return { data: primary, supplemented: false };
    p = laneState(primary);
    try {
      const answer = await regional();
      if (usable(answer)) {
        supplement = answer.data;
        r = laneState(supplement);
      }
    } catch {
      /* Optional diversification must not hide the primary journeys. */
    }
  }
  const seen = new Set<string>();
  const itineraries = [...(primary?.itineraries ?? []), ...(supplement?.itineraries ?? [])]
    .filter((it) => {
      const key = rawItineraryKey(it);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.startTime.localeCompare(b.startTime) || a.endTime.localeCompare(b.endTime));
  const state = { v: 1 as const, i: options.instance, e: options.epoch, p, r };
  return {
    supplemented: true,
    data: {
      ...(primary ?? (supplement as PlanResponse)),
      itineraries,
      direct: primary?.direct ?? [],
      previousPageCursor: encode(state, "previous"),
      nextPageCursor: encode(state, "next"),
    },
  };
}
