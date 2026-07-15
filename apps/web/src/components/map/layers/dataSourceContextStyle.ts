import type maplibregl from "maplibre-gl";

const LIGHT = {
  no_ride: "#C62828",
  no_parking: "#EF6C00",
  no_start: "#8E24AA",
  slow_zone: "#1565C0",
  parking_hub: "#2E7D32",
  station_area: "#388E3C",
  fallback: "#546E7A",
};

const DARK = {
  no_ride: "#EF5350",
  no_parking: "#FFA726",
  no_start: "#CE93D8",
  slow_zone: "#64B5F6",
  parking_hub: "#81C784",
  station_area: "#A5D6A7",
  fallback: "#B0BEC5",
};

export function contextColorExpression(dark: boolean): maplibregl.ExpressionSpecification {
  const colors = dark ? DARK : LIGHT;
  return [
    "match",
    ["get", "zoneClass"],
    "no_ride",
    colors.no_ride,
    "no_parking",
    colors.no_parking,
    "no_start",
    colors.no_start,
    "slow_zone",
    colors.slow_zone,
    "parking_hub",
    colors.parking_hub,
    "station_area",
    colors.station_area,
    colors.fallback,
  ] as maplibregl.ExpressionSpecification;
}

export const contextFillOpacityExpression = [
  "match",
  ["get", "zoneClass"],
  "no_ride",
  0.16,
  "no_parking",
  0.12,
  "no_start",
  0.1,
  "slow_zone",
  0.08,
  "parking_hub",
  0.08,
  "station_area",
  0.06,
  0.08,
] as maplibregl.ExpressionSpecification;

export const contextLineWidthExpression = [
  "match",
  ["get", "zoneClass"],
  "no_ride",
  2.5,
  "no_parking",
  2.25,
  "station_area",
  1.25,
  2,
] as maplibregl.ExpressionSpecification;

export const contextSortKeyExpression = [
  "coalesce",
  ["get", "z"],
  0,
] as maplibregl.ExpressionSpecification;
