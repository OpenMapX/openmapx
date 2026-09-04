import { takeLocalGarage } from "@openmapx/core";
import { readNavigationSession } from "./navigation/navigationSessionStorage";
import { createOfflinePackageStorage, type OfflinePackageRecord } from "./offlineAreas";

/** Browser-only data that is not held by OpenMapX. Keep this allowlist small:
 * never serialize cookies, tokens, query caches, raw offline archives or
 * arbitrary localStorage keys. */
export const PRIVACY_DEVICE_EXPORT_VERSION = 1 as const;
export const PRIVACY_DEVICE_EXPORT_MAX_BYTES = 512 * 1024;
const MAX_ACTIVE_NAVIGATION_BYTES = 128 * 1024;
const MAX_STRING_BYTES = 1_024;

function containsUnsafeControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

const PREFERENCE_KEYS = [
  "openmapx:unitSystem",
  "openmapx:timeFormat",
  "openmapx:dateFormat",
  "openmapx:voiceGuidanceTiming",
  "openmapx:speedCameraAlerts",
  "openmapx:aiSearch",
  "openmapx:incidentAlerts",
  "openmapx:avoidIncidents",
  "openmapx:nav:fasterRoutes",
  "openmapx:nav:autoSwitchFasterRoutes",
  "openmapx:nav:voiceEnabled",
  "openmapx:nav:keepScreenOn",
  "openmapx:avoidHighways",
  "openmapx:avoidTolls",
  "openmapx:avoidFerries",
  "openmapx:voiceName",
  "openmapx:mapNorthUp",
  "openmapx:globeView",
  "openmapx-haptics-enabled",
  "openmapx.nlp.cloudConsent",
  "openmapx:evVehicleId",
  "openmapx:evSocTargetPct",
  "openmapx:evPreferredNetworks",
  "openmapx:evAvoidedNetworks",
  "openmapx:evExclusiveNetworks",
  "openmapx:evPreferCheaper",
  "openmapx:evHomePricePerKwh",
  "openmapx:evHomeCurrency",
  "openmapx-recent-map-data-cache-enabled",
] as const;

function safeString(value: unknown, max = 512): string | null {
  if (typeof value !== "string" || value.length > max || containsUnsafeControlCharacters(value))
    return null;
  return value;
}

function finiteNumber(value: unknown, minimum = Number.NEGATIVE_INFINITY): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum ? value : null;
}

