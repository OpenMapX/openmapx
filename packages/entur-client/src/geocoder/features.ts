import type { TransportMode } from "@openmapx/mobility-core/transit";
import type { EnturGeocoderFeature } from "./client";

/** Preserve native identity; only NSR has a separate canonical identity scheme. */
export function geocoderFeatureIdentity(feature: EnturGeocoderFeature): {
  nativeId: string;
  primaryScheme: string;
  ids: Record<string, string>;
} {
  const nativeId = feature.properties.id;
  return nativeId.startsWith("NSR:")
    ? { nativeId, primaryScheme: "nsr", ids: { entur: nativeId, nsr: nativeId.slice(4) } }
    : { nativeId, primaryScheme: "entur", ids: { entur: nativeId } };
}

export function geocoderFeatureCoordinates(
  feature: EnturGeocoderFeature,
): [longitude: number, latitude: number] | undefined {
  const coordinates = feature.geometry.coordinates;
  if (coordinates.length !== 2) return undefined;
  const [lon, lat] = coordinates;
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lon) > 180 || Math.abs(lat) > 90)
    return undefined;
  return [lon, lat];
}

const modes: Readonly<Record<string, TransportMode>> = {
  bus: "bus",
  coach: "bus",
  trolleyBus: "bus",
  rail: "rail",
  metro: "subway",
  tram: "tram",
  water: "ferry",
  ferry: "ferry",
  cableway: "cable_car",
  funicular: "funicular",
  monorail: "monorail",
  lift: "gondola",
};
const stopTypes: Readonly<Record<string, TransportMode>> = {
  railStation: "rail",
  vehicleRailInterchange: "rail",
  metroStation: "subway",
  tramStation: "tram",
  onstreetTram: "tram",
  busStation: "bus",
  coachStation: "bus",
  onstreetBus: "bus",
  ferryPort: "ferry",
  ferryStop: "ferry",
  harbourPort: "ferry",
  liftStation: "gondola",
};

/** Unknown native values remain unknown instead of acquiring a default bus mode. */
export function geocoderFeatureModes(feature: EnturGeocoderFeature): TransportMode[] {
  const result = new Set<TransportMode>();
  for (const { mode } of feature.properties.transportModes ?? []) {
    if (Object.hasOwn(modes, mode)) result.add(modes[mode]);
  }
  for (const type of feature.properties.stopPlaceTypes ?? []) {
    if (Object.hasOwn(stopTypes, type)) result.add(stopTypes[type]);
  }
  return [...result];
}
