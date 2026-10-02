import {
  getRoadConditionRoutingDecision,
  localizedTextFor,
  type RoadConditionEvent,
} from "@openmapx/core";
import type { MapGeoJSONFeature } from "maplibre-gl";
import {
  buildStackedPopupCardItems,
  type PopupCardRow,
  type PopupCardSpec,
} from "@/integration-api/map/popupCard";
import { effectLines, hasRestrictionEvidence } from "./effects";
import { isUnconfirmedCrowd } from "./evidence";
import { mostSevereEvent, SEVERITY_LABELS, SEVERITY_RANK } from "./severity";
import type { RoadConditionTranslate } from "./types";
import { isFutureRoadCondition } from "./visual-style";

const DETAIL_ROWS: PopupCardRow[] = [
  { field: "typeText", labelKey: "panel.type", variant: "chip" },
  { field: "reportText", labelKey: "panel.report", variant: "chip" },
  { field: "effectsText", labelKey: "panel.effects", variant: "block" },
  { field: "interpretationText", labelKey: "panel.interpretation", variant: "row" },
  { field: "roads", labelKey: "panel.roads", variant: "row" },
  { field: "directionText", labelKey: "panel.direction", variant: "row" },
  { field: "validity", labelKey: "panel.validity", variant: "row" },
  { field: "startsAt", labelKey: "panel.startsAt", variant: "row" },
];

const PROVENANCE_ROWS: PopupCardRow[] = [
  { field: "recordId", labelKey: "panel.sourceRecord", variant: "row" },
  { field: "source", labelKey: "panel.source", variant: "row" },
  { field: "license", labelKey: "panel.license", variant: "row" },
  { field: "updatedAtText", labelKey: "panel.updatedAt", variant: "row" },
  { field: "checkedAtText", labelKey: "panel.checkedAt", variant: "row" },
  { field: "freshnessText", labelKey: "panel.freshness", variant: "row" },
  { field: "bindingText", labelKey: "panel.binding", variant: "row" },
  { field: "applicationText", labelKey: "panel.routing", variant: "row" },
];

const POPUP_SPEC: PopupCardSpec = {
  titleField: "headline",
  severityField: "severity",
  severityLabelField: "severityText",
  attributionField: "attribution",
  rows: [
    ...DETAIL_ROWS,
    { field: "description", labelKey: "panel.description", variant: "block" },
    ...PROVENANCE_ROWS,
  ],
};

const SOURCE_DETAIL_SPEC: PopupCardSpec = {
  titleField: "headline",
  severityField: "severity",
  severityLabelField: "severityText",
  rows: [...DETAIL_ROWS, ...PROVENANCE_ROWS],
};

export type { RoadConditionTranslate } from "./types";

export interface RoadConditionPopupInput {
  hits: MapGeoJSONFeature[];
  fallbackCoordinates: [number, number];
  eventsByDisplayId: ReadonlyMap<string, RoadConditionEvent[]>;
  formatDateTime: (value: string | number | Date) => string;
  formatDate: (value: string | number | Date) => string;
  translate: RoadConditionTranslate;
  /** The UI locale: picks each situation's text in the reader's language. */
  locale: string;
  /** Refresh last-good context without presenting it as current. */
  needsRefresh?: boolean;
  /** The instant effects and expiry are evaluated at; default now. */
  atMs?: number;
  /** Layer refreshes must not revive withdrawn records from old hit properties. */
  requireCurrentEvents?: boolean;
}

