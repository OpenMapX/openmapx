import {
  bearingBetween,
  escapeHtml,
  haversineDistance,
  type LngLat,
  localizedTextFor,
  type RoadConditionEvent,
} from "@openmapx/core";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import type { MapGeoJSONFeature } from "maplibre-gl";
import {
  buildPopupCreditsHtml,
  type PopupCreditsOptions,
} from "@/integration-api/map/popupCredits";
import { roadConditionAttributions } from "./attributions";
import { impactLines } from "./effects";
import { isUnconfirmedCrowd } from "./evidence";
import { GLYPHS, markerGlyph } from "./markers";
import { mostSevereEvent, SEVERITY_COLORS, SEVERITY_RANK } from "./severity";
import type { RoadConditionTranslate } from "./types";
import { isFutureRoadCondition } from "./visual-style";

export type { RoadConditionTranslate } from "./types";

export interface RoadConditionPopupInput {
  hits: MapGeoJSONFeature[];
  fallbackCoordinates: [number, number];
  eventsByDisplayId: ReadonlyMap<string, RoadConditionEvent[]>;
  formatDateTime: (value: string | number | Date) => string;
  formatDate: (value: string | number | Date) => string;
  /** The viewer's credit wording, as panel credit strips use it. */
  creditOptions?: PopupCreditsOptions;
  /** "3 hours ago"; without it the card names the update's date and time. */
  formatRelative?: (value: string | number | Date) => string;
  translate: RoadConditionTranslate;
  /** The UI locale: picks each situation's text in the reader's language. */
  locale: string;
  /** Refresh last-good context without presenting it as current. */
  needsRefresh?: boolean;
  /** The instant effects and expiry are evaluated at; default now. */
  atMs?: number;
}

export interface RoadConditionPopupContent {
  html: string;
  coordinates: [number, number];
  groupCount: number;
}

/**
 * What a card shows a driver about one condition: what it is, where, when,
 * what it does to traffic and who reported it. Every field is plain text,
 * escaped only when the card is rendered.
 */
export interface IncidentCard {
  severity: RoadConditionEvent["severity"]["label"];
  glyph: string;
  future: boolean;
  title: string;
  /** The roads and the direction affected. */
  where?: string;
  /** "Minor impact"; absent where the source states no severity. */
  impact?: string;
  unconfirmed?: string;
  when?: string;
  impacts: string[];
  /** The source's own headline, where it says more than the title. */
  headline?: string;
  description?: string;
  warning?: string;
  /** The captured credit of every source shown, as the map credits receive them. */
  credits: Attribution[];
  updated?: string;
}

/** Registry kinds and types with a label in the catalog; anything else is humanized. */
const KNOWN_KINDS = new Set([
  "incident",
  "roadworks",
  "closure",
  "restriction",
  "weather_condition",
  "road_condition",
  "road_hazard",
  "public_event",
  "authority",
  "equipment_fault",
  "security",
  "winter_operation",
  "pass_status",
  "congestion",
  "other",
]);

const KNOWN_TYPES = new Set([
  "accident",
  "breakdown",
  "vehicle_hazard",
  "obstruction",
  "fire",
  "works",
  "closure",
  "dimension",
  "access",
  "speed",
  "seasonal_load",
  "weather",
  "surface",
  "driving_condition",
  "hazard",
  "event",
  "operation",
  "fault",
  "incident",
  "chain_control",
  "pass",
  "congestion",
  "other",
]);

const DIRECTION_VALUES = new Set(["positive", "negative", "both", "unknown"]);
const DIRECTION_LOOPS = new Set(["inner", "outer"]);
/** The eight compass points, clockwise from north, 45° apart. */
const COMPASS_ORDER = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;
const COMPASS_POINTS = new Set<string>(COMPASS_ORDER);
/** Lifecycles a card names in place of a time, as no time of them holds now. */
const NOT_RUNNING_STATUSES = new Set(["suspended", "ended", "cancelled"]);
const SCHEDULE_WEEKDAY_CODES = new Set(["MO", "TU", "WE", "TH", "FR", "SA", "SU"]);
/** Severities light enough to carry a dark glyph on their disc. */
const LIGHT_SEVERITIES = new Set(["minor", "moderate"]);

function humanizeToken(raw: string): string {
  const value = raw.replace(/[_-]+/g, " ").trim();
  return value.length === 0 ? value : value.charAt(0).toUpperCase() + value.slice(1);
}

