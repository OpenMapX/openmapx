import type { RawWebcam } from "../types.js";
import type { StateDotConfig } from "./types.js";

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

export const ny: StateDotConfig = {
  stateCode: "ny",
  stateName: "New York",
  sourceId: "dot-ny",
  bbox: { south: 40.4, west: -79.8, north: 45.1, east: -71.8 },
  requiresApiKey: false,

  async fetchCameras(): Promise<RawWebcam[]> {
    const res = await fetch("https://511ny.org/api/getcameras?format=json", {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`NY 511 API error: ${res.status}`);

    const cams = (await res.json()) as Ny511Camera[];
    const results: RawWebcam[] = [];

    for (const cam of cams) {
      if (cam.Disabled || cam.Blocked) continue;
      if (!cam.Latitude || !cam.Longitude) continue;

      results.push({
        id: `dot-ny:${cam.ID}`,
        name: cam.Name,
        coordinates: [cam.Longitude, cam.Latitude],
        source: "dot-ny",
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