export interface RoadConditionPopupContent {
  html: string;
  coordinates: [number, number];
  groupCount: number;
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
const BINDING_STATUSES = new Set([
  "exact",
  "likely",
  "ambiguous",
  "unresolved",
  "no_coverage",
  "not_applicable",
  "unattempted",
  "obsolete",
  "invalid",
]);
const SCHEDULE_WEEKDAY_CODES = new Set(["MO", "TU", "WE", "TH", "FR", "SA", "SU"]);

function humanizeToken(raw: string): string {
  const value = raw.replace(/[_-]+/g, " ").trim();
  return value.length === 0 ? value : value.charAt(0).toUpperCase() + value.slice(1);
}

/** A `kind.type` classification's label: its type's, else its kind's, else the token. */
function classificationLabel(token: string, translate: RoadConditionTranslate): string {
  const [kind = "", type = ""] = token.split(".");
  if (KNOWN_TYPES.has(type)) return translate(`type.${type}`);
  if (KNOWN_KINDS.has(kind)) return translate(`kind.${kind}`);
  return humanizeToken(type || kind);
}

function scheduleDayLabel(day: string, translate: RoadConditionTranslate): string {
  const code = day.trim().toUpperCase();
  return SCHEDULE_WEEKDAY_CODES.has(code) ? translate(`schedule.days.${code}`) : day.trim();
}

function formatValidity(
  validity: RoadConditionEvent["validity"] | undefined,
  input: RoadConditionPopupInput,
): string {
  if (!validity) return "";
  const hhmm = (time?: string) => (time ? time.slice(0, 5) : "");
  const windows = (validity.periods ?? [])
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
        window.startDate && window.endDate
          ? `${input.formatDate(window.startDate)} – ${input.formatDate(window.endDate)}`
          : window.startDate
            ? input.formatDate(window.startDate)
            : "";
      return [days, band, range].filter(Boolean).join(", ");
    })
    .filter(Boolean);
  if (windows.length > 0) return windows.join("; ");
  const end = validity.end ?? validity.estimatedEnd;
  const f = validity.start ? input.formatDateTime(validity.start) : "";
  const t = end ? input.formatDateTime(end) : "";
  if (!f && !t) return "";
  return `${f || "…"} – ${t || "…"}`;
}

function attributionString(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object") {
    const value = raw as Record<string, unknown>;
    const provider = typeof value.provider === "string" ? value.provider : "";
    const license = typeof value.license === "string" ? value.license : "";
    return provider && license ? `${provider} · ${license}` : provider || license;
  }
  return "";
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

function directionText(
  direction: RoadConditionEvent["direction"],
  translate: RoadConditionTranslate,
): string | undefined {
  if (!direction) return undefined;
  const parts = [
    DIRECTION_VALUES.has(direction.value)
      ? translate(`direction.${direction.value}`)
      : humanizeToken(direction.value),
    direction.compass,
    direction.text,
  ].filter(Boolean);
  return parts.join(" · ");
}

/** The raw, untranslated card fields of one situation. */
function popupProperties(
  event: RoadConditionEvent,
  displayId: string,
  includeRecordId: boolean,
  locale: string,
  atMs: number,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    headline: localizedTextFor(event.headline, locale) ?? "",
    classification: `${event.kind}.${event.type}`,
    severity: event.severity.label,
    attribution: attributionString(event.attribution),
    _id: event.id,
    _displayId: displayId,
    _sev: SEVERITY_RANK[event.severity.label],
    future: isFutureRoadCondition(event, atMs),
    // Carried only so the formatter can read effects, validity and direction;
    // stripped again in formatPopupEntry so it never reaches the rendered card.
    _event: event,
  };
  properties.source = event.source;
  if (event.attribution.license) properties.license = event.attribution.license;
  if (event.updatedAt) properties.updatedAt = event.updatedAt;
  if (event.fetchedAt) properties.checkedAt = event.fetchedAt;
  if (event.expiresAt) properties.expiresAt = event.expiresAt;
  if (isUnconfirmedCrowd(event)) properties.unconfirmed = true;
  // Routing evidence is per effect and only present where the provider could
  // read it; without it the card says nothing about routing rather than
  // guessing.
  const evidence = Object.values(event.routingEvidence ?? {});
  if (evidence.length > 0) {
    properties.bindingStatus = distinctNonEmpty(evidence.map((e) => e.binding_status)).join(",");
    properties.applicationReason = event.effects.some(
      (effect) => getRoadConditionRoutingDecision(event, effect, { evaluatedAt: atMs }).eligible,
    )
      ? "candidate"
      : "display_only";
  }
  if (includeRecordId) properties.recordId = event.id;
  const description = localizedTextFor(event.description, locale);
  if (description) properties.description = description;
  const roads = roadNamesForEvents([event], locale);
  if (roads) properties.roads = roads;
  return properties;
}

