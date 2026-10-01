import { haversineDistance, type LngLat } from "@openmapx/core";
import type { FilterSpecification, SymbolLayerSpecification } from "maplibre-gl";

export const STOP_LABEL_SOURCE_ID = "transit-stop-labels";
export const STOP_LABEL_LAYER_ID = "poi-transit-stop-labels";

/** The transport label colour and halo of the bundled light and dark styles. */
export const STOP_LABEL_COLOURS = {
  light: { text: "#3f6d8f", halo: "rgba(255,255,255,0.8)" },
  dark: { text: "#7aa4c4", halo: "rgba(11, 15, 20, 0.85)" },
} as const;

/** The bundled styles' rank limit for stops: a few from z16, every one from z19. */
export const STOP_RANK_LIMIT = [
  "step",
  ["zoom"],
  0,
  14,
  0,
  15,
  0,
  16,
  4,
  17,
  10,
  18,
  30,
  19,
  9999,
  20,
  9999,
] as const;

/**
 * Text only, sitting under the stop's icon from the basemap. A stop named after
 * a station waits until z18, where the platforms are far enough apart that
 * their own names tell them apart; further out the station's label covers it.
 */
export function stopLabelLayer(dark: boolean): Omit<SymbolLayerSpecification, "id"> {
  const colours = dark ? STOP_LABEL_COLOURS.dark : STOP_LABEL_COLOURS.light;
  return {
    type: "symbol",
    source: STOP_LABEL_SOURCE_ID,
    minzoom: 16,
    filter: [
      "all",
      ["<=", ["get", "rank"], STOP_RANK_LIMIT],
      ["any", ["!", ["get", "nearStation"]], [">=", ["zoom"], 18]],
    ] as unknown as FilterSpecification,
    layout: {
      "text-field": ["get", "name"],
      "text-font": ["Noto Sans Regular"],
      "text-size": 11,
      // Clear of the icon's collision box, on whichever side has room.
      "text-variable-anchor": ["top", "left", "right"],
      "text-radial-offset": 1.25,
      "text-max-width": 9,
      "text-padding": 2,
    },
    paint: {
      "text-color": colours.text,
      "text-halo-color": colours.halo,
      "text-halo-width": 1,
      "text-halo-blur": 0.5,
    },
  };
}

/** Platforms of one stop sit a street crossing apart; two stops of one name are further. */
const SAME_STOP_METRES = 300;
/** A stop this close to a station of the same name is part of that station. */
const STATION_METRES = 450;

export interface StopPoint {
  id: number | undefined;
  name: string;
  poiClass: string;
  subclass?: string;
  rank: number;
  coordinates: LngLat;
}

export interface StationPoint {
  name: string;
  coordinates: LngLat;
}

export interface StopLabelFeature {
  type: "Feature";
  id?: number;
  geometry: { type: "Point"; coordinates: LngLat };
  properties: {
    name: string;
    class: string;
    subclass?: string;
    rank: number;
    nearStation: boolean;
  };
}

function nameKey(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * The place a stop is named after, without the mode prefix and the street
 * after the slash: "S+U Alexanderplatz Bhf/Memhardstraße" → "alexanderplatz".
 */
export function stopPlaceName(name: string): string {
  return nameKey(
    (name.split("/")[0] ?? name)
      .replace(/\([^)]*\)/g, " ")
      .replace(/^\s*(?:s\s*\+\s*u|u\s*\+\s*s|s|u|[su]-bhf\.?|bhf\.?|bahnhof)\s+/i, "")
      .replace(/\s+(?:bhf\.?|bahnhof|station)\s*$/i, ""),
  );
}

function namedAfter(stopPlace: string, stationName: string): boolean {
  const station = stopPlaceName(stationName);
  if (!stopPlace || !station) return false;
  // "Berlin Alexanderplatz" is the same station as "Alexanderplatz".
  return (
    station === stopPlace || station.endsWith(` ${stopPlace}`) || stopPlace.endsWith(` ${station}`)
  );
}

/**
 * One label point per stop: platforms that share a name within a short walk
 * collapse onto the most prominent one, and a stop named after a nearby
 * station is flagged so the map can leave its name to the station's label.
 */
export function stopLabelFeatures(
  stops: readonly StopPoint[],
  stations: readonly StationPoint[],
): StopLabelFeature[] {
  const ordered = [...stops].sort((a, b) => a.rank - b.rank || (a.id ?? 0) - (b.id ?? 0));
  const groups: { key: string; anchor: StopPoint; rank: number }[] = [];
  for (const stop of ordered) {
    const key = nameKey(stop.name);
    const group = groups.find(
      (candidate) =>
        candidate.key === key &&
        haversineDistance(candidate.anchor.coordinates, stop.coordinates) <= SAME_STOP_METRES,
    );
    if (group) group.rank = Math.min(group.rank, stop.rank);
    else groups.push({ key, anchor: stop, rank: stop.rank });
  }

  return groups.map(({ anchor, rank }) => {
    const place = stopPlaceName(anchor.name);
    const nearStation = stations.some(
      (station) =>
        namedAfter(place, station.name) &&
        haversineDistance(station.coordinates, anchor.coordinates) <= STATION_METRES,
    );
    return {
      type: "Feature",
      ...(anchor.id === undefined ? {} : { id: anchor.id }),
      geometry: { type: "Point", coordinates: anchor.coordinates },
      properties: {
        name: anchor.name,
        class: anchor.poiClass,
        ...(anchor.subclass ? { subclass: anchor.subclass } : {}),
        rank,
        nearStation,
      },
    };
  });
}
