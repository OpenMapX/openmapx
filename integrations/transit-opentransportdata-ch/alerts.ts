import { createHash } from "node:crypto";
import { snapshotContributors } from "@openmapx/mobility-core/contributors";
import type { ServiceAlert } from "@openmapx/mobility-core/transit";
import {
  gtfsRtTimestampToIso,
  listSiriSituations,
  type SiriSituation,
} from "@openmapx/mobility-formats";
import {
  normalizeSwissLookupKey,
  normalizeText,
  PROVIDER,
  providerId,
  type SwissObservedRouteEntry,
  type SwissProviderRuntime,
  stripProviderPrefix,
  swissContributors,
  uniqueStrings,
} from "./common.js";
import { resolveSwissStopIdentity, type SwissStopDatasets } from "./datasets.js";
import { findServicePoint, matchesStopRef } from "./stop-identity.js";

type SwissMappedAlert = ServiceAlert & {
  rawOperatorRefs: string[];
  rawRouteRefs: string[];
  rawStopRefs: string[];
};

interface SwissGtfsTranslatedText {
  translation?: Array<{ text?: string }>;
}

interface SwissGtfsInformedEntity {
  routeId?: string;
  stopId?: string;
}

interface SwissGtfsActivePeriod {
  end?: string;
  start?: string;
}

interface SwissGtfsAlert {
  activePeriod?: SwissGtfsActivePeriod[];
  descriptionText?: SwissGtfsTranslatedText;
  effect?: string;
  headerText?: SwissGtfsTranslatedText;
  informedEntity?: SwissGtfsInformedEntity[];
  severityLevel?: string;
  ttsDescriptionText?: SwissGtfsTranslatedText;
  ttsHeaderText?: SwissGtfsTranslatedText;
}

interface SwissGtfsEntity {
  alert?: SwissGtfsAlert;
  id?: string;
}

function translatedText(
  value: { translation?: Array<{ text?: string }> } | undefined,
): string | undefined {
  return value?.translation?.find((entry) => entry.text)?.text;
}

function pickSiriText(
  runtime: SwissProviderRuntime,
  values: Array<{ language?: string; value: string }> | undefined,
  preferredLanguage = runtime.client.config.requestLanguage,
): string | undefined {
  if (!values?.length) return undefined;
  const normalized = normalizeText(preferredLanguage).toLowerCase();
  if (normalized) {
    const exact = values.find((value) => value.language?.toLowerCase() === normalized);
    if (exact) return exact.value;
    const base = normalized.split("-")[0];
    const partial = values.find((value) => {
      const language = value.language?.toLowerCase();
      return language === base || language?.startsWith(`${base}-`);
    });
    if (partial) return partial.value;
  }
  return values[0]?.value;
}

function mapGtfsAlertSeverity(alert: {
  effect?: string;
  severityLevel?: string;
}): ServiceAlert["severity"] {
  const severity = String(alert.severityLevel ?? "").toUpperCase();
  const effect = String(alert.effect ?? "").toUpperCase();
  if (severity === "SEVERE" || severity === "UNKNOWN_SEVERITY") return "severe";
  if (effect === "NO_SERVICE" || effect === "STOP_MOVED" || effect === "SIGNIFICANT_DELAYS") {
    return "critical";
  }
  if (effect === "DETOUR" || effect === "REDUCED_SERVICE") return "severe";
  if (severity === "WARNING") return "warning";
  return "info";
}

function mapSiriAlertSeverity(situation: SiriSituation): ServiceAlert["severity"] {
  const severity = normalizeText(situation.severity).toLowerCase();
  const consequenceEffects = situation.consequences
    .map((consequence) => normalizeText(consequence.effect).toLowerCase())
    .filter(Boolean);
  const consequenceSeverities = situation.consequences
    .map((consequence) => normalizeText(consequence.severity).toLowerCase())
    .filter(Boolean);
  if (
    severity.includes("critical") ||
    consequenceSeverities.some((value) => value.includes("critical")) ||
    consequenceEffects.some((value) =>
      ["no_service", "noservice", "stopmoved", "stop_moved", "stationclosed"].includes(value),
    )
  ) {
    return "critical";
  }
  if (
    severity.includes("severe") ||
    consequenceSeverities.some((value) => value.includes("severe")) ||
    consequenceEffects.some((value) =>
      ["significantdelays", "detour", "reducedservice", "lineclosed"].includes(value),
    )
  ) {
    return "severe";
  }
  if (
    severity.includes("warning") ||
    consequenceSeverities.some((value) => value.includes("warning"))
  ) {
    return "warning";
  }
  return "info";
}