/** A situation's label: its type's, else its kind's, else the token. */
function classificationLabel(
  event: Pick<RoadConditionEvent, "kind" | "type">,
  translate: RoadConditionTranslate,
): string {
  if (KNOWN_TYPES.has(event.type)) return translate(`type.${event.type}`);
  if (KNOWN_KINDS.has(event.kind)) return translate(`kind.${event.kind}`);
  return humanizeToken(event.type || event.kind);
}

function scheduleDayLabel(day: string, translate: RoadConditionTranslate): string {
  const code = day.trim().toUpperCase();
  return SCHEDULE_WEEKDAY_CODES.has(code) ? translate(`schedule.days.${code}`) : day.trim();
}

/** Recurring windows ("Mon, Wed, 22:00–06:00, 6 Aug – 14 Aug"), or "" for none. */
function scheduleText(
  validity: RoadConditionEvent["validity"],
  input: RoadConditionPopupInput,
): string {
  const hhmm = (time?: string) => (time ? time.slice(0, 5) : "");
  return (validity.periods ?? [])
    .map((window) => {
      const days =
        window.byDay && window.byDay.length > 0
          ? window.byDay
              .map((day) => scheduleDayLabel(day, input.translate))
              .filter(Boolean)
              .join(", ")
          : "";
      const band =
        window.startTime && window.endTime
          ? `${hhmm(window.startTime)}–${hhmm(window.endTime)}`
          : window.startTime
            ? `${input.translate("schedule.from")} ${hhmm(window.startTime)}`
            : "";
      const range =
        window.startDate && window.endDate && window.startDate !== window.endDate
          ? `${input.formatDate(window.startDate)} – ${input.formatDate(window.endDate)}`
          : window.startDate
            ? input.formatDate(window.startDate)
            : "";
      return [days, band, range].filter(Boolean).join(", ");
    })
    .filter(Boolean)
    .join("; ");
}

/**
 * An instant as a driver reads it: the date alone where the time only marks
 * the start or end of a day, else the date and time.
 */
function instantText(value: string, edge: "start" | "end", input: RoadConditionPopupInput): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const minutes = date.getHours() * 60 + date.getMinutes();
  const dayEdge = edge === "start" ? minutes === 0 : minutes === 23 * 60 + 59;
  return dayEdge ? input.formatDate(value) : input.formatDateTime(value);
}

/**
 * When the situation holds, in one line: until when it runs, when it starts
 * or the windows it recurs in. A situation that is suspended, over or
 * cancelled says that instead.
 */
export function whenText(
  validity: RoadConditionEvent["validity"],
  future: boolean,
  input: RoadConditionPopupInput,
): string | undefined {
  const { translate } = input;
  if (NOT_RUNNING_STATUSES.has(validity.status)) {
    return translate(`validityStatus.${validity.status}`);
  }
  const schedule = scheduleText(validity, input);
  if (schedule) return schedule;
  const start = validity.start ? instantText(validity.start, "start", input) : undefined;
  const end = validity.end ? instantText(validity.end, "end", input) : undefined;
  const estimatedEnd = validity.estimatedEnd
    ? instantText(validity.estimatedEnd, "end", input)
    : undefined;
  if (future && start) {
    return end || estimatedEnd
      ? translate("when.range", { start, end: (end ?? estimatedEnd) as string })
      : translate("when.starts", { date: start });
  }
  if (end) return translate("when.until", { date: end });
  if (estimatedEnd) return translate("when.expectedUntil", { date: estimatedEnd });
  if (start) return translate("when.since", { date: start });
  return undefined;
}

