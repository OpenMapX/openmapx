import {
  type CoverageRegion,
  isCountryRegionKey,
  isExtractRegionKey,
  regionKeyForExtract,
  type StreamEvidence,
} from "@openmapx/core/coverage";

function displayRegion(key: string): string {
  if (key === "unassigned") return "Region not specified";
  const value = key.replace(/^(extract|country|regional-scope):/, "").replaceAll("/", " / ");
  return value
    .split(/[-_ ]+/)
    .filter(Boolean)
    .map((part) =>
      part.length <= 3 ? part.toUpperCase() : `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`,
    )
    .join(" ");
}

export function regionForKey(key: string): CoverageRegion {
  const kind = isExtractRegionKey(key)
    ? "extract"
    : isCountryRegionKey(key)
      ? "country"
      : key === "unassigned"
        ? "unassigned"
        : "regional-scope";
  return {
    key,
    label: displayRegion(key),
    kind,
    ...(kind === "extract" ? { originalId: key.slice("extract:".length) } : {}),
  };
}

export function collectCoverageRegions(
  streams: readonly StreamEvidence[],
  datasetRegions: readonly string[] = [],
): CoverageRegion[] {
  const keys = new Set<string>();
  for (const region of datasetRegions) keys.add(regionKeyForExtract(region));
  for (const stream of streams) {
    for (const key of stream.region.keys) keys.add(key);
    if (stream.region.keys.length === 0) keys.add("unassigned");
  }
  return [...keys]
    .sort((a, b) => a.localeCompare(b))
    .map((key) => {
      const region = regionForKey(key);
      const scope = streams.find(
        (stream) => stream.region.keys.includes(key) && stream.region.bounds,
      )?.region;
      return scope
        ? { ...region, bounds: scope.bounds, label: scope.label ?? region.label }
        : region;
    });
}
