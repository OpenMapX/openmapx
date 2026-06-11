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
import { withCache } from "../../cache.js";
import type { RawWebcam } from "../types.js";
import { az, fl, ga, id as idaho, la, ma, pa, sc, ut } from "./ibi511.js";
import { ny } from "./ny.js";
import { or } from "./or.js";
import { bboxOverlaps, filterByBbox, type StateDotConfig } from "./types.js";

let log: Logger | null = null;

export function setDotLogger(logger: Logger): void {
  log = logger;
}

/**
 * Registry of all state DOT camera adapters.
 * To add a new state, create a config file and add it here.
 */
const ALL_STATES: StateDotConfig[] = [ny, or, ga, fl, az, idaho, ut, la, pa, sc, ma];

function getEnabledStates(): StateDotConfig[] {
  return ALL_STATES.filter((s) => {
    if (!s.requiresApiKey) return true;
    return s.apiKeyEnvVar ? !!process.env[s.apiKeyEnvVar] : false;
  });
}

export function mapDotToResult(raw: RawWebcam): DataSourceResult {
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

export async function searchDot(bbox: BoundingBox): Promise<RawWebcam[]> {
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

export async function getDotDetail(itemId: string): Promise<RawWebcam | null> {
  const prefix = itemId.split(":")[0];
  const state = getEnabledStates().find((s) => s.sourceId === prefix);
  if (!state) return null;

  const allCams = await withCache(`webcam:${state.sourceId}:all`, 3600, () => state.fetchCameras());
  return allCams.find((r) => r.id === itemId) ?? null;
}

export function mapDotToDetail(raw: RawWebcam): DataSourceDetail {
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

/** Returns list of all registered state DOT source IDs (for filter options). */
export function getDotSourceIds(): { id: string; label: string }[] {
  return getEnabledStates().map((s) => ({ id: s.sourceId, label: s.stateName }));
}
