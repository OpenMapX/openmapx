import type {
  BoundingBox,
  DataSourceDetail,
  DataSourceDetailSection,
  DataSourceResult,
} from "@openmapx/core";
import type { Logger } from "@openmapx/integration-framework";
import {
  type I18nToken,
  sharedT,
  type Translatable,
  token,
} from "@openmapx/integration-framework/strings";
import { withCache } from "../cache.js";
import type { RawWebcam } from "./types.js";
import { az, fl, ga, id as idaho, la, ma, pa, sc, ut } from "./us-ibi511.js";
import { ny } from "./us-ny-511.js";
import { or } from "./us-or-tripcheck.js";
import { bboxOverlaps, filterByBbox, type UsStateCameraSource } from "./us-state-source.js";

let log: Logger | null = null;

export function setUsStateSourceLogger(logger: Logger): void {
  log = logger;
}

/**
 * Registry of US state camera sources.
 * To add a state, create a country-prefixed source file and register it here.
 */
const ALL_STATES: UsStateCameraSource[] = [ny, or, ga, fl, az, idaho, ut, la, pa, sc, ma];

function getEnabledStates(): UsStateCameraSource[] {
  return ALL_STATES.filter((s) => {
    if (!s.requiresApiKey) return true;
    return s.apiKeyEnvVar ? !!process.env[s.apiKeyEnvVar] : false;
  });
}

export function mapUsStateSourceToResult(raw: RawWebcam): DataSourceResult {
  const direction = raw.direction ?? raw.location?.region;
  return {
    id: raw.id,
    name: raw.name,
    coordinates: raw.coordinates,
    source: raw.source,
    variant: raw.variant,
    summary: direction ? token("summary.direction", { direction }) : undefined,
  };
}

export async function searchUsStateSources(bbox: BoundingBox): Promise<RawWebcam[]> {
  const enabled = getEnabledStates();
  const overlapping = enabled.filter((s) => bboxOverlaps(bbox, s.bbox));
  if (overlapping.length === 0) return [];

  const results = await Promise.allSettled(
    overlapping.map((s) => withCache(`webcam:${s.sourceId}:all`, 3600, () => s.fetchCameras())),
  );

  const allCams: RawWebcam[] = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === "fulfilled") {
      allCams.push(...result.value);
    } else {
      log?.warn(`webcam source ${overlapping[i].sourceId} failed`, result.reason);
    }
  }
  if (overlapping.length > 0 && results.every((r) => r.status === "rejected")) {
    log?.error("all webcam sources failed");
  }

  return filterByBbox(allCams, bbox);
}

export async function getUsStateSourceDetail(itemId: string): Promise<RawWebcam | null> {
  const prefix = itemId.split(":")[0];
  const state = getEnabledStates().find((s) => s.sourceId === prefix);
  if (!state) return null;

  const allCams = await withCache(`webcam:${state.sourceId}:all`, 3600, () => state.fetchCameras());
  return allCams.find((r) => r.id === itemId) ?? null;
}

export function mapUsStateSourceToDetail(raw: RawWebcam): DataSourceDetail {
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

  if (raw.streamUrl) {
    sections.push({
      title: token("section.liveStream"),
      type: "embed",
      embedUrl: raw.streamUrl,
      embedType: "video",
      sectionIcon: "videocam",
      collapsed: true,
    });
  }

  const infoRows: [I18nToken, Translatable][] = [];
  if (raw.direction) infoRows.push([token("row.direction"), raw.direction]);
  if (raw.location?.region) infoRows.push([token("row.road"), raw.location.region]);
  if (raw.location?.city) infoRows.push([token("row.location"), raw.location.city]);
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
    sources: [raw.source],
    name: raw.name,
    coordinates: raw.coordinates,
    sections,
  };
}

/** Returns all enabled US state source IDs for the source filter. */
export function getUsStateSourceIds(): { id: string; label: string }[] {
  return getEnabledStates().map((s) => ({ id: s.sourceId, label: s.stateName }));
}
