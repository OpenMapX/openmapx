import { formatDuration, type RoadConditionEvent, type RoadConditionType } from "@openmapx/core";
import type { MapGeoJSONFeature } from "maplibre-gl";
import { buildStackedPopupCardItems, type PopupCardSpec } from "@/components/map/overlay/popupCard";
import { isFutureRoadCondition } from "./visual-style";

export const ROAD_CONDITION_SEVERITY_RANK: Record<string, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  unknown: 0,
};

const POPUP_SPEC: PopupCardSpec = {
  titleField: "headline",
  severityField: "severity",
  attributionField: "attribution",
  rows: [
    { field: "type", labelKey: "panel.type", format: "label", variant: "chip" },
    { field: "roadState", labelKey: "panel.roadState", format: "label", variant: "chip" },
    { field: "roads", labelKey: "panel.roads", variant: "row" },
    { field: "recordId", labelKey: "panel.sourceRecord", variant: "row" },
    { field: "validity", labelKey: "panel.validity", variant: "row" },
    { field: "startsAt", variant: "row" },
    { field: "delayText", labelKey: "panel.delay", variant: "row" },
    { field: "description", labelKey: "panel.description", variant: "block" },
  ],
};

const SOURCE_DETAIL_SPEC: PopupCardSpec = {
  titleField: "headline",
  severityField: "severity",
  rows: [
    { field: "type", labelKey: "panel.type", format: "label", variant: "chip" },
    { field: "roadState", labelKey: "panel.roadState", format: "label", variant: "chip" },
    { field: "roads", labelKey: "panel.roads", variant: "row" },
    { field: "recordId", labelKey: "panel.sourceRecord", variant: "row" },
    { field: "validity", labelKey: "panel.validity", variant: "row" },
  ],
};

interface ScheduleEntry {
  startTime?: string;
  endTime?: string;
  startDate?: string;
  endDate?: string;
  byDay?: string[];
}

export type RoadConditionTranslate = (
  key: string,
  values?: Record<string, string | number>,
) => string;

export interface RoadConditionPopupInput {
  hits: MapGeoJSONFeature[];
  fallbackCoordinates: [number, number];
  eventsByDisplayId: ReadonlyMap<string, RoadConditionEvent[]>;
  formatDateTime: (value: string | number | Date) => string;
  formatDate: (value: string | number | Date) => string;
  translate: RoadConditionTranslate;
}

export interface RoadConditionPopupContent {
  html: string;
  coordinates: [number, number];
  groupCount: number;
}

