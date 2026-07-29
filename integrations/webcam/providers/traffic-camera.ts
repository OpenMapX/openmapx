import type { DataSourceDetail, DataSourceDetailSection, DataSourceResult } from "@openmapx/core";
import {
  type I18nToken,
  sharedT,
  type Translatable,
  token,
} from "@openmapx/integration-framework/strings";
import type { RawWebcam } from "./types.js";

const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

export function trafficCamera(
  source: string,
  id: string | number,
  name: string,
  coordinates: [number, number],
  country: string,
  extras: Partial<RawWebcam> = {},
): RawWebcam {
  return {
    id: `${source}:${id}`,
    name,
    coordinates,
    source,
    variant: "traffic",
    location: { country },
    ...extras,
  };
}

export function mapTrafficCameraToResult(raw: RawWebcam): DataSourceResult {
  return {
    id: raw.id,
    name: raw.name,
    coordinates: raw.coordinates,
    source: raw.source,
    variant: raw.variant,
    summary: raw.direction ? token("summary.direction", { direction: raw.direction }) : undefined,
  };
}

export function mapTrafficCameraToDetail(raw: RawWebcam): DataSourceDetail {
  const sections: DataSourceDetailSection[] = [];
  if (raw.thumbnailUrl) {
    sections.push({
      title: token("section.preview"),
      type: "image",
      imageUrl: raw.thumbnailUrl,
      imageAlt: token("imageAlt.webcam", { name: raw.name }),
      linkUrl: raw.detailUrl,
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

  const rows: [I18nToken, Translatable][] = [];
  if (raw.direction) rows.push([token("row.direction"), raw.direction]);
  if (raw.road) rows.push([token("row.road"), raw.road]);
  if (raw.location?.region) rows.push([token("row.region"), raw.location.region]);
  if (raw.location?.city) rows.push([token("row.city"), raw.location.city]);
  if (rows.length)
    sections.push({ title: sharedT.section.info, type: "table", rows, sectionIcon: "info" });
  return {
    id: raw.id,
    sources: [raw.source],
    name: raw.name,
    coordinates: raw.coordinates,
    sections,
  };
}

export async function fetchText(
  url: string,
  label: string,
  headers?: Record<string, string>,
): Promise<string> {
  return new TextDecoder().decode(await fetchBytes(url, label, headers));
}

export async function fetchBytes(
  url: string,
  label: string,
  headers?: Record<string, string>,
): Promise<ArrayBuffer> {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`${label} HTTP ${response.status}`);

  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`${label} response exceeds ${MAX_RESPONSE_BYTES} bytes`);
  }
  if (!response.body) throw new Error(`${label} returned an empty response body`);

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error(`${label} response exceeds ${MAX_RESPONSE_BYTES} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}
