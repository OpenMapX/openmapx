interface HoverFeatureLike {
  layer?: { id?: string };
  properties?: { id?: unknown };
}

function getFeatureId(feature: HoverFeatureLike): string | null {
  const id = feature.properties?.id;
  if (typeof id === "string" && id.length > 0) return id;
  if (typeof id === "number" && Number.isFinite(id)) return String(id);
  return null;
}

export function pickHoveredDataSourceItemId(
  features: HoverFeatureLike[],
  markersLayerId: string,
): string | null {
  const markerFeature = features.find(
    (feature) => feature.layer?.id === markersLayerId && getFeatureId(feature) !== null,
  );
  if (markerFeature) return getFeatureId(markerFeature);

  const fallbackFeature = features.find((feature) => getFeatureId(feature) !== null);
  return fallbackFeature ? getFeatureId(fallbackFeature) : null;
}