function isoFromMillis(value: unknown): string | null {
  const number = finiteNumber(value, 0);
  if (number === null) return null;
  const date = new Date(number);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function coordinate(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const lng = finiteNumber(value[0]);
  const lat = finiteNumber(value[1]);
  if (lng === null || lat === null || lng < -180 || lng > 180 || lat < -90 || lat > 90) return null;
  return [lng, lat];
}

function safeText(value: unknown): string | null {
  return safeString(value, MAX_STRING_BYTES);
}

function localGarageSnapshot() {
  const garage = takeLocalGarage();
  const vehicles = garage.vehicles.slice(0, 256).map((vehicle) => ({
    id: safeText(vehicle.id),
    name: safeText(vehicle.name),
    kind: safeText(vehicle.kind),
    powertrain: safeText(vehicle.powertrain),
    isDefault: vehicle.isDefault === true,
    presetId: safeText(vehicle.presetId),
    ev: vehicle.ev
      ? {
          batteryKwh: finiteNumber(vehicle.ev.batteryKwh, 0),
          baseWhPerKm: finiteNumber(vehicle.ev.baseWhPerKm, 0),
          massTonnes: finiteNumber(vehicle.ev.massTonnes, 0),
          maxDcKw: finiteNumber(vehicle.ev.maxDcKw, 0),
          maxAcKw: finiteNumber(vehicle.ev.maxAcKw, 0),
          vehicleTaperSocPct: finiteNumber(vehicle.ev.vehicleTaperSocPct, 0),
          connectors: vehicle.ev.connectors
            .slice(0, 16)
            .map((entry) => safeText(entry))
            .filter((entry): entry is string => entry !== null),
        }
      : null,
    fuelConsumptionLPer100Km: finiteNumber(vehicle.fuelConsumptionLPer100Km, 0),
    createdAt: safeText(vehicle.createdAt),
    updatedAt: safeText(vehicle.updatedAt),
  }));
  const parked = garage.parked.slice(0, 256).map((location) => ({
    id: safeText(location.id),
    vehicleId: safeText(location.vehicleId),
    coordinates: coordinate([location.lng, location.lat]),
    address: safeText(location.address),
    note: safeText(location.note),
    expiresAt: safeText(location.expiresAt),
    source: safeText(location.source),
    accuracyMeters: finiteNumber(location.accuracyMeters, 0),
    savedAt: safeText(location.savedAt),
    updatedAt: safeText(location.updatedAt),
  }));
  return { vehicles, parked };
}

function sampleCoordinates(values: unknown): Array<[number, number]> {
  if (!Array.isArray(values)) return [];
  const all = values.map(coordinate).filter((entry): entry is [number, number] => entry !== null);
  if (all.length <= 256) return all;
  const step = (all.length - 1) / 255;
  return Array.from({ length: 256 }, (_, index) => all[Math.round(index * step)]).filter(
    (entry): entry is [number, number] => entry !== undefined,
  );
}

function activeNavigationSnapshot(snapshot: Awaited<ReturnType<typeof readNavigationSession>>) {
  if (!snapshot) return null;
  const route = snapshot.route;
  const summary = {
    schemaVersion: snapshot.schemaVersion,
    kind: snapshot.kind,
    mode: snapshot.mode,
    routeProvider: safeText(snapshot.routeProvider),
    routeFingerprint: safeText(snapshot.routeFingerprint),
    startedAt: isoFromMillis(snapshot.startedAtMs),
    updatedAt: isoFromMillis(snapshot.updatedAtMs),
    route: {
      distance: finiteNumber(route.distance, 0),
      duration: finiteNumber(route.duration, 0),
      pointCount: Array.isArray(route.geometry) ? route.geometry.length : 0,
      geometry: sampleCoordinates(route.geometry),
    },
    alternatives: snapshot.routes.slice(0, 8).map((alternative) => ({
      distance: finiteNumber(alternative.distance, 0),
      duration: finiteNumber(alternative.duration, 0),
      pointCount: Array.isArray(alternative.geometry) ? alternative.geometry.length : 0,
    })),
    activeRouteIndex: snapshot.activeRouteIndex,
    routeSelectionIntent: snapshot.routeSelectionIntent,
    routeOptions: {
      avoidHighways: snapshot.routeOptions.avoidHighways,
      avoidTolls: snapshot.routeOptions.avoidTolls,
      avoidFerries: snapshot.routeOptions.avoidFerries,
      avoidClosures: snapshot.routeOptions.avoidClosures,
    },
    destinationWaypoints: snapshot.destinationWaypoints
      .slice(0, 32)
      .map(coordinate)
      .filter((entry): entry is [number, number] => entry !== null),
    progress: snapshot.progress
      ? {
          currentStepIndex: snapshot.progress.currentStepIndex,
          distanceToNextManeuver: finiteNumber(snapshot.progress.distanceToNextManeuver, 0),
          distanceRemaining: finiteNumber(snapshot.progress.distanceRemaining, 0),
          durationRemaining: finiteNumber(snapshot.progress.durationRemaining, 0),
          snapped: coordinate(snapshot.progress.snapped),
          alongMeters: finiteNumber(snapshot.progress.alongMeters, 0),
          deviationMeters: finiteNumber(snapshot.progress.deviationMeters, 0),
          segmentIndex: snapshot.progress.segmentIndex,
          eta: isoFromMillis(snapshot.progress.etaEpochMs),
          bearing: finiteNumber(snapshot.progress.bearing),
          speedMps: finiteNumber(snapshot.progress.speedMps, 0),
        }
      : null,
    packageIds: snapshot.packageIds
      .slice(0, 64)
      .map(safeText)
      .filter((entry): entry is string => entry !== null),
    lastKnownPosition: snapshot.lastKnownPosition
      ? {
          coordinates: coordinate(snapshot.lastKnownPosition.coords),
          timestamp: isoFromMillis(snapshot.lastKnownPosition.timestampMs),
        }
      : null,
  };
  const encoded = JSON.stringify(summary);
  return Buffer.byteLength(encoded, "utf8") <= MAX_ACTIVE_NAVIGATION_BYTES ? summary : null;
}

function devicePackage(record: OfflinePackageRecord) {
  const coverage = record.manifest.coverage;
  return {
    id: record.id,
    name: record.name.slice(0, 256),
    status: record.status,
    bytesReceived: record.bytesReceived,
    bytesTotal: record.bytesTotal,
    verifiedPrefixBytes: record.verifiedPrefixBytes,
    createdAt: new Date(record.createdAt).toISOString(),
    updatedAt: new Date(record.updatedAt).toISOString(),
    ...(record.downloadedAt ? { downloadedAt: new Date(record.downloadedAt).toISOString() } : {}),
    coverage: {
      bbox: coverage.bbox,
      minZoom: coverage.minZoom,
      maxZoom: coverage.maxZoom,
    },
  };
}

export interface PrivacyDeviceExport {
  version: typeof PRIVACY_DEVICE_EXPORT_VERSION;
  generatedAt: string;
  source: "browser-device";
  note: string;
  preferences: Record<string, string>;
  localGarage: ReturnType<typeof localGarageSnapshot>;
  activeNavigation: ReturnType<typeof activeNavigationSnapshot>;
  offlinePackages: ReturnType<typeof devicePackage>[];
}

export async function collectPrivacyDeviceData(now = new Date()): Promise<PrivacyDeviceExport> {
  const preferences: Record<string, string> = {};
  if (typeof window !== "undefined") {
    for (const key of PREFERENCE_KEYS) {
      const value = safeString(window.localStorage.getItem(key));
      if (value !== null) preferences[key] = value;
    }
  }
  let offlinePackages: ReturnType<typeof devicePackage>[] = [];
  try {
    const records = await createOfflinePackageStorage().list();
    offlinePackages = records.slice(0, 256).map(devicePackage);
  } catch {
    offlinePackages = [];
  }
  let localGarage: ReturnType<typeof localGarageSnapshot> = { vehicles: [], parked: [] };
  try {
    localGarage = localGarageSnapshot();
  } catch {
    /* corrupt local values are omitted */
  }
  let activeNavigation: ReturnType<typeof activeNavigationSnapshot> = null;
  try {
    activeNavigation = activeNavigationSnapshot(await readNavigationSession());
  } catch {
    activeNavigation = null;
  }
  const result: PrivacyDeviceExport = {
    version: PRIVACY_DEVICE_EXPORT_VERSION,
    generatedAt: now.toISOString(),
    source: "browser-device",
    note: "This supplement contains only an allowlisted snapshot from this browser/device: preferences, local garage and parked state, a bounded active navigation session, and offline-map metadata. It is not uploaded to OpenMapX; caches, downloaded map bytes, credentials, session state, query history and unknown storage are intentionally excluded.",
    preferences,
    localGarage,
    activeNavigation,
    offlinePackages,
  };
  // The final object is built exclusively from the allowlists above. Keep a
  // hard output bound so a future local record cannot turn the download into
  // an unbounded browser-memory operation.
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > PRIVACY_DEVICE_EXPORT_MAX_BYTES) {
    result.activeNavigation = null;
    result.offlinePackages = result.offlinePackages.slice(0, 32);
  }
  return result;
}

export async function downloadPrivacyDeviceData(): Promise<void> {
  const data = await collectPrivacyDeviceData();
  const blob = new Blob([`${JSON.stringify(data, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = `openmapx-device-data-${new Date().toISOString().slice(0, 10)}.json`;
    link.rel = "noopener";
    link.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}
