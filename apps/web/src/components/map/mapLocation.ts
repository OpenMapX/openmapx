import { coordinateId, createPlace, type Place } from "@openmapx/core";
import type { StylePoiTarget } from "./mapStylePoiTarget";

/**
 * A point the user picked on the map, by right-click or by long-press, and the
 * basemap place under it if there is one. The desktop context menu and the
 * dropped-pin card describe it the same way through these helpers.
 */
export interface MapLocation {
  coordinates: [number, number];
  poi: StylePoiTarget | null;
}

interface ReverseGeocoded {
  address?: string | null;
  city?: string | null;
}

export interface MapLocationText {
  /** Latitude, longitude to six decimals. */
  coordinates: string;
  /** What the location is called: the place's name, else where it is. */
  title: string;
  /** Its address, else its coordinates. */
  address: string;
  /** The label a route to or from it carries. */
  routeLabel: string;
}

export function formatMapCoordinates([lng, lat]: [number, number]): string {
  return `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
}

export function describeMapLocation(
  { coordinates, poi }: MapLocation,
  reverse: ReverseGeocoded | null | undefined,
): MapLocationText {
  const label = formatMapCoordinates(coordinates);
  return {
    coordinates: label,
    title: poi?.name || reverse?.city || reverse?.address || label,
    address: reverse?.address || label,
    routeLabel: poi?.name || reverse?.address || label,
  };
}

/** The location as a place: the basemap place under it, else the bare point. */
export function mapLocationPlace(
  location: MapLocation,
  reverse: ReverseGeocoded | null | undefined,
): Place {
  const text = describeMapLocation(location, reverse);
  const { poi } = location;
  if (poi) {
    return createPlace({
      primaryScheme: "stylePoi",
      ids: { stylePoi: poi.featureId },
      name: poi.name,
      address: reverse?.address || poi.name,
      coordinates: poi.coordinates,
      category: poi.category,
      rawCategory: poi.rawCategory,
    });
  }
  return createPlace({
    primaryScheme: "coordinate",
    ids: { coordinate: coordinateId(location.coordinates) },
    name: text.title,
    address: text.address,
    coordinates: location.coordinates,
  });
}

export interface MapLocationCopyRow {
  label: string;
  value: string;
}

/** What can be copied about the location, without repeating a value. */
export function mapLocationCopyRows(
  location: MapLocation,
  reverse: ReverseGeocoded | null | undefined,
  labels: { coordinates: string; name: string; address: string },
): MapLocationCopyRow[] {
  const candidates = [
    { label: labels.coordinates, value: formatMapCoordinates(location.coordinates) },
    ...(location.poi?.name ? [{ label: labels.name, value: location.poi.name }] : []),
    ...(reverse?.address ? [{ label: labels.address, value: reverse.address }] : []),
  ];
  const seen = new Set<string>();
  return candidates.filter(({ value }) => {
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}
