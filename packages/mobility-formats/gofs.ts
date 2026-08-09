/**
 * GOFS 1.0 — the General On-Demand Feed Specification, MobilityData's open
 * standard for demand-responsive transport (ridehail, taxi, microtransit,
 * paratransit). Field names below are verbatim from the specification.
 *
 * Everything here is pure: it parses and computes over values a caller has
 * already fetched. All I/O lives in the consuming integration.
 *
 * Where `reference.md`'s prose and `schema/*.json` disagree, the schema and
 * the observed behaviour of live feeds win — see the notes on each helper.
 */

export interface GofsFeedReference {
  name: string;
  url: string;
}

/** Common envelope every GOFS file shares. */
export interface GofsEnvelope<T> {
  last_updated: string | number;
  ttl: number;
  version: string;
  data: T;
}

export interface GofsSystemInformation {
  language: string;
  timezone: string;
  name: string;
  short_name?: string;
  operator?: string;
  url?: string;
  subscribe_url?: string;
  start_date?: string;
  phone_number?: string;
  email?: string;
  feed_contact_email?: string;
}

export interface GofsServiceBrand {
  brand_id: string;
  brand_name: string;
  brand_color?: string;
  brand_text_color?: string;
}

export interface GofsVehicleType {
  vehicle_type_id: string;
  max_capacity?: number;
  /** `boarding_accessible` | `boarding_inaccessible` in the feeds seen so far. */
  wheelchair_boarding?: string;
}

export interface GofsZoneFeature {
  type: "Feature";
  zone_id: string;
  properties?: { name?: string };
  geometry: { type: "Polygon"; coordinates: number[][][] };
}

export interface GofsZones {
  zones: { type: "FeatureCollection"; features: GofsZoneFeature[] };
}

export interface GofsOperatingRule {
  from_zone_id: string;
  to_zone_id: string;
  start_pickup_window?: string;
  end_pickup_window?: string;
  end_dropoff_window?: string;
  calendars: string[];
  brand_id?: string;
  vehicle_type_id?: string[];
  fare_id?: string;
}

export interface GofsCalendar {
  calendar_id: string;
  days?: string[];
  start_date: string;
  end_date: string;
  excepted_dates?: string[];
}

/** One tier of a GOFS fare component. */
export interface GofsFareTier {
  interval?: number;
  start?: number;
  end?: number;
  amount?: number;
}

export interface GofsFare {
  fare_id: string;
  currency: string;
  kilometer?: GofsFareTier[];
  minute?: GofsFareTier[];
  active_minute?: GofsFareTier[];
  idle_minute?: GofsFareTier[];
  rider?: GofsFareTier[];
  luggage?: GofsFareTier[];
}

export interface GofsBookingRule {
  from_zone_ids: string[];
  to_zone_ids?: string[];
  booking_type: 0 | 1 | 2;
  prior_notice_duration_min?: number;
  prior_notice_duration_max?: number;
  message?: string;
  info_url?: string;
  booking_url?: string;
  phone_number?: string;
}

export interface GofsBookingDetail {
  service_name?: string;
  android_uri?: string;
  ios_uri?: string;
  web_uri?: string;
  phone_number?: string;
}

export interface GofsRealtimeBookingEntry {
  brand_id: string;
  wait_time: number;
  travel_time?: number;
  travel_cost?: number;
  travel_cost_currency?: string;
  booking_detail?: GofsBookingDetail;
}

/**
 * A wait-time entry. The spec scopes these by `brand_id`; the live Freebee
 * feed scopes them by zone pair instead, with no brand. `brand_id` is null for
 * the zone-scoped form.
 */
