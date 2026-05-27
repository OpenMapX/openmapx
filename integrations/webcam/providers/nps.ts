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
import type { RawWebcam } from "./types.js";

const NPS_BASE = "https://developer.nps.gov/api/v1";

// Populated by setup(ctx) from the resolved integration config cascade.
let npsApiKey: string | undefined;
export function setNpsApiKey(value: string | undefined): void {
  npsApiKey = value && value.length > 0 ? value : undefined;
}

function getApiKey(): string {
  return npsApiKey ?? "DEMO_KEY";
}

interface NpsWebcam {
  id: string;
  url: string;
  title: string;
  description: string;
  status: string;
  isStreaming: boolean;
  latitude: number;
  longitude: number;
  images: { url: string; altText?: string; credit?: string }[];
  relatedParks: {
    parkCode: string;
    fullName: string;
    name: string;
    states: string;
    designation: string;
    url: string;
  }[];
  tags: string[];
  credit: string;
}

interface NpsResponse {
  total: string;
  limit: string;
  start: string;
  data: NpsWebcam[];
}

function mapNpsToRaw(cam: NpsWebcam): RawWebcam | null {
  if (cam.status !== "Active") return null;
  if (!cam.latitude || !cam.longitude) return null;

  const park = cam.relatedParks[0];
  let thumbnailUrl = cam.images[0]?.url;
  if (thumbnailUrl?.includes("nps.govhttps://")) {
    thumbnailUrl = thumbnailUrl.replace("https://www.nps.govhttps://", "https://");
  }

  return {
    id: `nps:${cam.id}`,
    name: cam.title,
    coordinates: [cam.longitude, cam.latitude],
    source: "nps",
    variant: "landscape",
    thumbnailUrl,
    detailUrl: cam.url,
    categories: cam.tags.length > 0 ? cam.tags.slice(0, 5) : undefined,
    location: park
      ? {
          city: park.name,
          region: park.states,
          country: "US",
        }
      : { country: "US" },
  };
}

async function fetchAllNps(): Promise<RawWebcam[]> {
  const allCams: RawWebcam[] = [];
  let start = 0;
  const limit = 100;

  while (true) {
    const params = new URLSearchParams({
      limit: String(limit),
      start: String(start),
      api_key: getApiKey(),
    });

    const res = await fetch(`${NPS_BASE}/webcams?${params}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`NPS API error: ${res.status} ${res.statusText}`);

    const data = (await res.json()) as NpsResponse;
    const total = Number.parseInt(data.total, 10);

    for (const cam of data.data) {
      const raw = mapNpsToRaw(cam);
      if (raw) allCams.push(raw);
    }

    start += limit;
    if (start >= total) break;
  }

  return allCams;
}

export function mapNpsToResult(raw: RawWebcam): DataSourceResult {
  return {
    id: raw.id,
    name: raw.name,
    coordinates: raw.coordinates,
    source: raw.source,
    variant: raw.variant,
    summary: raw.location?.city ?? undefined,
  };
}

export async function searchNps(bbox: BoundingBox): Promise<RawWebcam[]> {
  const allCams = await withCache("webcam:nps:all", 3600, fetchAllNps);

  return allCams.filter((r) => {
    const [lng, lat] = r.coordinates;
    return lat >= bbox.south && lat <= bbox.north && lng >= bbox.west && lng <= bbox.east;
  });
}

export async function getNpsDetail(webcamId: string): Promise<RawWebcam | null> {
  const allCams = await withCache("webcam:nps:all", 3600, fetchAllNps);
  const targetId = `nps:${webcamId}`;
  return allCams.find((r) => r.id === targetId) ?? null;
}

export function mapNpsToDetail(raw: RawWebcam): DataSourceDetail {
  const sections: DataSourceDetailSection[] = [];

  if (raw.thumbnailUrl) {
    sections.push({
      title: token("section.preview"),
      type: "image",
      imageUrl: raw.thumbnailUrl,
      imageAlt: raw.name,
      linkUrl: raw.detailUrl,
      sectionIcon: "videocam",
    });
  }

  const infoRows: [I18nToken, Translatable][] = [];
  if (raw.location?.city) infoRows.push([token("row.park"), raw.location.city]);
  if (raw.location?.region) infoRows.push([token("row.state"), raw.location.region]);
  if (raw.categories?.length) infoRows.push([token("row.tags"), raw.categories.join(", ")]);
  if (raw.detailUrl) infoRows.push([token("row.npsPage"), raw.detailUrl]);
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
    sources: ["nps"],
    name: raw.name,
    coordinates: raw.coordinates,
    sections,
  };
}
