import type { TransitStop, TransitStopCode, TransportMode } from "@openmapx/mobility-core/transit";
import type { OjpPlace } from "@openmapx/mobility-formats";
import {
  mapSwissMode,
  normalizeText,
  PROVIDER,
  providerId,
  type SwissProviderRuntime,
  swissContributors,
  uniqueModes,
} from "./common.js";
import {
  resolveSwissStopIdentity,
  type SwissServicePoint,
  type SwissStopDatasets,
  type SwissTrafficPoint,
} from "./datasets.js";

export function servicePointModes(
  servicePoint: SwissServicePoint | undefined,
  fallback: string[] = [],
): TransportMode[] {
  return uniqueModes([
    ...fallback.map(mapSwissMode),
    ...(servicePoint?.meansOfTransport ?? []).map(mapSwissMode),
  ]);
}

export function platformCodeFromRef(rawRef: string | undefined): string | undefined {
  if (!rawRef?.startsWith("ch:1:sloid:")) return undefined;
  const parts = rawRef.split(":");
  return parts.length > 4 ? parts.at(-1) || undefined : undefined;
}

export function findServicePoint(
  rawRef: string,
  datasets: SwissStopDatasets,
): {
  didok?: string;
  servicePoint?: SwissServicePoint;
  servicePointSloid?: string;
  stopPoint?: SwissTrafficPoint;
} {
  const identity = resolveSwissStopIdentity(rawRef, datasets);
  const servicePoint = identity.servicePointSloid
    ? datasets.servicePointsBySloid.get(identity.servicePointSloid)
    : undefined;
  const stopPoint = identity.stopPointSloid
    ? datasets.trafficPointsBySloid.get(identity.stopPointSloid)
    : undefined;
  return {
    didok: identity.didok,
    servicePoint,
    servicePointSloid: identity.servicePointSloid,
    stopPoint,
  };
}

export function buildStopIds(
  rawRef: string,
  identity: { didok?: string; servicePointSloid?: string },
): { primaryScheme?: string; ids?: Record<string, string> } {
  const ids: Record<string, string> = { otdch: rawRef };
  let primaryScheme: string | undefined;
  if (rawRef.startsWith("ch:1:sloid:")) {
    ids.sloid = rawRef;
    if (identity.didok) ids.didok = identity.didok;
    primaryScheme = "sloid";
  } else if (identity.didok) {
    ids.didok = identity.didok;
    if (identity.servicePointSloid) ids.sloid = identity.servicePointSloid;
    primaryScheme = "didok";
  }
  return {
    ids,
    primaryScheme,
  };
}

function buildStopCodes(identity: {
  didok?: string;
  servicePointSloid?: string;
  stopPointSloid?: string;
}): TransitStopCode[] | undefined {
  const candidates: TransitStopCode[] = [];
  const didok = identity.didok?.trim();
  const ifopt = (identity.stopPointSloid ?? identity.servicePointSloid)?.trim();
  if (didok && /^\d+$/.test(didok)) candidates.push({ value: didok, namespace: "uic" });
  if (ifopt?.startsWith("ch:1:sloid:")) {
    candidates.push({ value: ifopt, namespace: "ifopt" });
  }
  const unique = [
    ...new Map(candidates.map((code) => [`${code.namespace}:${code.value}`, code])).values(),
  ];
  return unique.length ? unique : undefined;
}

export function buildTransitStopFromServicePoint(
  runtime: SwissProviderRuntime,
  servicePoint: SwissServicePoint,
  rawRef = servicePoint.didok ?? servicePoint.servicePointSloid,
): TransitStop {
  const ids = buildStopIds(rawRef, {
    didok: servicePoint.didok,
    servicePointSloid: servicePoint.servicePointSloid,
  });
  const codes = buildStopCodes({
    didok: servicePoint.didok,
    servicePointSloid: servicePoint.servicePointSloid,
  });
  return {
    contributors: swissContributors(runtime, "master-data"),
    id: providerId(rawRef),
    ...(ids.primaryScheme ? { primaryScheme: ids.primaryScheme } : {}),
    ...(ids.ids ? { ids: ids.ids } : {}),
    ...(codes ? { codes } : {}),
    lat: servicePoint.lat,
    lng: servicePoint.lng,
    modes: servicePointModes(servicePoint),
    name: servicePoint.name,
    provider: PROVIDER,
  };
}

export function buildTransitStopFromTrafficPoint(
  runtime: SwissProviderRuntime,
  trafficPoint: SwissTrafficPoint,
  servicePoint: SwissServicePoint,
): TransitStop {
  const ids = buildStopIds(trafficPoint.sloid, {
    didok: servicePoint.didok,
    servicePointSloid: servicePoint.servicePointSloid,
  });
  const codes = buildStopCodes({
    didok: servicePoint.didok,
    servicePointSloid: servicePoint.servicePointSloid,
    stopPointSloid: trafficPoint.sloid,
  });
  return {
    contributors: swissContributors(runtime, "master-data"),
    id: providerId(trafficPoint.sloid),
    ...(ids.primaryScheme ? { primaryScheme: ids.primaryScheme } : {}),
    ...(ids.ids ? { ids: ids.ids } : {}),
    ...(codes ? { codes } : {}),
    lat: trafficPoint.lat,
    lng: trafficPoint.lng,
    modes: servicePointModes(servicePoint),
    name: trafficPoint.designation
      ? `${servicePoint.name} ${trafficPoint.designation}`
      : trafficPoint.designationOfficial || servicePoint.name,
    parentStationId: providerId(servicePoint.servicePointSloid),
    platformCode: trafficPoint.designation || platformCodeFromRef(trafficPoint.sloid),
    provider: PROVIDER,
  };
}

