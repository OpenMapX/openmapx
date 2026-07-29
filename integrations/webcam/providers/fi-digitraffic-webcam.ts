import { fetchJson } from "@openmapx/core";
import type { CameraSource } from "./camera-source.js";
import { trafficCamera } from "./traffic-camera.js";

interface DigitrafficResponse {
  features?: Array<{
    id?: string;
    geometry?: { coordinates?: number[] };
    properties?: {
      id?: string;
      name?: string;
      dataUpdatedTime?: string;
      presets?: Array<{ id?: string; inCollection?: boolean }>;
    };
  }>;
}

export function parseDigitrafficCameras(data: DigitrafficResponse) {
  return (data.features ?? []).flatMap((feature) => {
    const id = feature.properties?.id ?? feature.id;
    const [lng, lat] = feature.geometry?.coordinates ?? [];
    const preset = feature.properties?.presets?.find((item) => item.inCollection)?.id;
    if (!id || !preset || !Number.isFinite(lng) || !Number.isFinite(lat)) return [];
    return [
      trafficCamera(
        "fi-digitraffic-webcam",
        id,
        feature.properties?.name ?? `Weather camera ${id}`,
        [lng, lat],
        "FI",
        {
          thumbnailUrl: `https://weathercam.digitraffic.fi/${preset}.jpg?thumbnail=true`,
          detailUrl: `https://weathercam.digitraffic.fi/${preset}.jpg`,
          lastUpdated: feature.properties?.dataUpdatedTime,
        },
      ),
    ];
  });
}

export const fiDigitrafficWebcam: CameraSource = {
  sourceId: "fi-digitraffic-webcam",
  label: "Finland Digitraffic",
  coverage: { west: 19, south: 59, east: 32, north: 71 },
  isEnabled: () => true,
  async fetchAll() {
    const data = await fetchJson<DigitrafficResponse>(
      "https://tie.digitraffic.fi/api/weathercam/v1/stations",
      {
        headers: { "Digitraffic-User": "OpenMapX/1.0" },
        timeoutMs: 20_000,
        // Digitraffic rejects this endpoint when an additional User-Agent is sent.
        userAgent: null,
      },
    );
    return parseDigitrafficCameras(data);
  },
};
