import type {
  BoundingBox,
  DataSourceDetail,
  DataSourceDetailSection,
  DataSourceResult,
} from "@openmapx/core";
import { isPublicUrl, overpassQuerySafe } from "@openmapx/core";
import {
  type I18nToken,
  sharedT,
  type Translatable,
  token,
} from "@openmapx/integration-framework/strings";
import type { OsmWebcam, RawWebcam } from "./types.js";

/**
 * Server-side reachability check for a webcam URL.
 * Uses HEAD with a short timeout so the user's IP is never exposed.
 * Validates URL safety first to prevent SSRF via user-editable OSM tags.
 */
async function checkUrlReachable(url: string): Promise<boolean> {
  if (!isPublicUrl(url)) return false;
  try {
    const res = await fetch(url, {
      method: "HEAD",
      signal: AbortSignal.timeout(5_000),
      redirect: "manual",
    });
    return res.ok;
  } catch {
    return false;
  }
}

export function mapOsmToRaw(node: OsmWebcam): RawWebcam {
  const name = node.tags.name || node.tags.description || `Webcam ${node.id}`;
  const webcamUrl = node.tags["contact:webcam"] || node.tags.webcam;

  return {
    id: `osm-webcam:${node.id}`,
    name,
    coordinates: [node.lon, node.lat],
    source: "osm",
    variant: "other",
    thumbnailUrl: webcamUrl,
    streamUrl: webcamUrl,
    direction: node.tags["camera:direction"],
  };
}

export function mapOsmToResult(raw: RawWebcam): DataSourceResult {
  return {
    id: raw.id,
    name: raw.name,
    coordinates: raw.coordinates,
    source: raw.source,
    variant: raw.variant,
    summary: raw.direction ? token("summary.direction", { direction: raw.direction }) : undefined,
  };
}

export async function searchOsmWebcams(bbox: BoundingBox): Promise<RawWebcam[]> {
  const query = `[out:json][timeout:15];(node["contact:webcam"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});node["man_made"="surveillance"]["surveillance:type"="webcam"](${bbox.south},${bbox.west},${bbox.north},${bbox.east}););out body;`;

  const data = await overpassQuerySafe(query, null);
  if (!data) return [];

  return data.elements
    .filter((el): el is Extract<typeof el, { type: "node" }> => el.type === "node")
    .map((el) => mapOsmToRaw({ id: el.id, lat: el.lat, lon: el.lon, tags: el.tags ?? {} }));
}

export async function getOsmWebcamNode(nodeId: number): Promise<RawWebcam | null> {
  const query = `[out:json][timeout:10];node(${nodeId});out body;`;
  const data = await overpassQuerySafe(query, null);
  if (!data) return null;

  const el = data.elements[0];
  if (!el || el.type !== "node") return null;

  return mapOsmToRaw({ id: el.id, lat: el.lat, lon: el.lon, tags: el.tags ?? {} });
}

export async function mapOsmToDetail(raw: RawWebcam): Promise<DataSourceDetail> {
  const sections: DataSourceDetailSection[] = [];

  if (raw.thumbnailUrl) {
    const reachable = await checkUrlReachable(raw.thumbnailUrl);

    if (reachable) {
      sections.push({
        title: token("section.webcam"),
        type: "image",
        imageUrl: raw.thumbnailUrl,
        imageAlt: token("imageAlt.webcam", { name: raw.name }),
        linkUrl: raw.thumbnailUrl,
        sectionIcon: "videocam",
      });
    } else {
      sections.push({
        title: token("section.unavailable"),
        type: "text",
        content: token("content.urlOffline"),
        sectionIcon: "warning",
      });
      sections.push({
        title: token("section.originalUrl"),
        type: "table",
        rows: [[token("row.url"), raw.thumbnailUrl]],
        sectionIcon: "info",
      });
    }
  }

  const infoRows: [I18nToken, Translatable][] = [];
  if (raw.direction) infoRows.push([token("row.direction"), raw.direction]);
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
    sources: ["osm"],
    name: raw.name,
    coordinates: raw.coordinates,
    sections,
  };
}
