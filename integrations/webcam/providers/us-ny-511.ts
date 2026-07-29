import { fetchJson } from "@openmapx/core";
import type { RawWebcam } from "./types.js";
import type { UsStateCameraSource } from "./us-state-source.js";

interface Ny511Camera {
  Latitude: number;
  Longitude: number;
  ID: string;
  Name: string;
  DirectionOfTravel: string;
  RoadwayName: string;
  Url: string;
  VideoUrl: string | null;
  Disabled: boolean;
  Blocked: boolean;
}

export const ny: UsStateCameraSource = {
  stateCode: "ny",
  stateName: "New York",
  sourceId: "us-ny-511",
  bbox: { south: 40.4, west: -79.8, north: 45.1, east: -71.8 },
  requiresApiKey: false,

  async fetchCameras(): Promise<RawWebcam[]> {
    const cams = await fetchJson<Ny511Camera[]>("https://511ny.org/api/getcameras?format=json", {
      timeoutMs: 15_000,
      errorMessage: ({ status }) => `NY 511 API error: ${status}`,
    });
    const results: RawWebcam[] = [];

    for (const cam of cams) {
      if (cam.Disabled || cam.Blocked) continue;
      if (!cam.Latitude || !cam.Longitude) continue;

      results.push({
        id: `us-ny-511:${cam.ID}`,
        name: cam.Name,
        coordinates: [cam.Longitude, cam.Latitude],
        source: "us-ny-511",
        variant: "traffic",
        thumbnailUrl: cam.Url,
        streamUrl: cam.VideoUrl ?? undefined,
        direction: cam.DirectionOfTravel !== "Unknown" ? cam.DirectionOfTravel : undefined,
        location: {
          region: cam.RoadwayName,
          country: "US",
        },
      });
    }

    return results;
  },
};
