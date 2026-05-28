import type {
  BoundingBox,
  DataSourceDetail,
  DataSourceDetailSection,
  DataSourceResult,
} from "@openmapx/core";
import {
  type I18nToken,
  sharedT,
  type Translatable,
  token,
} from "@openmapx/integration-framework/strings";
import { withCache } from "../cache.js";
import type { CaltransDistrictResponse, RawWebcam } from "./types.js";

interface DistrictInfo {
  id: number;
  bbox: { south: number; west: number; north: number; east: number };
}

const DISTRICTS: DistrictInfo[] = [
  { id: 1, bbox: { south: 38.0, west: -124.5, north: 42.1, east: -122.0 } },
  { id: 2, bbox: { south: 39.0, west: -123.0, north: 42.1, east: -119.9 } },
  { id: 3, bbox: { south: 38.0, west: -122.5, north: 40.0, east: -119.5 } },
  { id: 4, bbox: { south: 36.8, west: -123.0, north: 38.5, east: -121.0 } },
  { id: 5, bbox: { south: 34.5, west: -121.5, north: 36.5, east: -119.0 } },
  { id: 6, bbox: { south: 35.0, west: -121.0, north: 38.0, east: -118.5 } },
  { id: 7, bbox: { south: 33.7, west: -119.0, north: 34.8, east: -117.5 } },
  { id: 8, bbox: { south: 33.5, west: -118.0, north: 36.0, east: -114.5 } },
  { id: 9, bbox: { south: 36.0, west: -119.5, north: 38.5, east: -117.0 } },
  { id: 10, bbox: { south: 37.0, west: -122.0, north: 38.5, east: -120.0 } },
  { id: 11, bbox: { south: 32.5, west: -117.6, north: 33.5, east: -115.5 } },
  { id: 12, bbox: { south: 33.3, west: -118.1, north: 34.0, east: -117.4 } },
];

function bboxOverlaps(a: BoundingBox, b: DistrictInfo["bbox"]): boolean {
  return a.south <= b.north && a.north >= b.south && a.west <= b.east && a.east >= b.west;
}

function padDistrictId(id: number): string {
  return String(id).padStart(2, "0");
}

async function fetchDistrict(districtId: number): Promise<RawWebcam[]> {
  const padded = padDistrictId(districtId);
  const url = `https://cwwp2.dot.ca.gov/data/d${districtId}/cctv/cctvStatusD${padded}.json`;

  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return [];

  const data = (await res.json()) as CaltransDistrictResponse;
  if (!data?.data) return [];

  const results: RawWebcam[] = [];
  for (const item of data.data) {
    if (item.cctv?.inService !== "true") continue;
    const c = item.cctv;
    const lat = Number.parseFloat(c.location.latitude);
    const lng = Number.parseFloat(c.location.longitude);
    if (Number.isNaN(lat) || Number.isNaN(lng)) continue;

    results.push({
      id: `caltrans:${c.location.district}:${c.index}`,
      name: c.location.locationName || `Caltrans D${c.location.district} #${c.index}`,
      coordinates: [lng, lat],
      source: "caltrans",
      variant: "traffic",
      thumbnailUrl: c.imageData?.static?.currentImageURL,
      streamUrl: c.imageData?.streamingVideoURL,
      direction: c.location.direction,
      location: {
        city: c.location.nearbyPlace,
        region: c.location.county ? `${c.location.county} County` : undefined,
        country: "US",
      },
    });
  }
  return results;
}

function filterByBbox(results: RawWebcam[], bbox: BoundingBox): RawWebcam[] {
  return results.filter((r) => {
    const [lng, lat] = r.coordinates;
    return lat >= bbox.south && lat <= bbox.north && lng >= bbox.west && lng <= bbox.east;
  });
}

export function mapCaltransToResult(raw: RawWebcam): DataSourceResult {
  return {
    id: raw.id,
    name: raw.name,
    coordinates: raw.coordinates,
    source: raw.source,
    variant: raw.variant,
    summary: raw.direction ? token("summary.direction", { direction: raw.direction }) : undefined,
  };
}

export async function searchCaltrans(bbox: BoundingBox): Promise<RawWebcam[]> {
  const overlapping = DISTRICTS.filter((d) => bboxOverlaps(bbox, d.bbox));
  if (overlapping.length === 0) return [];

  const districtResults = await Promise.allSettled(
    overlapping.map((d) => withCache(`webcam:caltrans:d${d.id}`, 3600, () => fetchDistrict(d.id))),
  );

  const allResults: RawWebcam[] = [];
  for (const result of districtResults) {
    if (result.status === "fulfilled") {
      allResults.push(...result.value);
    }
  }

  return filterByBbox(allResults, bbox);
}

export async function getCaltransDetail(
  districtId: string,
  index: string,
): Promise<RawWebcam | null> {
  const dId = Number.parseInt(districtId, 10);
  if (Number.isNaN(dId)) return null;

  const results = await withCache(`webcam:caltrans:d${dId}`, 3600, () => fetchDistrict(dId));
  const targetId = `caltrans:${districtId}:${index}`;
  return results.find((r) => r.id === targetId) ?? null;
}

export function mapCaltransToDetail(raw: RawWebcam): DataSourceDetail {
  const sections: DataSourceDetailSection[] = [];

  if (raw.thumbnailUrl) {
    sections.push({
      title: token("section.preview"),
      type: "image",
      imageUrl: raw.thumbnailUrl,
      imageAlt: token("imageAlt.webcam", { name: raw.name }),
      sectionIcon: "videocam",
    });
  }

  const infoRows: [I18nToken, Translatable][] = [];
  if (raw.direction) infoRows.push([token("row.direction"), raw.direction]);
  if (raw.location?.city) infoRows.push([token("row.nearby"), raw.location.city]);
  if (raw.location?.region) infoRows.push([token("row.county"), raw.location.region]);
  if (raw.streamUrl) infoRows.push([token("row.liveStream"), raw.streamUrl]);
  if (infoRows.length) {
    sections.push({
      title: sharedT.section.info,
      type: "table",
      rows: infoRows,
      sectionIcon: "info",
    });
  }

  return {
    id: raw.id,
    sources: ["caltrans"],
    name: raw.name,
    coordinates: raw.coordinates,
    sections,
  };
}
