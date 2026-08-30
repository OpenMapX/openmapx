import type { ProviderEvidence } from "@openmapx/air-quality";

export interface LegacyAirQualityStation {
  id: number;
  name: string;
  lat: number;
  lng: number;
  aqi: number | null;
  pm25: number;
  lastUpdated: string;
  attribution: { name: string; url: string | null } | null;
  license: string | null;
}

function locationId(evidence: ProviderEvidence): number | null {
  const match = /^openaq-location-(\d+)$/.exec(evidence.spatial.id);
  return match ? Number(match[1]) : null;
}

export function projectLegacyStations(
  evidence: readonly ProviderEvidence[],
): LegacyAirQualityStation[] {
  return evidence.flatMap((item) => {
    const id = locationId(item);
    const coordinates = item.spatial.coordinates;
    const latest = item.series
      .filter((series) => series.pollutant === "pm25")
      .flatMap((series) => series.samples)
      .filter(
        (sample) =>
          sample.valid &&
          sample.unit === "ug/m3" &&
          Number.isFinite(sample.value) &&
          sample.value >= 0 &&
          Number.isFinite(Date.parse(sample.endAt)),
      )
      .sort((left, right) => Date.parse(right.endAt) - Date.parse(left.endAt))[0];
    if (id === null || !coordinates || !latest) return [];
    const source = item.sources[0];
    return [
      {
        id,
        name: item.spatial.name ?? `OpenAQ station ${id}`,
        lat: coordinates[1],
        lng: coordinates[0],
        // The canonical API may calculate a local index from complete windows.
        // This compatibility route must not infer AQI from one concentration.
        aqi: null,
        pm25: latest.value,
        lastUpdated: latest.endAt,
        attribution: source?.attribution ? { name: source.attribution, url: source.url } : null,
        license: source?.license?.name ?? null,
      },
    ];
  });
}