export interface GofsWaitTimeEntry {
  brand_id: string | null;
  wait_time: number;
  from_zone_ids?: string[];
  to_zone_ids?: string[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const LANGUAGE_KEY_RE = /^[a-z]{2,3}(-[A-Z]{2})?$/;

function feedsFromContainer(container: unknown): GofsFeedReference[] {
  if (!isObject(container) || !Array.isArray(container.feeds)) return [];
  return container.feeds
    .filter(isObject)
    .map((feed) => ({
      name: typeof feed.name === "string" ? feed.name : "",
      url: typeof feed.url === "string" ? feed.url : "",
    }))
    .filter((feed) => feed.name.length > 0 && feed.url.length > 0);
}

/**
 * Collect every usable feed reference from a discovery document.
 *
 * `schema/gofs.json` makes the BCP-47 language container mandatory
 * (`data.en.feeds`), and the live Freebee feed uses it — but `reference.md`'s
 * prose shows a flat `data.feeds`, so a producer may have followed that
 * instead. Both are accepted. References missing a name or url are dropped
 * rather than surfaced as broken entries the caller would have to re-validate.
 */
export function parseGofsDiscovery(doc: unknown, language = "en"): GofsFeedReference[] {
  if (!isObject(doc) || !isObject(doc.data)) return [];

  const flat = feedsFromContainer(doc.data);
  if (flat.length > 0) return flat;

  const languages = Object.keys(doc.data).filter((key) => LANGUAGE_KEY_RE.test(key));
  const preferred =
    languages.find((key) => key === language) ??
    languages.find((key) => key.split("-")[0] === language.split("-")[0]) ??
    languages[0];

  return preferred ? feedsFromContainer(doc.data[preferred]) : [];
}

/**
 * The feed-name enum in `schema/gofs.json` carries both `wait_time` and
 * `wait_times` for the same endpoint (the file name is `wait_time`, the
 * response key is `wait_times`, and the live feed publishes it under the
 * plural). Look up either and get the same answer.
 */
const FEED_NAME_ALIASES: Record<string, string[]> = {
  wait_time: ["wait_time", "wait_times"],
  wait_times: ["wait_times", "wait_time"],
};

export function gofsFeedUrl(feeds: GofsFeedReference[], name: string): string | null {
  for (const candidate of FEED_NAME_ALIASES[name] ?? [name]) {
    const match = feeds.find((f) => f.name === candidate);
    if (match) return match.url;
  }
  return null;
}

/**
 * Ray-casting point-in-polygon over a single GeoJSON ring. Points exactly on
 * an edge count as inside — a rider standing on a service-area boundary
 * should not be told the service does not reach them.
 */
function pointInRing(ring: number[][], [x, y]: [number, number]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];

    const onSegment =
      Math.abs((xj - xi) * (y - yi) - (x - xi) * (yj - yi)) < 1e-12 &&
      x >= Math.min(xi, xj) - 1e-12 &&
      x <= Math.max(xi, xj) + 1e-12 &&
      y >= Math.min(yi, yj) - 1e-12 &&
      y <= Math.max(yi, yj) + 1e-12;
    if (onSegment) return true;

    const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/**
 * Zone ids whose polygon contains `point` ([lng, lat]). The first ring of a
 * GOFS polygon is its outer boundary; subsequent rings are holes.
 */
export function gofsZonesContaining(
  features: GofsZoneFeature[],
  point: [number, number],
): string[] {
  const matched: string[] = [];
  for (const feature of features) {
    const [outer, ...holes] = feature.geometry?.coordinates ?? [];
    if (!outer || !pointInRing(outer, point)) continue;
    if (holes.some((hole) => pointInRing(hole, point))) continue;
    matched.push(feature.zone_id);
  }
  return matched;
}

const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

/**
 * Normalise a GOFS date to `YYYY-MM-DD`. The schema types calendar dates as a
 * bare string with no format, and the live Freebee feed sends GTFS-style
 * `YYYYMMDD` while the prose reference shows `YYYY-MM-DD`. Both occur.
 */
function normalizeDate(value: string): string {
  const compact = value.match(/^(\d{4})(\d{2})(\d{2})$/);
  return compact ? `${compact[1]}-${compact[2]}-${compact[3]}` : value;
}

/**
 * Normalise a GOFS clock time to `HH:MM:SS`. Feeds send `HH:MM:SS`
 * (Freebee) or `HH:MM` (the prose reference); padding to seconds makes the
 * lexical comparisons below correct for both, so a pickup exactly at the start
 * of a window is not excluded by a shorter string sorting first.
 */
function normalizeTime(value: string): string {
  const parts = value.split(":");
  const [h = "00", m = "00", s = "00"] = parts;
  return `${h.padStart(2, "0")}:${m.padStart(2, "0")}:${s.padStart(2, "0")}`;
}

/**
 * Whether a calendar covers `date`. The weekday is derived in UTC — GOFS
 * calendar dates are service dates in the system's own timezone, and the
 * caller is responsible for having converted to that timezone first.
 */
export function gofsCalendarActive(calendar: GofsCalendar, date: string): boolean {
  const day = normalizeDate(date);
  if (day < normalizeDate(calendar.start_date) || day > normalizeDate(calendar.end_date)) {
    return false;
  }
  if (calendar.excepted_dates?.some((d) => normalizeDate(d) === day)) return false;
  if (!calendar.days || calendar.days.length === 0) return true;
  const weekday = DAY_KEYS[new Date(`${day}T00:00:00Z`).getUTCDay()];
  return calendar.days.some((d) => d.toLowerCase().startsWith(weekday));
}

/**
 * Whether `time` falls inside a pickup window. A window whose end is before its
 * start wraps past midnight (22:00–05:00), which GOFS uses for night services.
 */
function withinWindow(time: string, start: string | undefined, end: string | undefined): boolean {
  if (!start || !end) return true;
  const t = normalizeTime(time);
  const from = normalizeTime(start);
  const to = normalizeTime(end);
  if (from <= to) return t >= from && t <= to;
  return t >= from || t <= to;
}

export interface GofsRuleMatch {
  rules: GofsOperatingRule[];
  calendars: GofsCalendar[];
  fromZoneIds: string[];
  /** Null when the dropoff is unknown — then every destination zone matches. */
  toZoneIds: string[] | null;
  /** Wall-clock `YYYY-MM-DDTHH:mm` in the feed's own timezone. */
  at: string;
}

/**
 * Operating rules serving a zone pair at a given local wall-clock time. The
 * caller converts to the feed's timezone before calling; this function does no
 * timezone maths of its own.
 */
export function gofsMatchingRules(match: GofsRuleMatch): GofsOperatingRule[] {
  const [date, time = "00:00"] = match.at.split("T");
  const activeCalendars = new Set(
    match.calendars.filter((c) => gofsCalendarActive(c, date)).map((c) => c.calendar_id),
  );
  const from = new Set(match.fromZoneIds);
  const to = match.toZoneIds === null ? null : new Set(match.toZoneIds);

  return match.rules.filter((rule) => {
    if (!from.has(rule.from_zone_id)) return false;
    if (to !== null && !to.has(rule.to_zone_id)) return false;
    if (!rule.calendars.some((id) => activeCalendars.has(id))) return false;
    return withinWindow(time, rule.start_pickup_window, rule.end_pickup_window);
  });
}

export interface GofsTripMeasures {
  kilometers: number;
  minutes: number;
  riders?: number;
  luggage?: number;
}

/**
 * Charge for one fare component. A tier with `start`/`end` prices the portion
 * of `quantity` that falls inside that band; `amount` is the price per unit of
 * the parent key (per km, per minute, per rider, per bag).
 *
 * `interval` is the granularity at which that price is actually levied, and it
 * rounds up: the spec's own worked example is "the first 10 kilometers cost
 * 3.30 CAD per kilometer, and are charged every 250 meters", i.e.
 * `{interval: 0.25, end: 10, amount: 3.30}`. Ignoring it undercharges every
 * trip that does not land exactly on an interval boundary. A tier with no
 * `interval` is charged continuously.
 */
function tierCharge(tiers: GofsFareTier[] | undefined, quantity: number): number | null {
  if (!tiers || tiers.length === 0) return null;
  let total = 0;
  let priced = false;
  for (const tier of tiers) {
    if (tier.amount === undefined) continue;
    priced = true;
    const start = tier.start ?? 0;
    const end = tier.end ?? Number.POSITIVE_INFINITY;
    const covered = Math.max(0, Math.min(quantity, end) - start);
    if (covered === 0) continue;
    const billable =
      tier.interval && tier.interval > 0
        ? Math.ceil(covered / tier.interval) * tier.interval
        : covered;
    total += billable * tier.amount;
  }
  return priced ? total : null;
}

/**
 * Estimate a fare from a static GOFS tariff and the trip's measured distance
 * and duration. Returns null when the tariff prices nothing, so the caller can
 * show an ETA without inventing a price. `minute` and `active_minute` are
 * treated as the same in-vehicle time; `idle_minute` is not modelled, because
 * nothing in a pre-trip estimate knows how long the vehicle will wait.
 */
export function gofsEstimateFare(fare: GofsFare, trip: GofsTripMeasures): number | null {
  const parts = [
    tierCharge(fare.rider, trip.riders ?? 1),
    tierCharge(fare.kilometer, trip.kilometers),
    tierCharge(fare.minute ?? fare.active_minute, trip.minutes),
    trip.luggage ? tierCharge(fare.luggage, trip.luggage) : null,
  ].filter((v): v is number => v !== null);

  if (parts.length === 0) return null;
  return parts.reduce((sum, v) => sum + v, 0);
}

function isBookingDetail(value: unknown): value is GofsBookingDetail {
  return isObject(value);
}

/**
 * Normalise a `realtime_booking` response. Entries missing a brand id or a
 * numeric wait time are dropped — they cannot be rendered as a quote, and
 * silently showing a brand with no ETA would be worse than omitting it.
 */
export function parseGofsRealtimeBooking(doc: unknown): GofsRealtimeBookingEntry[] {
  if (!isObject(doc) || !isObject(doc.data) || !Array.isArray(doc.data.realtime_booking)) return [];
  return doc.data.realtime_booking.filter(isObject).flatMap((entry) => {
    if (typeof entry.brand_id !== "string" || typeof entry.wait_time !== "number") return [];
    return [
      {
        brand_id: entry.brand_id,
        wait_time: entry.wait_time,
        travel_time: typeof entry.travel_time === "number" ? entry.travel_time : undefined,
        travel_cost: typeof entry.travel_cost === "number" ? entry.travel_cost : undefined,
        travel_cost_currency:
          typeof entry.travel_cost_currency === "string" ? entry.travel_cost_currency : undefined,
        booking_detail: isBookingDetail(entry.booking_detail) ? entry.booking_detail : undefined,
      },
    ];
  });
}

/**
 * Normalise a `wait_time` response.
 *
 * The spec documents one entry per `brand_id`, but the live Freebee feed
 * returns one entry per zone pair (`from_zone_ids` / `to_zone_ids`) with no
 * brand at all. Both are parsed: a zone-scoped entry carries `brand_id: null`,
 * and the caller applies it to every brand serving that zone pair.
 */
export function parseGofsWaitTimes(doc: unknown): GofsWaitTimeEntry[] {
  if (!isObject(doc) || !isObject(doc.data) || !Array.isArray(doc.data.wait_times)) return [];
  return doc.data.wait_times.filter(isObject).flatMap((entry) => {
    if (typeof entry.wait_time !== "number") return [];
    const fromZoneIds = Array.isArray(entry.from_zone_ids)
      ? entry.from_zone_ids.filter((z): z is string => typeof z === "string")
      : undefined;
    const toZoneIds = Array.isArray(entry.to_zone_ids)
      ? entry.to_zone_ids.filter((z): z is string => typeof z === "string")
      : undefined;
    if (typeof entry.brand_id !== "string" && !fromZoneIds?.length) return [];
    return [
      {
        brand_id: typeof entry.brand_id === "string" ? entry.brand_id : null,
        wait_time: entry.wait_time,
        from_zone_ids: fromZoneIds,
        to_zone_ids: toZoneIds,
      },
    ];
  });
}

/**
 * Resolve the wait time that applies to one brand in one zone pair. A
 * brand-scoped entry wins; otherwise the first zone-scoped entry covering the
 * pair applies. Returns null when nothing covers it.
 */
export function gofsWaitTimeFor(
  entries: GofsWaitTimeEntry[],
  brandId: string,
  fromZoneIds: string[],
  toZoneIds: string[] | null,
): number | null {
  const byBrand = entries.find((e) => e.brand_id === brandId);
  if (byBrand) return byBrand.wait_time;

  const zoneScoped = entries.find((e) => {
    if (e.brand_id !== null) return false;
    if (!e.from_zone_ids?.some((z) => fromZoneIds.includes(z))) return false;
    if (toZoneIds === null || !e.to_zone_ids?.length) return true;
    return e.to_zone_ids.some((z) => toZoneIds.includes(z));
  });
  return zoneScoped?.wait_time ?? null;
}
