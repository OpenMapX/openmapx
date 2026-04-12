import type { BoundingBox, DataSourceDetail, DataSourceResult } from "@openmapx/core";
import { withCache } from "../cache.js";
import type { RawWebcam, TflJamCam } from "./types.js";

const TFL_URL = "https://api.tfl.gov.uk/Place/Type/JamCam";

function getTflProp(cam: TflJamCam, key: string): string | undefined {
  return cam.additionalProperties.find((p) => p.key === key)?.value;
}

function mapTflToRaw(cam: TflJamCam): RawWebcam | null {
  if (getTflProp(cam, "available") === "false") return null;

  return {
    id: `tfl:${cam.id}`,
    name: cam.commonName,
    coordinates: [cam.lon, cam.lat],
    source: "tfl",
    variant: "traffic",
    thumbnailUrl: getTflProp(cam, "imageUrl"),
    streamUrl: getTflProp(cam, "videoUrl"),
    direction: getTflProp(cam, "view"),
    location: { city: "London", country: "UK" },
  };
}

async function fetchAllJamCams(): Promise<RawWebcam[]> {
  const res = await fetch(TFL_URL, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`TfL API error: ${res.status} ${res.statusText}`);

  const cams = (await res.json()) as TflJamCam[];
  return cams.map(mapTflToRaw).filter((r): r is RawWebcam => r !== null);
}

export function mapTflToResult(raw: RawWebcam): DataSourceResult {
  return {
    id: raw.id,
    name: raw.name,
    coordinates: raw.coordinates,
    source: raw.source,
    variant: raw.variant,
    summary: raw.direction ? `View: ${raw.direction}` : undefined,
  };
}

export async function searchTfl(bbox: BoundingBox): Promise<RawWebcam[]> {
  const allCams = await withCache("webcam:tfl:all", 3600, fetchAllJamCams);

  return allCams.filter((r) => {
    const [lng, lat] = r.coordinates;
    return lat >= bbox.south && lat <= bbox.north && lng >= bbox.west && lng <= bbox.east;
  });
}

export async function getTflDetail(cameraId: string): Promise<RawWebcam | null> {
  const allCams = await withCache("webcam:tfl:all", 3600, fetchAllJamCams);
  const targetId = `tfl:${cameraId}`;
  return allCams.find((r) => r.id === targetId) ?? null;
}

export function mapTflToDetail(raw: RawWebcam): DataSourceDetail {
  const sections: DataSourceDetail["sections"] = [];

  if (raw.thumbnailUrl) {
    sections.push({
      title: "Preview",
      type: "image",
      imageUrl: raw.thumbnailUrl,
      imageAlt: raw.name,
      sectionIcon: "videocam",
    });
  }

  if (raw.streamUrl) {
    sections.push({
      title: "Video Clip",
      type: "embed",
      embedUrl: raw.streamUrl,
      embedType: "video",
      sectionIcon: "videocam",
    });
  }

  const infoRows: [string, string][] = [];
  if (raw.direction) infoRows.push(["View", raw.direction]);
  if (infoRows.length) {
    sections.push({ title: "Info", type: "table", rows: infoRows, sectionIcon: "info" });
  }

  return {
    id: raw.id,
    sources: ["tfl"],
    name: raw.name,
    coordinates: raw.coordinates,
    sections,
  };
}
