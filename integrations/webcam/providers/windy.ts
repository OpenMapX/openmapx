import type { BoundingBox, DataSourceDetail, DataSourceResult } from "@openmapx/core";
import type { RawWebcam, WebcamVariant, WindyWebcam } from "./types.js";

const WINDY_BASE = "https://api.windy.com/webcams/api/v3";

// Populated by setup(ctx) from the resolved integration config cascade.
let windyApiKey: string | null = null;
export function setWindyApiKey(value: string | undefined): void {
  windyApiKey = value && value.length > 0 ? value : null;
}

function getApiKey(): string | null {
  return windyApiKey;
}

function windyHeaders(): Record<string, string> {
  const key = getApiKey();
  return {
    "x-windy-api-key": key ?? "",
    Accept: "application/json",
  };
}

const CATEGORY_TO_VARIANT: Record<string, WebcamVariant> = {
  landscape: "landscape",
  mountain: "landscape",
  forest: "landscape",
  lake: "landscape",
  river: "landscape",
  coast: "landscape",
  traffic: "traffic",
  city: "city",
  building: "city",
  square: "city",
  village: "city",
  port: "city",
  airport: "city",
  meteo: "weather",
  observatory: "weather",
  beach: "beach",
  sportArea: "other",
  indoor: "other",
};

function mapCategoriesToVariant(categories?: { id: string; name: string }[]): WebcamVariant {
  if (!categories?.length) return "other";
  for (const cat of categories) {
    const variant = CATEGORY_TO_VARIANT[cat.id];
    if (variant) return variant;
  }
  return "other";
}

function mapWindyToRaw(wc: WindyWebcam): RawWebcam {
  const lat = wc.location?.latitude ?? 0;
  const lng = wc.location?.longitude ?? 0;

  return {
    id: `windy:${wc.webcamId}`,
    name: wc.title,
    coordinates: [lng, lat],
    source: "windy",
    variant: mapCategoriesToVariant(wc.categories),
    thumbnailUrl: wc.images?.current?.preview ?? wc.images?.current?.thumbnail,
    playerEmbedUrl: wc.player?.day ?? wc.player?.live,
    detailUrl: wc.urls?.detail,
    lastUpdated: wc.lastUpdatedOn,
    viewCount: wc.viewCount,
    categories: wc.categories?.map((c) => c.name),
    location: wc.location
      ? {
          city: wc.location.city,
          region: wc.location.region,
          country: wc.location.country,
        }
      : undefined,
  };
}

export function mapWindyToResult(raw: RawWebcam): DataSourceResult {
  return {
    id: raw.id,
    name: raw.name,
    coordinates: raw.coordinates,
    source: raw.source,
    variant: raw.variant,
    summary: raw.categories?.join(", "),
  };
}

export async function searchWindy(bbox: BoundingBox): Promise<RawWebcam[]> {
  if (!getApiKey()) return [];

  const params = new URLSearchParams({
    northLat: String(bbox.north),
    southLat: String(bbox.south),
    eastLon: String(bbox.east),
    westLon: String(bbox.west),
    zoom: "12",
    include: "images,location,categories",
    lang: "en",
  });

  const url = `${WINDY_BASE}/map/clusters?${params}`;
  const res = await fetch(url, { headers: windyHeaders() });

  if (!res.ok) {
    throw new Error(`Windy API error: ${res.status} ${res.statusText}`);
  }

  const webcams = (await res.json()) as WindyWebcam[];
  return webcams.filter((wc) => wc.status === "active").map(mapWindyToRaw);
}

export async function getWindyDetail(webcamId: string): Promise<RawWebcam | null> {
  if (!getApiKey()) return null;

  const url = `${WINDY_BASE}/webcams/${webcamId}?include=images,location,player,categories,urls&lang=en`;
  const res = await fetch(url, { headers: windyHeaders() });

  if (!res.ok) return null;

  const wc = (await res.json()) as WindyWebcam;
  return mapWindyToRaw(wc);
}

export function mapWindyToDetail(raw: RawWebcam): DataSourceDetail {
  const sections: DataSourceDetail["sections"] = [];

  if (raw.thumbnailUrl) {
    sections.push({
      title: "Preview",
      type: "image",
      imageUrl: raw.thumbnailUrl,
      imageAlt: raw.name,
      linkUrl: raw.detailUrl,
      sectionIcon: "videocam",
    });
  }

  if (raw.playerEmbedUrl) {
    sections.push({
      title: "Live / Timelapse",
      type: "embed",
      embedUrl: raw.playerEmbedUrl,
      sectionIcon: "open_in_new",
      collapsed: true,
    });
  }

  const infoRows: [string, string | number][] = [];
  if (raw.location?.city) infoRows.push(["City", raw.location.city]);
  if (raw.location?.region) infoRows.push(["Region", raw.location.region]);
  if (raw.location?.country) infoRows.push(["Country", raw.location.country]);
  if (raw.categories?.length) infoRows.push(["Categories", raw.categories.join(", ")]);
  if (raw.viewCount) infoRows.push(["Views", raw.viewCount]);
  if (raw.lastUpdated) infoRows.push(["Last Updated", new Date(raw.lastUpdated).toLocaleString()]);

  if (infoRows.length) {
    sections.push({ title: "Info", type: "table", rows: infoRows, sectionIcon: "info" });
  }

  return {
    id: raw.id,
    sources: ["windy"],
    name: raw.name,
    coordinates: raw.coordinates,
    sections,
  };
}
