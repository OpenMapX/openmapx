import type {
  BoundingBox,
  DataSourceMapContext,
  DataSourceMapContextSelection,
} from "@openmapx/core";
import { buildEnturGeofencingMapContext } from "@openmapx/mobility-core/entur-mobility";
import type { MobilityHttpTransport } from "@openmapx/mobility-core/json-transport";
import {
  applicableMobilityRules,
  classifyMobilityRules,
  normalizeAndClipMobilityGeometry,
} from "@openmapx/mobility-core/mobility-context-geometry";
import { fetchMotisRentals } from "@openmapx/mobility-core/motis-rentals";
import type {
  MotisRentalSnapshot,
  SharedMobilityRestriction,
  VehicleFormFactor,
} from "@openmapx/mobility-core/shared-mobility";

function selected(value: string, values: ReadonlySet<string>): boolean {
  return values.size === 0 || values.has(value);
}

function ruleProperties(rules: SharedMobilityRestriction[]) {
  return {
    rideStartAllowed: rules.every((rule) => rule.rideStartAllowed),
    rideEndAllowed: rules.every((rule) => rule.rideEndAllowed),
    rideThroughAllowed: rules.every((rule) => rule.rideThroughAllowed),
    stationParking: rules.some((rule) => rule.stationParking === true),
  };
}

function buildMotisFeatures(
  snapshot: MotisRentalSnapshot,
  bbox: BoundingBox,
  options: DataSourceMapContextSelection,
): DataSourceMapContext["geojson"]["features"] {
  const selectedProviders = new Set(options.providerIds ?? []);
  const selectedGroups = new Set(options.providerGroupIds ?? []);
  const selectedTypes = new Set(options.vehicleTypeIds ?? []);
  const selectedForms = new Set(options.formFactors ?? []);
  const providerById = new Map(snapshot.providers.map((provider) => [provider.id, provider]));
  const groupById = new Map(snapshot.providerGroups.map((group) => [group.id, group]));
  const features: DataSourceMapContext["geojson"]["features"] = [];

  for (const zone of snapshot.zones) {
    const provider = providerById.get(zone.providerId);
    if (!provider) continue;
    if (!selected(zone.providerId, selectedProviders)) continue;
    if (!selected(zone.providerGroupId, selectedGroups)) continue;
    if (
      selectedForms.size > 0 &&
      !provider.formFactors.some((formFactor) => selectedForms.has(formFactor))
    ) {
      continue;
    }
    const rules = applicableMobilityRules(zone.rules, selectedTypes);
    const classification = classifyMobilityRules(rules);
    if (!classification) continue;
    const geometry = normalizeAndClipMobilityGeometry(zone.area, bbox);
    if (!geometry) continue;
    features.push({
      type: "Feature",
      geometry,
      properties: {
        contextKind: "restriction_zone",
        contextId: zone.id,
        providerId: zone.providerId,
        providerName: provider.name,
        providerGroupId: zone.providerGroupId,
        providerGroupName: groupById.get(zone.providerGroupId)?.name ?? null,
        zoneName: zone.name ?? null,
        zoneClass: classification.zoneClass,
        z: zone.z,
        formFactors: provider.formFactors,
        vehicleTypeIds: [...new Set(rules.flatMap((rule) => rule.vehicleTypeIds))].sort(),
        ...ruleProperties(rules),
      },
    });
  }

  for (const station of snapshot.stations) {
    if (!station.stationArea) continue;
    if (station.providerId && !selected(station.providerId, selectedProviders)) continue;
    if (station.providerGroupId && !selected(station.providerGroupId, selectedGroups)) continue;
    if (
      selectedForms.size > 0 &&
      !station.vehicleTypes.some((formFactor) => selectedForms.has(formFactor))
    ) {
      continue;
    }
    if (
      selectedTypes.size > 0 &&
      !(station.vehicleTypeIds ?? []).some((typeId) => selectedTypes.has(typeId))
    ) {
      continue;
    }
    const geometry = normalizeAndClipMobilityGeometry(station.stationArea, bbox);
    if (!geometry) continue;
    const provider = station.providerId ? providerById.get(station.providerId) : undefined;
    features.push({
      type: "Feature",
      geometry,
      properties: {
        contextKind: "station_area",
        contextId: `station-area:${station.id}`,
        stationId: `s:${station.id}`,
        stationName: station.name,
        providerId: station.providerId ?? null,
        providerName: station.providerName ?? provider?.name ?? null,
        providerGroupId: station.providerGroupId ?? null,
        providerGroupName: station.providerGroupName ?? null,
        zoneClass: "station_area",
        z: 0,
        formFactors: station.vehicleTypes,
        vehicleTypeIds: station.vehicleTypeIds ?? [],
        rideStartAllowed: station.isRenting ?? null,
        rideEndAllowed: station.isReturning ?? null,
        rideThroughAllowed: true,
        stationParking: true,
      },
    });
  }

  return features.sort((left, right) => {
    const leftZ = typeof left.properties?.z === "number" ? left.properties.z : 0;
    const rightZ = typeof right.properties?.z === "number" ? right.properties.z : 0;
    if (leftZ !== rightZ) return leftZ - rightZ;
    return String(left.properties?.contextId).localeCompare(String(right.properties?.contextId));
  });
}