function formatValidity(
  scheduleJson: unknown,
  from: unknown,
  to: unknown,
  fmtDateTime: (value: string | number | Date) => string,
  fmtDate: (value: string | number | Date) => string,
): string {
  if (typeof scheduleJson === "string" && scheduleJson) {
    try {
      const windows = JSON.parse(scheduleJson) as ScheduleEntry[];
      const hhmm = (time?: string) => (time ? time.slice(0, 5) : "");
      const parts = windows
        .map((window) => {
          const days = window.byDay && window.byDay.length > 0 ? window.byDay.join(", ") : "";
          const band =
            window.startTime && window.endTime
              ? `${hhmm(window.startTime)}–${hhmm(window.endTime)}`
              : window.startTime
                ? `from ${hhmm(window.startTime)}`
                : "";
          const range =
            window.startDate && window.endDate
              ? `${fmtDate(window.startDate)} – ${fmtDate(window.endDate)}`
              : window.startDate
                ? fmtDate(window.startDate)
                : "";
          return [days, band, range].filter(Boolean).join(", ");
        })
        .filter(Boolean);
      if (parts.length > 0) return parts.join("; ");
    } catch {
      // Malformed schedule falls through to the plain validity range.
    }
  }
  const f = typeof from === "string" && from ? fmtDateTime(from) : "";
  const t = typeof to === "string" && to ? fmtDateTime(to) : "";
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

function roadNamesForEvents(events: RoadConditionEvent[]): string | undefined {
  const names = distinctNonEmpty(
    events.flatMap((event) =>
      (event.roads ?? []).map((road) => {
        const raw = road as unknown as { name?: unknown; ref?: unknown };
        return String(raw.ref ?? raw.name ?? "");
      }),
    ),
  );
  return names.length > 0 ? names.join(", ") : undefined;
}

function popupProperties(
  event: RoadConditionEvent,
  displayId: string,
  includeRecordId: boolean,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    headline: event.headline,
    type: event.type as RoadConditionType,
    severity: event.severity,
    attribution: attributionString(event.attribution),
    _id: event.id,
    _displayId: displayId,
    _sev: ROAD_CONDITION_SEVERITY_RANK[event.severity] ?? 0,
    future: isFutureRoadCondition(event),
  };
  if (includeRecordId) properties.recordId = event.id;
  if (event.roadState) properties.roadState = event.roadState;
  if (event.validFrom) properties.validFrom = event.validFrom;
  if (event.validTo) properties.validTo = event.validTo;
  if (event.schedule && event.schedule.length > 0) {
    properties.schedule = JSON.stringify(event.schedule);
  }
  if (event.description) properties.description = event.description;
  if (typeof event.delaySeconds === "number") properties.delaySeconds = event.delaySeconds;
  const roads = roadNamesForEvents([event]);
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
): RoadConditionPopupGroup[] {
  if (events.length === 0) return [];
  const childEntries = events.map((event) => popupProperties(event, displayId, events.length > 1));
  const firstEntry = childEntries[0];
  if (events.length === 1 && firstEntry) return [{ summary: firstEntry, sourceRecords: [] }];

  const representative = events.reduce((best, event) => {
    const bestRank = ROAD_CONDITION_SEVERITY_RANK[best.severity] ?? 0;
    const eventRank = ROAD_CONDITION_SEVERITY_RANK[event.severity] ?? 0;
    return eventRank > bestRank ? event : best;
  });
  const summary = popupProperties(representative, displayId, false);
  summary.sourceRecordCount = events.length;

  const same = (field: keyof RoadConditionEvent) =>
    events.every((event) => JSON.stringify(event[field]) === JSON.stringify(events[0]?.[field]));
  const headlines = distinctNonEmpty(events.map((event) => event.headline));
  if (headlines.length > 1)
    summary.headline = relatedHeadline(representative.headline, events.length);

  const types = distinctNonEmpty(events.map((event) => event.type));
  if (types.length > 0) summary.type = types.join(", ");
  const roads = roadNamesForEvents(events);
  if (roads) summary.roads = roads;

  if (!same("description")) delete summary.description;
  if (!same("validFrom")) {
    const starts = events
      .map((event) => event.validFrom)
      .filter((value): value is string => typeof value === "string" && value.length > 0);
    if (starts.length > 0) {
      summary.validFrom = starts.reduce((earliest, value) =>
        Date.parse(value) < Date.parse(earliest) ? value : earliest,
      );
    } else delete summary.validFrom;
  }
  if (!same("validTo")) {
    const ends = events
      .map((event) => event.validTo)
      .filter((value): value is string => typeof value === "string" && value.length > 0);
    if (ends.length > 0) {
      summary.validTo = ends.reduce((latest, value) =>
        Date.parse(value) > Date.parse(latest) ? value : latest,
      );
    } else delete summary.validTo;
  }
  if (!same("schedule")) delete summary.schedule;
  if (!same("delaySeconds")) delete summary.delaySeconds;

  return [{ summary, sourceRecords: childEntries }];
}

function formatPopupEntry(
  sourceEntry: Record<string, unknown>,
  input: RoadConditionPopupInput,
): Record<string, unknown> {
  const validity = formatValidity(
    sourceEntry.schedule,
    sourceEntry.validFrom,
    sourceEntry.validTo,
    input.formatDateTime,
    input.formatDate,
  );
  const startsAt =
    sourceEntry.future === true && typeof sourceEntry.validFrom === "string"
      ? input.translate("startsAt", { date: input.formatDateTime(sourceEntry.validFrom) })
      : undefined;
  const delaySeconds = Number(sourceEntry.delaySeconds);
  const delayText =
    Number.isFinite(delaySeconds) && delaySeconds >= 60
      ? `+${formatDuration(delaySeconds)}`
      : undefined;
  return {
    ...sourceEntry,
    ...(validity ? { validity } : {}),
    ...(startsAt ? { startsAt } : {}),
    ...(delayText ? { delayText } : {}),
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
      const popupGroups = childEvents?.length
        ? buildRoadConditionPopupGroups(displayId, childEvents, (headline, count) =>
            input.translate("panel.relatedRecords", { headline, count }),
          )
        : [{ summary: properties, sourceRecords: [] }];

      for (const group of popupGroups) {
        const summary = formatPopupEntry(group.summary, input);
        if (typeof group.summary.sourceRecordCount === "number") {
          summary.recordId = input.translate("panel.sourceRecordCount", {
            count: group.summary.sourceRecordCount,
          });
        }
        const sourceEntries = group.sourceRecords.map((entry) => formatPopupEntry(entry, input));
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