export function mapOjpPlaceToStop(
  runtime: SwissProviderRuntime,
  place: OjpPlace,
  datasets: SwissStopDatasets,
): TransitStop {
  const rawRef = place.stopPointRef ?? place.stopPlaceRef ?? place.ref;
  const { didok, servicePoint, servicePointSloid, stopPoint } = findServicePoint(rawRef, datasets);
  const ids = buildStopIds(rawRef, { didok, servicePointSloid });
  const codes = buildStopCodes({
    didok,
    servicePointSloid,
    stopPointSloid: stopPoint?.sloid,
  });
  return {
    fieldContributors: {
      id: swissContributors(runtime, "ojp"),
      ids: swissContributors(runtime, "ojp", ...(servicePoint || stopPoint ? ["master-data"] : [])),
      codes: swissContributors(runtime, servicePoint || stopPoint ? "master-data" : "ojp"),
      name: swissContributors(
        runtime,
        place.name
          ? "ojp"
          : stopPoint?.designationOfficial || servicePoint?.name
            ? "master-data"
            : "ojp",
      ),
      lat: swissContributors(
        runtime,
        place.lat ? "ojp" : stopPoint || servicePoint ? "master-data" : "ojp",
      ),
      lng: swissContributors(
        runtime,
        place.lng ? "ojp" : stopPoint || servicePoint ? "master-data" : "ojp",
      ),
      modes: swissContributors(
        runtime,
        "ojp",
        ...(servicePoint?.meansOfTransport?.some(
          (mode) => !place.modes.map(mapSwissMode).includes(mapSwissMode(mode)),
        )
          ? ["master-data"]
          : []),
      ),
      parentStationId: swissContributors(
        runtime,
        ...(place.placeType === "stop_point" && servicePoint ? ["master-data"] : []),
      ),
      platformCode: swissContributors(runtime, "ojp"),
    },
    contributors: swissContributors(
      runtime,
      "ojp",
      ...(servicePoint || stopPoint ? ["master-data"] : []),
    ),
    id: providerId(rawRef),
    ...(ids.primaryScheme ? { primaryScheme: ids.primaryScheme } : {}),
    ...(ids.ids ? { ids: ids.ids } : {}),
    ...(codes ? { codes } : {}),
    lat: place.lat || stopPoint?.lat || servicePoint?.lat || 0,
    lng: place.lng || stopPoint?.lng || servicePoint?.lng || 0,
    modes: servicePointModes(servicePoint, place.modes),
    name: place.name || stopPoint?.designationOfficial || servicePoint?.name || rawRef,
    parentStationId:
      place.placeType === "stop_point" && servicePoint
        ? providerId(servicePoint.servicePointSloid)
        : undefined,
    platformCode: platformCodeFromRef(place.stopPointRef),
    provider: PROVIDER,
  };
}

export function dedupePreferredPlaces(places: OjpPlace[], datasets: SwissStopDatasets): OjpPlace[] {
  const byKey = new Map<string, OjpPlace>();
  for (const place of places) {
    if (!["stop_place", "stop_point"].includes(place.placeType)) continue;
    const rawRef = place.stopPointRef ?? place.stopPlaceRef ?? place.ref;
    const key =
      resolveSwissStopIdentity(rawRef, datasets).servicePointSloid ??
      place.stopPlaceRef ??
      place.stopPointRef ??
      place.ref;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, place);
      continue;
    }
    if (existing.placeType !== "stop_place" && place.placeType === "stop_place") {
      byKey.set(key, place);
      continue;
    }
    if ((place.probability ?? 0) > (existing.probability ?? 0)) {
      byKey.set(key, place);
    }
  }
  return [...byKey.values()];
}

export function matchesStopRef(
  candidate: string | undefined,
  targetRawRef: string | undefined,
  datasets: SwissStopDatasets,
): boolean {
  if (!candidate || !targetRawRef) return false;
  if (candidate === targetRawRef) return true;
  const candidateIdentity = resolveSwissStopIdentity(candidate, datasets);
  const targetIdentity = resolveSwissStopIdentity(targetRawRef, datasets);
  if (
    candidateIdentity.servicePointSloid &&
    targetIdentity.servicePointSloid &&
    candidateIdentity.servicePointSloid === targetIdentity.servicePointSloid
  ) {
    return true;
  }
  return Boolean(
    candidateIdentity.didok &&
      targetIdentity.didok &&
      candidateIdentity.didok === targetIdentity.didok,
  );
}

export function stopMatchKeys(rawRef: string | undefined, datasets: SwissStopDatasets): string[] {
  const normalized = normalizeText(rawRef);
  if (!normalized) return [];
  const keys = new Set<string>([normalized]);
  const identity = resolveSwissStopIdentity(normalized, datasets);
  if (identity.didok) keys.add(identity.didok);
  if (identity.servicePointSloid) keys.add(identity.servicePointSloid);
  if (/^\d+:[^:]+/.test(normalized)) {
    keys.add(normalized.split(":")[0] || normalized);
  }
  return [...keys];
}