function hashSwissAlert(value: unknown): string {
  return createHash("sha1").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

function mapAffectedSwissStopIds(rawStopRefs: string[], datasets: SwissStopDatasets): string[] {
  const affectedStopIds = new Set<string>();
  for (const rawStopRef of rawStopRefs) {
    affectedStopIds.add(providerId(rawStopRef));
    const identity = resolveSwissStopIdentity(rawStopRef, datasets);
    if (identity.didok) affectedStopIds.add(providerId(identity.didok));
    if (identity.servicePointSloid) affectedStopIds.add(providerId(identity.servicePointSloid));
  }
  return [...affectedStopIds];
}

function mapGtfsAlert(
  runtime: SwissProviderRuntime,
  entity: SwissGtfsEntity,
  datasets: SwissStopDatasets,
): SwissMappedAlert | null {
  const alert = entity.alert;
  if (!alert) return null;
  const informed = alert.informedEntity ?? [];
  const rawStopRefs = Array.from(
    new Set(
      informed.map((entry) => entry.stopId).filter((value): value is string => Boolean(value)),
    ),
  );
  const rawRouteRefs = Array.from(
    new Set(
      informed.map((entry) => entry.routeId).filter((value): value is string => Boolean(value)),
    ),
  );
  const activePeriods: ServiceAlert["activePeriods"] = (alert.activePeriod ?? [])
    .map((period) => ({
      end: gtfsRtTimestampToIso(period.end),
      start: gtfsRtTimestampToIso(period.start) || new Date().toISOString(),
    }))
    .filter((period) => Boolean(period.start));
  return {
    contributors: swissContributors(
      runtime,
      "gtfs-sa",
      ...(rawStopRefs.length ? ["master-data"] : []),
    ),
    activePeriods,
    affectedRouteIds: rawRouteRefs.map((routeId) => providerId(`gtfs-route:${routeId}`)),
    affectedStopIds: mapAffectedSwissStopIds(rawStopRefs, datasets),
    description: translatedText(alert.descriptionText) || translatedText(alert.ttsDescriptionText),
    effect: alert.effect,
    id: providerId(`alert:${entity.id ?? hashSwissAlert(alert)}`),
    providers: [PROVIDER],
    rawOperatorRefs: [],
    rawRouteRefs,
    rawStopRefs,
    severity: mapGtfsAlertSeverity(alert),
    title:
      translatedText(alert.headerText) ||
      translatedText(alert.ttsHeaderText) ||
      translatedText(alert.descriptionText) ||
      "Service alert",
  } satisfies SwissMappedAlert;
}

function mapSiriSituation(
  runtime: SwissProviderRuntime,
  situation: SiriSituation,
  datasets: SwissStopDatasets,
): SwissMappedAlert {
  const rawStopRefs = uniqueStrings([...situation.stopPointRefs, ...situation.stopPlaceRefs]);
  const rawRouteRefs = uniqueStrings([...situation.lineRefs, ...situation.routeRefs]);
  const descriptions = uniqueStrings([
    pickSiriText(runtime, situation.descriptions),
    ...situation.consequences.map((consequence) => consequence.advice),
  ]);
  const activePeriods = uniqueStrings([
    ...situation.validityPeriods.map((period) => period.startTime),
    ...situation.publicationWindows.map((period) => period.startTime),
  ]).map((start) => {
    const validity =
      situation.validityPeriods.find((period) => period.startTime === start) ??
      situation.publicationWindows.find((period) => period.startTime === start);
    return {
      end: validity?.endTime,
      start,
    };
  });
  const title = pickSiriText(runtime, situation.summaries) || descriptions[0] || "Service alert";
  return {
    contributors: swissContributors(
      runtime,
      "siri-sx",
      ...(rawStopRefs.length ? ["master-data"] : []),
    ),
    activePeriods: activePeriods.length
      ? activePeriods
      : [{ start: situation.creationTime || new Date().toISOString() }],
    affectedRouteIds: rawRouteRefs.map((ref) => providerId(ref)),
    affectedStopIds: mapAffectedSwissStopIds(rawStopRefs, datasets),
    description: descriptions[0],
    effect:
      situation.consequences.find((consequence) => consequence.effect)?.effect ||
      situation.reportType,
    id: providerId(
      `siri-alert:${
        situation.id ||
        situation.situationNumber ||
        hashSwissAlert({
          rawRouteRefs,
          rawStopRefs,
          title,
        })
      }`,
    ),
    providers: [PROVIDER],
    rawOperatorRefs: uniqueStrings(situation.operatorRefs),
    rawRouteRefs,
    rawStopRefs,
    severity: mapSiriAlertSeverity(situation),
    title,
  };
}

function dedupeSwissMappedAlerts(alerts: SwissMappedAlert[]): SwissMappedAlert[] {
  const merged = new Map<string, SwissMappedAlert>();
  for (const alert of alerts) {
    const existing = merged.get(alert.id);
    if (!existing) {
      merged.set(alert.id, alert);
      continue;
    }
    merged.set(alert.id, {
      ...existing,
      contributors: snapshotContributors(existing.contributors ?? [], alert.contributors ?? []),
      activePeriods: [...existing.activePeriods, ...alert.activePeriods],
      affectedRouteIds: uniqueStrings([...existing.affectedRouteIds, ...alert.affectedRouteIds]),
      affectedStopIds: uniqueStrings([...existing.affectedStopIds, ...alert.affectedStopIds]),
      description: existing.description || alert.description,
      effect: existing.effect || alert.effect,
      rawOperatorRefs: uniqueStrings([...existing.rawOperatorRefs, ...alert.rawOperatorRefs]),
      rawRouteRefs: uniqueStrings([...existing.rawRouteRefs, ...alert.rawRouteRefs]),
      rawStopRefs: uniqueStrings([...existing.rawStopRefs, ...alert.rawStopRefs]),
      title: existing.title || alert.title,
    });
  }
  return [...merged.values()];
}

/** Mapped alerts from the GTFS-SA feed, or `null` when the feed failed. */
async function loadGtfsMappedAlerts(
  runtime: SwissProviderRuntime,
  datasets: SwissStopDatasets,
): Promise<SwissMappedAlert[] | null> {
  try {
    const feed = await runtime.client.fetchSwissGtfsSaFeed();
    const entities = (feed.entity ?? []) as SwissGtfsEntity[];
    return entities
      .map((entity) => mapGtfsAlert(runtime, entity, datasets))
      .filter((alert): alert is SwissMappedAlert => alert !== null);
  } catch (error) {
    runtime.client.config.log?.warn?.("Swiss GTFS-SA alert feed failed", error);
    return null;
  }
}

/** Mapped alerts from one SIRI-SX feed, or `null` when the feed failed. */
async function loadSiriMappedAlerts(
  runtime: SwissProviderRuntime,
  datasets: SwissStopDatasets,
  feed: "complete" | "unplanned",
): Promise<SwissMappedAlert[] | null> {
  try {
    const situations = listSiriSituations(await runtime.client.fetchSwissSiriSxFeed(feed));
    return situations.map((situation) => mapSiriSituation(runtime, situation, datasets));
  } catch (error) {
    runtime.client.config.log?.warn?.(
      feed === "complete" ? "Swiss SIRI-SX feed failed" : "Swiss SIRI-SX unplanned feed failed",
      error,
    );
    return null;
  }
}

/**
 * Alerts from the GTFS-SA and SIRI-SX feeds. They describe largely the same
 * situations, so any feed that answers gives a usable list; only when none
 * answers is the result unavailable rather than "no alerts".
 */
export async function loadMappedAlerts(runtime: SwissProviderRuntime): Promise<SwissMappedAlert[]> {
  const datasets = await runtime.datasets.loadSwissStopDatasets();
  const feeds = await Promise.all([
    loadGtfsMappedAlerts(runtime, datasets),
    loadSiriMappedAlerts(runtime, datasets, "complete"),
    loadSiriMappedAlerts(runtime, datasets, "unplanned"),
  ]);
  const answered = feeds.filter((alerts): alerts is SwissMappedAlert[] => alerts !== null);
  if (answered.length === 0) throw new Error("Swiss alert feeds unavailable");
  return dedupeSwissMappedAlerts(answered.flat());
}

export function alertMatchesStop(
  alert: SwissMappedAlert,
  rawStopRef: string,
  datasets: SwissStopDatasets,
): boolean {
  return alert.rawStopRefs.some((candidate) => matchesStopRef(candidate, rawStopRef, datasets));
}

export function alertCoordinates(
  alert: SwissMappedAlert,
  datasets: SwissStopDatasets,
): Array<[number, number]> {
  const coordinates: Array<[number, number]> = [];
  for (const rawStopRef of alert.rawStopRefs) {
    const { servicePoint, stopPoint } = findServicePoint(rawStopRef, datasets);
    if (stopPoint) {
      coordinates.push([stopPoint.lng, stopPoint.lat]);
      continue;
    }
    if (servicePoint) {
      coordinates.push([servicePoint.lng, servicePoint.lat]);
    }
  }
  return coordinates;
}

function normalizeSwissRouteAlertKey(value: string | undefined): string | null {
  const normalized = normalizeText(value)
    .replace(/^gtfs-route:/, "")
    .replace(/^otdch:/, "");
  if (!normalized) return null;
  return normalized.toLowerCase().replace(/[^a-z0-9:|_-]+/g, "");
}

export function alertMatchesRoute(
  alert: SwissMappedAlert,
  routeId: string,
  observed: SwissObservedRouteEntry | null,
): boolean {
  const routeKeys = new Set(
    [
      normalizeSwissRouteAlertKey(stripProviderPrefix(routeId)),
      normalizeSwissRouteAlertKey(observed?.route.shortName),
      normalizeSwissRouteAlertKey(observed?.route.longName),
    ].filter((value): value is string => Boolean(value)),
  );
  const directMatch = alert.rawRouteRefs.some((ref) =>
    routeKeys.has(normalizeSwissRouteAlertKey(ref) ?? ""),
  );
  if (directMatch) return true;

  if (!observed?.operatorRefs.length || !alert.rawOperatorRefs.length) return false;
  const observedOperatorKeys = new Set(
    observed.operatorRefs
      .map((value) => normalizeSwissLookupKey(value))
      .filter((value): value is string => Boolean(value)),
  );
  const operatorMatch = alert.rawOperatorRefs.some((ref) =>
    observedOperatorKeys.has(normalizeSwissLookupKey(ref) ?? ""),
  );
  if (!operatorMatch) return false;
  return alert.rawRouteRefs.length === 0 || routeKeys.size === 0;
}
