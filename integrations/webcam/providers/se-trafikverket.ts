import { fetchJson } from "@openmapx/core";
import type { CameraSource } from "./camera-source.js";
import { trafficCamera } from "./traffic-camera.js";
import { credential } from "./webcam-config.js";

interface TrafikverketCamera {
  Id?: unknown;
  Active?: unknown;
  Deleted?: unknown;
  Name?: unknown;
  Description?: unknown;
  Location?: unknown;
  Geometry?: unknown;
  PhotoUrl?: unknown;
  PhotoTime?: unknown;
  Direction?: unknown;
}

interface TrafikverketResponse {
  RESPONSE?: { RESULT?: Array<{ Camera?: TrafikverketCamera[] }> };
}

function wgs84Point(item: TrafikverketCamera): string | undefined {
  if (typeof item.Geometry === "string") return item.Geometry;
  if (!item.Geometry || typeof item.Geometry !== "object") return undefined;
  const geometry = item.Geometry as Record<string, unknown>;
  return typeof geometry.WGS84 === "string" ? geometry.WGS84 : undefined;
}

export function parseTrafikverketCameras(response: TrafikverketResponse) {
  return (response.RESPONSE?.RESULT ?? [])
    .flatMap((result) => result.Camera ?? [])
    .flatMap((item) => {
      if (item.Active === false || item.Deleted === true) return [];
      const id = typeof item.Id === "string" ? item.Id : "";
      const geometry = wgs84Point(item)?.match(/POINT\s*\(\s*([-\d.]+)\s+([-\d.]+)\s*\)/i);
      const image = typeof item.PhotoUrl === "string" ? item.PhotoUrl : undefined;
      const lng = Number(geometry?.[1]);
      const lat = Number(geometry?.[2]);
      if (!id || !image || !Number.isFinite(lng) || !Number.isFinite(lat)) return [];
      const direction =
        typeof item.Direction === "number"
          ? `${item.Direction}°`
          : typeof item.Direction === "string"
            ? item.Direction
            : undefined;
      const location =
        typeof item.Location === "string"
          ? item.Location
          : typeof item.Description === "string"
            ? item.Description
            : undefined;
      return [
        trafficCamera(
          "se-trafikverket",
          id,
          typeof item.Name === "string" ? item.Name : `Traffic camera ${id}`,
          [lng, lat],
          "SE",
          {
            thumbnailUrl: image,
            direction,
            lastUpdated: typeof item.PhotoTime === "string" ? item.PhotoTime : undefined,
            location: { country: "SE", city: location },
          },
        ),
      ];
    });
}

export const seTrafikverket: CameraSource = {
  sourceId: "se-trafikverket",
  label: "Sweden Trafikverket",
  coverage: { west: 10, south: 55, east: 25, north: 70 },
  isEnabled: () => !!credential("se-trafikverket-api-key"),
  async fetchAll() {
    const apiKey = credential("se-trafikverket-api-key");
    if (!apiKey) return [];
    const body = `<REQUEST><LOGIN authenticationkey="${apiKey}"/><QUERY objecttype="Camera" schemaversion="1"><FILTER/></QUERY></REQUEST>`;
    const response = await fetchJson<TrafikverketResponse>(
      "https://api.trafikinfo.trafikverket.se/v2/data.json",
      {
        headers: { "Content-Type": "application/xml" },
        init: { method: "POST", body },
        timeoutMs: 20_000,
      },
    );
    return parseTrafikverketCameras(response);
  },
};
