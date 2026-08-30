import { readFileSync } from "node:fs";

import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import type { Feature, FeatureCollection, Geometry, Point } from "geojson";

import metadata from "../data/jurisdiction/metadata.json";
import type { AirQualityProgramId, AirQualityStandardId } from "../types";
import type { JurisdictionFeatureProperties } from "./generate";
import { resolveProgramEntry } from "./registry";

export interface JurisdictionResolution {
  countryCode: string | null;
  subdivisionCode: string | null;
  programId: AirQualityProgramId | null;
  localStandardId: AirQualityStandardId | null;
  resolution: "boundary-artifact" | "ambiguous" | "unresolved";
  resolverId: string;
  resolverRevision: string;
  requestHintMatched: boolean | null;
  requiresCommunityMatch: boolean;
}

const artifact = JSON.parse(
  readFileSync(new URL("../data/jurisdiction/supported.geojson", import.meta.url), "utf8"),
) as FeatureCollection<Geometry, JurisdictionFeatureProperties>;

function contains(
  feature: Feature<Geometry, JurisdictionFeatureProperties>,
  point: Feature<Point>,
): boolean {
  const [longitude, latitude] = point.geometry.coordinates;
  const bbox = feature.bbox;
  if (
    bbox &&
    (longitude < bbox[0] || latitude < bbox[1] || longitude > bbox[2] || latitude > bbox[3])
  )
    return false;
  return feature.geometry.type === "Polygon" || feature.geometry.type === "MultiPolygon"
    ? booleanPointInPolygon(point, feature as Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>)
    : false;
}

export function resolveJurisdiction(input: {
  latitude: number;
  longitude: number;
  at: string;
  countryHint?: string;
  subdivisionHint?: string;
}): JurisdictionResolution {
  if (
    !Number.isFinite(input.latitude) ||
    input.latitude < -90 ||
    input.latitude > 90 ||
    !Number.isFinite(input.longitude) ||
    input.longitude < -180 ||
    input.longitude > 180
  )
    throw new RangeError("Coordinates are outside WGS84 bounds");
  const point: Feature<Point> = {
    type: "Feature",
    properties: {},
    geometry: { type: "Point", coordinates: [input.longitude, input.latitude] },
  };
  const base = { resolverId: metadata.resolverId, resolverRevision: metadata.resolverRevision };
  if (
    artifact.features.some(
      (feature) => feature.properties.kind === "ambiguous" && contains(feature, point),
    )
  )
    return {
      ...base,
      countryCode: null,
      subdivisionCode: null,
      programId: null,
      localStandardId: null,
      resolution: "ambiguous",
      requestHintMatched: null,
      requiresCommunityMatch: false,
    };
  const countries = artifact.features.filter(
    (feature) => feature.properties.kind === "country" && contains(feature, point),
  );
  const countryCodes = [
    ...new Set(
      countries
        .map((feature) => feature.properties.countryCode)
        .filter((value): value is string => value !== null),
    ),
  ];
  if (countryCodes.length > 1)
    return {
      ...base,
      countryCode: null,
      subdivisionCode: null,
      programId: null,
      localStandardId: null,
      resolution: "ambiguous",
      requestHintMatched: null,
      requiresCommunityMatch: false,
    };
  const countryCode = countryCodes[0] ?? null;
  if (!countryCode)
    return {
      ...base,
      countryCode: null,
      subdivisionCode: null,
      programId: null,
      localStandardId: null,
      resolution: "unresolved",
      requestHintMatched: input.countryHint ? false : null,
      requiresCommunityMatch: false,
    };
  const subdivisionCode =
    artifact.features.find(
      (feature) =>
        feature.properties.kind === "subdivision" &&
        feature.properties.countryCode === countryCode &&
        contains(feature, point),
    )?.properties.subdivisionCode ?? null;
  const hintMatched =
    input.countryHint === undefined && input.subdivisionHint === undefined
      ? null
      : (input.countryHint === undefined || input.countryHint.toUpperCase() === countryCode) &&
        (input.subdivisionHint === undefined ||
          input.subdivisionHint.toUpperCase() === subdivisionCode);
  const entry =
    hintMatched === false ? null : resolveProgramEntry(countryCode, subdivisionCode, input.at);
  return {
    ...base,
    countryCode,
    subdivisionCode,
    programId: entry?.programId ?? null,
    localStandardId: entry?.standardId ?? null,
    resolution: "boundary-artifact",
    requestHintMatched: hintMatched,
    requiresCommunityMatch: entry?.requiresCommunityMatch ?? false,
  };
}