function distinctNonEmpty(values: unknown[]): string[] {
  return [
    ...new Set(
      values
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
}

/** The roads of situations as one line: refs, else names in the reader's language. */
export function roadNamesForEvents(
  events: RoadConditionEvent[],
  locale: string,
): string | undefined {
  const names = distinctNonEmpty(
    events.flatMap((event) =>
      (event.roads ?? []).map((road) => road.ref ?? localizedTextFor(road.name, locale)),
    ),
  );
  return names.length > 0 ? names.join(", ") : undefined;
}

/** The eight-point compass direction of a bearing in degrees. */
function compassOf(bearingDeg: number): string {
  return COMPASS_ORDER[Math.round((((bearingDeg % 360) + 360) % 360) / 45) % 8] as string;
}

/**
 * The straight line from a heading's start to its end must cover at least
 * this share of the path's length for that heading to describe the path: a
 * loop or a U-shaped road runs every way, and its ends say nothing of that.
 */
const MIN_CHORD_SHARE = 0.5;

/**
 * The ends of a location's line, first coordinate to last, when the heading
 * between them describes the line: a single path, its parts joined end to
 * start, whose ends lie well apart along it. Undefined otherwise.
 */
function lineEnds(geometry: RoadConditionEvent["geometry"]): [LngLat, LngLat] | undefined {
  const lines =
    geometry.type === "LineString"
      ? [geometry.coordinates]
      : geometry.type === "MultiLineString"
        ? geometry.coordinates
        : [];
  const path: LngLat[] = [];
  for (const line of lines) {
    const points = line.map((p) => [p[0], p[1]] as LngLat);
    const head = points[0];
    const tail = path[path.length - 1];
    if (!head) continue;
    // Parts that do not join end to start are no one path to take a heading of.
    if (tail && (tail[0] !== head[0] || tail[1] !== head[1])) return undefined;
    path.push(...(tail ? points.slice(1) : points));
  }
  const first = path[0];
  const last = path[path.length - 1];
  if (!first || !last || path.length < 2) return undefined;
  let length = 0;
  for (let i = 1; i < path.length; i++) {
    length += haversineDistance(path[i - 1] as LngLat, path[i] as LngLat);
  }
  const chord = haversineDistance(first, last);
  return length > 0 && chord / length >= MIN_CHORD_SHARE ? [first, last] : undefined;
}

/**
 * The way a situation affects, as a driver reads it: the ring-road loop and
 * either both directions, the place it leads to, the source's own words for
 * it, or its compass heading. A direction stated only against a reference
 * axis the reader cannot see says nothing to them and is left out; a value
 * this host does not know reads as its humanized token.
 */
export function directionText(
  direction: RoadConditionEvent["direction"],
  geometry: RoadConditionEvent["geometry"] | undefined,
  translate: RoadConditionTranslate,
): string | undefined {
  if (!direction) return undefined;
  const loop =
    direction.loop === undefined
      ? undefined
      : DIRECTION_LOOPS.has(direction.loop)
        ? translate(`direction.loop.${direction.loop}`)
        : humanizeToken(direction.loop);
  let heading: string | undefined;
  if (direction.compass && COMPASS_POINTS.has(direction.compass)) heading = direction.compass;
  else if (direction.bearingDeg !== undefined) heading = compassOf(direction.bearingDeg);
  else if (
    direction.basis === "geometry" &&
    (direction.value === "positive" || direction.value === "negative")
  ) {
    const ends = geometry ? lineEnds(geometry) : undefined;
    if (ends) {
      const [from, to] = direction.value === "positive" ? ends : [ends[1], ends[0]];
      heading = compassOf(bearingBetween(from, to));
    }
  }
  const way =
    direction.value === "both"
      ? translate("direction.both")
      : direction.toward
        ? translate("direction.toward", { place: direction.toward })
        : direction.text ||
          (heading ? translate(`direction.compass.${heading}`) : undefined) ||
          (direction.compass && !COMPASS_POINTS.has(direction.compass)
            ? direction.compass
            : undefined) ||
          (DIRECTION_VALUES.has(direction.value) ? undefined : humanizeToken(direction.value));
  const parts = [loop, way].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

function sameAcross(events: RoadConditionEvent[], field: keyof RoadConditionEvent): boolean {
  const first = JSON.stringify(events[0]?.[field]);
  return events.every((event) => JSON.stringify(event[field]) === first);
}

/**
 * The time a group of records spans: theirs where they agree, else from the
 * earliest start to the latest end, where every record names both.
 */
function groupValidity(
  events: RoadConditionEvent[],
  representative: RoadConditionEvent,
): RoadConditionEvent["validity"] {
  if (sameAcross(events, "validity")) return representative.validity;
  const starts = events.map((event) => Date.parse(event.validity.start ?? ""));
  const ends = events.map((event) => Date.parse(event.validity.end ?? ""));
  if (![...starts, ...ends].every(Number.isFinite)) return representative.validity;
  return {
    status: representative.validity.status,
    start: new Date(Math.min(...starts)).toISOString(),
    end: new Date(Math.max(...ends)).toISOString(),
  };
}

function latest(values: (string | undefined)[]): string | undefined {
  const times = values.map((value) => Date.parse(value ?? "")).filter(Number.isFinite);
  return times.length > 0 ? new Date(Math.max(...times)).toISOString() : undefined;
}

/**
 * One card for a display group: records of the same situation, perhaps from
 * several sources, read as one condition. The most severe record names it;
 * every record's impacts and credit are kept.
 */
export function buildIncidentCard(
  events: RoadConditionEvent[],
  input: RoadConditionPopupInput,
  atMs: number,
): IncidentCard | undefined {
  if (events.length === 0) return undefined;
  const { translate } = input;
  const representative = mostSevereEvent(events);
  const future = events.every((event) => isFutureRoadCondition(event, atMs));
  const title = classificationLabel(representative, translate);
  const roads = roadNamesForEvents(events, input.locale);
  const direction = sameAcross(events, "direction")
    ? directionText(representative.direction, representative.geometry, translate)
    : undefined;
  const severity = representative.severity.label;
  const headline = localizedTextFor(representative.headline, input.locale)?.trim();
  const description = localizedTextFor(representative.description, input.locale)?.trim();
  const at = new Date(atMs);
  const impacts = [
    ...new Set(
      events.flatMap((event) =>
        impactLines(event, {
          translate,
          locale: input.locale,
          at,
          formatDateTime: (value) => instantText(value, "start", input),
        }),
      ),
    ),
  ];
  const expired = events.some((event) => {
    const expiresAt = Date.parse(event.expiresAt ?? "");
    return Number.isFinite(expiresAt) && expiresAt <= atMs;
  });
  const updatedAt = latest(events.map((event) => event.updatedAt));
  const formatUpdated = input.formatRelative ?? input.formatDateTime;
  const sameText = (a?: string, b?: string) =>
    Boolean(a && b && a.toLocaleLowerCase() === b.toLocaleLowerCase());
  return {
    severity,
    glyph: markerGlyph(representative),
    future,
    title,
    ...(roads || direction ? { where: [roads, direction].filter(Boolean).join(" · ") } : {}),
    ...(severity !== "unknown" ? { impact: translate(`impactLevel.${severity}`) } : {}),
    ...(events.every(isUnconfirmedCrowd) ? { unconfirmed: translate("report.unconfirmed") } : {}),
    when: whenText(groupValidity(events, representative), future, input),
    impacts,
    ...(headline && !sameText(headline, title) && !sameText(headline, description)
      ? { headline }
      : {}),
    ...(description ? { description } : {}),
    ...(input.needsRefresh
      ? { warning: translate("freshness.needsRefresh") }
      : expired
        ? { warning: translate("freshness.stale") }
        : {}),
    credits: roadConditionAttributions(events),
    ...(updatedAt
      ? { updated: translate("panel.updated", { time: formatUpdated(updatedAt) }) }
      : {}),
  };
}

function glyphSvg(glyph: string): string {
  const path = GLYPHS[glyph] ?? GLYPHS.other;
  return `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><path fill="currentColor" d="${escapeHtml(path ?? "")}"/></svg>`;
}

const CLOCK_ICON =
  '<svg class="omx-incident__when-icon" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false"><path fill="currentColor" d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2M12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8m.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/></svg>';

/**
 * A card as HTML, every source-supplied text escaped. Its credits read and
 * link as in panels and the map credits, through the shared popup credits.
 */
export function renderIncidentCard(card: IncidentCard, options: PopupCreditsOptions = {}): string {
  const color = SEVERITY_COLORS[card.severity] ?? SEVERITY_COLORS.unknown;
  const glyphColor = LIGHT_SEVERITIES.has(card.severity) ? "#3a2a00" : "#ffffff";
  const icon = `<span class="omx-incident__icon" style="background:${color};color:${glyphColor}">${glyphSvg(card.glyph)}</span>`;
  const where = card.where
    ? `<div class="omx-incident__where">${escapeHtml(card.where)}</div>`
    : "";
  const head = `<div class="omx-incident__head">${icon}<div class="omx-incident__heading"><div class="omx-incident__title">${escapeHtml(card.title)}</div>${where}</div></div>`;
  const tags = [
    card.impact
      ? `<span class="omx-incident__tag omx-incident__tag--${escapeHtml(card.severity)}">${escapeHtml(card.impact)}</span>`
      : "",
    card.unconfirmed
      ? `<span class="omx-incident__tag omx-incident__tag--unconfirmed">${escapeHtml(card.unconfirmed)}</span>`
      : "",
  ].filter(Boolean);
  const tagsHtml = tags.length > 0 ? `<div class="omx-incident__tags">${tags.join("")}</div>` : "";
  const when = card.when
    ? `<div class="omx-incident__when">${CLOCK_ICON}<span>${escapeHtml(card.when)}</span></div>`
    : "";
  const impacts =
    card.impacts.length > 0
      ? `<ul class="omx-incident__impacts">${card.impacts
          .map((line) => `<li>${escapeHtml(line)}</li>`)
          .join("")}</ul>`
      : "";
  const text =
    card.headline || card.description
      ? `<div class="omx-incident__text">${
          card.headline ? `<p class="omx-incident__headline">${escapeHtml(card.headline)}</p>` : ""
        }${card.description ? `<p>${escapeHtml(card.description)}</p>` : ""}</div>`
      : "";
  const warning = card.warning
    ? `<div class="omx-incident__warning" role="status">${escapeHtml(card.warning)}</div>`
    : "";
  const credits = buildPopupCreditsHtml(card.credits, options);
  const footerLines = [
    ...(credits ? [credits] : []),
    ...(card.updated ? [`<div>${escapeHtml(card.updated)}</div>`] : []),
  ];
  const footer =
    footerLines.length > 0 ? `<div class="omx-incident__footer">${footerLines.join("")}</div>` : "";
  const futureClass = card.future ? " omx-incident__card--future" : "";
  return `<div class="omx-incident__card${futureClass}">${head}${tagsHtml}${when}${impacts}${text}${warning}${footer}</div>`;
}

function pointCoordinates(hit: MapGeoJSONFeature): [number, number] | undefined {
  if (hit.geometry?.type !== "Point") return undefined;
  const coordinates = hit.geometry.coordinates;
  return Array.isArray(coordinates) &&
    typeof coordinates[0] === "number" &&
    typeof coordinates[1] === "number"
    ? [coordinates[0], coordinates[1]]
    : undefined;
}

function displayIdsForHit(properties: Record<string, unknown>): string[] {
  const groupedIds = Array.isArray(properties._displayIds)
    ? distinctNonEmpty(properties._displayIds)
    : [];
  if (groupedIds.length > 0) return groupedIds;
  return [String(properties._displayId ?? properties._id ?? properties.headline ?? "")];
}

/** The current situations a popup over `hits` shows, each once. */
export function popupEvents(
  input: Pick<RoadConditionPopupInput, "hits" | "eventsByDisplayId">,
): RoadConditionEvent[] {
  const displayIds = new Set(
    input.hits.flatMap((hit) =>
      displayIdsForHit((hit.properties ?? {}) as Record<string, unknown>),
    ),
  );
  const events = [...displayIds].flatMap((id) => input.eventsByDisplayId.get(id) ?? []);
  return [...new Map(events.map((event) => [event.id, event])).values()];
}

/**
 * Build the incident popup HTML and its anchor from marker or line hits: one
 * card per display group, most severe first, under a count when there are
 * several. The event lookup is authoritative, so line hits and marker hits
 * produce the same cards, and a hit whose situation was withdrawn shows
 * nothing rather than reviving it from old hit properties.
 */
export function buildRoadConditionPopupHtml(
  input: RoadConditionPopupInput,
): RoadConditionPopupContent {
  const atMs = input.atMs ?? Date.now();
  const seen = new Set<string>();
  const cards: { card: IncidentCard; rank: number }[] = [];

  for (const hit of input.hits) {
    const properties = (hit.properties ?? {}) as Record<string, unknown>;
    for (const displayId of displayIdsForHit(properties)) {
      if (seen.has(displayId)) continue;
      seen.add(displayId);
      const events = input.eventsByDisplayId.get(displayId) ?? [];
      const card = buildIncidentCard(events, input, atMs);
      if (!card) continue;
      cards.push({ card, rank: SEVERITY_RANK[card.severity] ?? 0 });
    }
  }

  cards.sort((a, b) => b.rank - a.rank);
  const creditOptions: PopupCreditsOptions = {
    ...input.creditOptions,
    dark: typeof document !== "undefined" && document.documentElement.classList.contains("dark"),
  };
  const top = input.hits[0];
  const count =
    cards.length > 1
      ? `<div class="omx-incident__count">${escapeHtml(
          input.translate("panel.conditionsHere", { count: cards.length }),
        )}</div>`
      : "";
  const stackClass = cards.length > 1 ? " omx-incident--stack" : "";
  return {
    html: `<div class="omx-incident${stackClass}">${count}${cards
      .map(({ card }) => renderIncidentCard(card, creditOptions))
      .join("")}</div>`,
    coordinates: (top ? pointCoordinates(top) : undefined) ?? input.fallbackCoordinates,
    groupCount: cards.length,
  };
}
