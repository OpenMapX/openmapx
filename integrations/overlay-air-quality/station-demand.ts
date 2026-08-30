import type { OpenAQLocation } from "./schemas.js";

function freshness(location: OpenAQLocation): number {
  const value = Date.parse(location.datetimeLast?.utc ?? "");
  return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
}

function cell(location: OpenAQLocation, zoom: number): string {
  const latitude = location.coordinates.latitude ?? 0;
  const longitude = location.coordinates.longitude ?? 0;
  const cells = 2 ** Math.max(0, Math.min(22, Math.floor(zoom) + 4));
  const x = Math.floor(((longitude + 180) / 360) * cells);
  const bounded = Math.max(-85.051129, Math.min(85.051129, latitude));
  const radians = (bounded * Math.PI) / 180;
  const y = Math.floor(
    ((1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2) * cells,
  );
  return `${x}:${y}`;
}

export function rankStationDemand(
  locations: readonly OpenAQLocation[],
  options: { zoom: number; limit: number },
): {
  selected: OpenAQLocation[];
  diagnostics: { candidateCount: number; servedCount: number; skippedCount: number };
} {
  const ranked = [...locations].sort(
    (left, right) =>
      Number(right.isMonitor) - Number(left.isMonitor) ||
      freshness(right) - freshness(left) ||
      left.id - right.id,
  );
  const selected: OpenAQLocation[] = [];
  const deferred: OpenAQLocation[] = [];
  const occupied = new Set<string>();
  for (const location of ranked) {
    const key = cell(location, options.zoom);
    if (occupied.has(key)) deferred.push(location);
    else {
      occupied.add(key);
      selected.push(location);
    }
  }
  selected.push(...deferred);
  const limited = selected.slice(0, Math.max(0, Math.floor(options.limit)));
  return {
    selected: limited,
    diagnostics: {
      candidateCount: locations.length,
      servedCount: limited.length,
      skippedCount: Math.max(0, locations.length - limited.length),
    },
  };
}