export interface RoadConditionPopupGroup {
  summary: Record<string, unknown>;
  sourceRecords: Record<string, unknown>[];
}

function defaultRelatedHeadline(headline: string, count: number): string {
  return `${headline} (${count} related records)`;
}

/** Builds one visible summary and one source-record disclosure per explicit group. */
export function buildRoadConditionPopupGroups(
  displayId: string,
  events: RoadConditionEvent[],
  relatedHeadline: (headline: string, count: number) => string = defaultRelatedHeadline,
  locale = "en",
  atMs: number = Date.now(),
): RoadConditionPopupGroup[] {
  if (events.length === 0) return [];
  const childEntries = events.map((event) =>
    popupProperties(event, displayId, events.length > 1, locale, atMs),
  );
  const firstEntry = childEntries[0];
  if (events.length === 1 && firstEntry) return [{ summary: firstEntry, sourceRecords: [] }];

  const representative = mostSevereEvent(events);
  const summary = popupProperties(representative, displayId, false, locale, atMs);
  summary.sourceRecordCount = events.length;

  const same = (field: keyof RoadConditionEvent) =>
    events.every((event) => JSON.stringify(event[field]) === JSON.stringify(events[0]?.[field]));
  const headlines = distinctNonEmpty(childEntries.map((entry) => entry.headline));
  if (headlines.length > 1) {
    summary.headline = relatedHeadline(String(summary.headline), events.length);
  }
  summary.classification = distinctNonEmpty(childEntries.map((e) => e.classification)).join(",");
  const roads = roadNamesForEvents(events, locale);
  if (roads) summary.roads = roads;

  if (!same("description")) delete summary.description;
  // What the group does and when only reads true when every record agrees;
  // otherwise each record's own card in the disclosure says it.
  if (!same("effects") || !same("validity") || !same("direction")) {
    summary._summaryOnly = true;
  }
  if (!same("routingEvidence")) {
    delete summary.bindingStatus;
    delete summary.applicationReason;
  }
  if (!same("updatedAt")) delete summary.updatedAt;
  if (!same("fetchedAt")) delete summary.checkedAt;
  if (!same("attribution")) {
    delete summary.attribution;
    delete summary.license;
  }
  if (!same("source")) delete summary.source;

  return [{ summary, sourceRecords: childEntries }];
}

