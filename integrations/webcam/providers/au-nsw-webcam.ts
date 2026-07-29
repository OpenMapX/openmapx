import { fetchJson } from "@openmapx/core";
import type { CameraSource } from "./camera-source.js";
import { trafficCamera } from "./traffic-camera.js";
import { credential } from "./webcam-config.js";

interface NswCameraResponse {
  features?: Array<{
    id?: string;
    geometry?: { coordinates?: number[] };
    properties?: Record<string, unknown>;
  }>;
}

export function parseNswCameras(data: NswCameraResponse) {
  return (data.features ?? []).flatMap((feature, index) => {
    const props = feature.properties ?? {};
    const [lng, lat] = feature.geometry?.coordinates ?? [];
    const id = String(props.id ?? props.cameraId ?? feature.id ?? index);
    const image =
      typeof props.href === "string"
        ? props.href
        : typeof props.imageUrl === "string"
          ? props.imageUrl
          : typeof props.url === "string"
            ? props.url
            : undefined;
    if (!image || !Number.isFinite(lng) || !Number.isFinite(lat)) return [];
    return [
      trafficCamera(
        "au-nsw-webcam",
        id,
        String(props.title ?? props.description ?? `Traffic camera ${id}`),
        [lng, lat],
        "AU",
        {
          thumbnailUrl: image,
          direction: typeof props.direction === "string" ? props.direction : undefined,
          location: {
            country: "AU",
            region: typeof props.region === "string" ? props.region : undefined,
          },
        },
      ),
    ];
  });
}

export const auNswWebcam: CameraSource = {
  sourceId: "au-nsw-webcam",
  label: "New South Wales Live Traffic",
  coverage: { west: 140.9, south: -37.6, east: 153.7, north: -28 },
  isEnabled: () => !!credential("au-nsw-webcam-api-key"),
  async fetchAll() {
    const apiKey = credential("au-nsw-webcam-api-key");
    if (!apiKey) return [];
    const data = await fetchJson<NswCameraResponse>(
      "https://api.transport.nsw.gov.au/v1/live/cameras",
      {
        headers: { "x-api-key": apiKey },
        timeoutMs: 20_000,
      },
    );
    return parseNswCameras(data);
  },
};