export async function buildSharedMobilityMapContext(
  bbox: BoundingBox,
  categoryFormFactors: ReadonlySet<VehicleFormFactor>,
  transport: MobilityHttpTransport,
  options: DataSourceMapContextSelection = {},
): Promise<DataSourceMapContext | null> {
  const formFactors = (options.formFactors ?? [...categoryFormFactors]).filter((factor) =>
    categoryFormFactors.has(factor as VehicleFormFactor),
  ) as VehicleFormFactor[];
  const snapshot = await fetchMotisRentals(
    [bbox.west, bbox.south, bbox.east, bbox.north],
    formFactors,
  );
  const effectiveOptions = { ...options, formFactors };
  const motisFeatures = buildMotisFeatures(snapshot, bbox, effectiveOptions);
  const nativeSystemIdByProviderId = new Map(
    snapshot.providers.map((provider) => [provider.id, provider.nativeId]),
  );
  const motisRestrictionSystemIds = new Set(
    motisFeatures
      .filter((feature) => feature.properties?.contextKind === "restriction_zone")
      .map((feature) => nativeSystemIdByProviderId.get(String(feature.properties?.providerId)))
      .filter((systemId): systemId is string => !!systemId),
  );
  // A station area alone does not mean MOTIS has the provider's restriction
  // context. Keep Entur's explicit slow-zone enrichment for selected systems
  // until MOTIS exposes maximum-speed rules itself.
  const uncoveredSystemIds = (options.systemIds ?? []).filter(
    (id) => !motisRestrictionSystemIds.has(id),
  );
  const needsEntur =
    !snapshot.completeness.zones ||
    (options.systemIds?.length ? uncoveredSystemIds.length > 0 : motisFeatures.length === 0);
  const entur = needsEntur
    ? await buildEnturGeofencingMapContext(bbox, {
        transport,
        systemIds: options.systemIds?.length ? uncoveredSystemIds : undefined,
        vehicleTypeIds: options.vehicleTypeIds,
      })
    : null;
  const byIdentity = new Map<string, DataSourceMapContext["geojson"]["features"][number]>();
  for (const feature of [...motisFeatures, ...(entur?.geojson.features ?? [])]) {
    const properties = feature.properties ?? {};
    const identity = String(
      properties.contextId ??
        `${properties.contextKind}:${properties.providerId ?? properties.systemId}:${properties.zoneName}:${properties.zoneClass}`,
    );
    if (!byIdentity.has(identity)) byIdentity.set(identity, feature);
  }
  const features = [...byIdentity.values()];
  return features.length > 0 ? { geojson: { type: "FeatureCollection", features } } : null;
}