function formatPopupEntry(
  sourceEntry: Record<string, unknown>,
  input: RoadConditionPopupInput,
  atMs: number,
): Record<string, unknown> {
  const { translate } = input;
  const event = sourceEntry._event as RoadConditionEvent | undefined;
  const detailed = event && sourceEntry._summaryOnly !== true ? event : undefined;
  const classifications =
    typeof sourceEntry.classification === "string"
      ? distinctNonEmpty(sourceEntry.classification.split(","))
      : [];
  const typeText = distinctNonEmpty(
    classifications.map((token) => classificationLabel(token, translate)),
  ).join(", ");
  const severityText = SEVERITY_LABELS.includes(
    sourceEntry.severity as (typeof SEVERITY_LABELS)[number],
  )
    ? translate(`sev.${String(sourceEntry.severity)}`)
    : undefined;
  const validity = formatValidity(detailed?.validity, input);
  const startsAt =
    sourceEntry.future === true && detailed?.validity.start
      ? input.formatDateTime(detailed.validity.start)
      : undefined;
  const effectsText = detailed
    ? effectLines(detailed, {
        translate,
        locale: input.locale,
        at: new Date(atMs),
        formatDateTime: (value) => input.formatDateTime(value),
      }).join("\n")
    : "";
  const expiresAt =
    typeof sourceEntry.expiresAt === "string" ? Date.parse(sourceEntry.expiresAt) : Number.NaN;
  const freshnessText = input.needsRefresh
    ? translate("freshness.needsRefresh")
    : Number.isFinite(expiresAt) && expiresAt <= atMs
      ? translate("freshness.stale")
      : undefined;
  const absoluteTime = (value: unknown) =>
    typeof value === "string" && Number.isFinite(Date.parse(value))
      ? new Date(value).toISOString()
      : undefined;
  const direction = directionText(detailed?.direction, translate);
  const bindingText =
    typeof sourceEntry.bindingStatus === "string"
      ? distinctNonEmpty(sourceEntry.bindingStatus.split(","))
          .map((status) =>
            BINDING_STATUSES.has(status) ? translate(`binding.${status}`) : humanizeToken(status),
          )
          .join(", ")
      : "";
  const applicationText =
    sourceEntry.applicationReason === "candidate"
      ? translate("panel.routingCandidate")
      : sourceEntry.applicationReason === "display_only"
        ? translate("panel.routingDisplayOnly")
        : undefined;
  const {
    _event: _dropEvent,
    _summaryOnly: _dropSummary,
    classification: _dropClassification,
    bindingStatus: _dropBinding,
    applicationReason: _dropApplication,
    ...rest
  } = sourceEntry;
  return {
    ...rest,
    updatedAtText: absoluteTime(sourceEntry.updatedAt),
    checkedAtText: absoluteTime(sourceEntry.checkedAt),
    ...(typeText ? { typeText } : {}),
    ...(severityText ? { severityText } : {}),
    ...(effectsText ? { effectsText } : {}),
    ...(detailed && hasRestrictionEvidence(detailed)
      ? { interpretationText: translate("interpretation.partial") }
      : {}),
    ...(sourceEntry.unconfirmed === true ? { reportText: translate("report.unconfirmed") } : {}),
    ...(direction ? { directionText: direction } : {}),
    ...(validity ? { validity } : {}),
    ...(startsAt ? { startsAt } : {}),
    ...(freshnessText ? { freshnessText } : {}),
    ...(bindingText ? { bindingText } : {}),
    ...(applicationText ? { applicationText } : {}),
  };
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

/**
 * Build shared incident popup HTML and its anchor from either marker or line
 * hits. The event lookup is authoritative for grouped records, so line hits
 * and marker hits produce the same visible cards and source disclosure.
 */
export function buildRoadConditionPopupHtml(
  input: RoadConditionPopupInput,
): RoadConditionPopupContent {
  const atMs = input.atMs ?? Date.now();
  const seen = new Set<string>();
  const items: {
    properties: Record<string, unknown>;
    details?: { label: string; entries: Record<string, unknown>[]; spec: PopupCardSpec };
  }[] = [];
  let groupCount = 0;

  for (const hit of input.hits) {
    const properties = (hit.properties ?? {}) as Record<string, unknown>;
    for (const displayId of displayIdsForHit(properties)) {
      if (seen.has(displayId)) continue;
      seen.add(displayId);

      const childEvents = input.eventsByDisplayId.get(displayId);
      if (input.requireCurrentEvents && !childEvents?.length) continue;
      const popupGroups = childEvents?.length
        ? buildRoadConditionPopupGroups(
            displayId,
            childEvents,
            (headline, count) => input.translate("panel.relatedRecords", { headline, count }),
            input.locale,
            atMs,
          )
        : [{ summary: properties, sourceRecords: [] }];

      for (const group of popupGroups) {
        const summary = formatPopupEntry(group.summary, input, atMs);
        if (typeof group.summary.sourceRecordCount === "number") {
          summary.recordId = input.translate("panel.sourceRecordCount", {
            count: group.summary.sourceRecordCount,
          });
        }
        const sourceEntries = group.sourceRecords.map((entry) =>
          formatPopupEntry(entry, input, atMs),
        );
        items.push({
          properties: summary,
          ...(sourceEntries.length > 0
            ? {
                details: {
                  label: input.translate("panel.sourceDetails", { count: sourceEntries.length }),
                  entries: sourceEntries,
                  spec: SOURCE_DETAIL_SPEC,
                },
              }
            : {}),
        });
        groupCount += 1;
      }
    }
  }

  items.sort((a, b) => (Number(b.properties._sev) || 0) - (Number(a.properties._sev) || 0));
  const top = input.hits[0];
  return {
    html: buildStackedPopupCardItems(
      POPUP_SPEC,
      items,
      (key) => input.translate(key),
      input.translate("panel.conditionsHere", { count: groupCount }),
    ),
    coordinates: pointCoordinates(top) ?? input.fallbackCoordinates,
    groupCount,
  };
}
