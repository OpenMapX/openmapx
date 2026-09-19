import type * as maplibregl from "maplibre-gl";

export const CONTEXT_ZONE_CLASSES = [
  "no_ride",
  "no_parking",
  "no_start",
  "parking_hub",
  "slow_zone",
  "station_area",
] as const;

export type ContextZoneClass = (typeof CONTEXT_ZONE_CLASSES)[number];

interface ContextZoneStyle {
  light: string;
  dark: string;
  fillOpacity: number;
  lineWidth: number;
}

/**
 * One entry per zone class, shared by the map layers and the legend swatches
 * so the two cannot drift apart. Station areas are teal rather than a second
 * green so the legend can tell them apart from station parking.
 */
export const CONTEXT_ZONE_STYLES: Record<ContextZoneClass, ContextZoneStyle> = {
  no_ride: { light: "#C62828", dark: "#EF5350", fillOpacity: 0.16, lineWidth: 2.5 },
  no_parking: { light: "#EF6C00", dark: "#FFA726", fillOpacity: 0.12, lineWidth: 2.25 },
  no_start: { light: "#8E24AA", dark: "#CE93D8", fillOpacity: 0.1, lineWidth: 2 },
  parking_hub: { light: "#2E7D32", dark: "#81C784", fillOpacity: 0.08, lineWidth: 2 },
  slow_zone: { light: "#1565C0", dark: "#64B5F6", fillOpacity: 0.08, lineWidth: 2 },
  station_area: { light: "#00796B", dark: "#4DB6AC", fillOpacity: 0.06, lineWidth: 1.25 },
};

const FALLBACK: ContextZoneStyle = {
  light: "#546E7A",
  dark: "#B0BEC5",
  fillOpacity: 0.08,
  lineWidth: 2,
};

function zoneClassMatch<T extends string | number>(
  pick: (style: ContextZoneStyle) => T,
): maplibregl.ExpressionSpecification {
  return [
    "match",
    ["get", "zoneClass"],
    ...CONTEXT_ZONE_CLASSES.flatMap((zoneClass) => [
      zoneClass,
      pick(CONTEXT_ZONE_STYLES[zoneClass]),
    ]),
    pick(FALLBACK),
  ] as unknown as maplibregl.ExpressionSpecification;
}

export function contextColorExpression(dark: boolean): maplibregl.ExpressionSpecification {
  return zoneClassMatch((style) => (dark ? style.dark : style.light));
}

export const contextFillOpacityExpression = zoneClassMatch((style) => style.fillOpacity);

export const contextLineWidthExpression = zoneClassMatch((style) => style.lineWidth);

export const contextSortKeyExpression = [
  "coalesce",
  ["get", "z"],
  0,
] as maplibregl.ExpressionSpecification;

/** The known zone classes present in `features`, in legend order. */
export function contextZoneClassesIn(
  features: ReadonlyArray<{ properties?: Record<string, unknown> | null }>,
): ContextZoneClass[] {
  const present = new Set(features.map((feature) => feature.properties?.zoneClass));
  return CONTEXT_ZONE_CLASSES.filter((zoneClass) => present.has(zoneClass));
}
