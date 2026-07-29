import { fetchJson } from "@openmapx/core";
import { integrationEnvVarName } from "@openmapx/integration-framework";
import type { RawWebcam } from "./types.js";
import type { UsStateCameraSource } from "./us-state-source.js";

/**
 * IBI Group 511 platform — shared by many US states.
 * All use the same API: GET /api/v2/get/cameras?key={key}&format=json
 * Rate limit: 10 requests per 60 seconds.
 * Register for a free key at {baseUrl}/my511/register
 */

interface Ibi511View {
  Id: number;
  Url: string;
  Status: string;
  Description: string;
  SortId: number;
}

interface Ibi511Camera {
  Id: number;
  Source: string;
  SourceId: string;
  Roadway: string;
  Direction: string;
  Latitude: number;
  Longitude: number;
  Location: string;
  SortOrder: number;
  Name: string;
  Views: Ibi511View[];
}

function mapDirection(dir: string): string | undefined {
  if (!dir || dir === "None" || dir === "All Directions") return undefined;
  return dir;
}

function makeIbi511Config(opts: {
  stateCode: string;
  stateName: string;
  baseUrl: string;
  apiKeyEnvVar: string;
  bbox: { south: number; west: number; north: number; east: number };
}): UsStateCameraSource {
  const sourceId = `us-${opts.stateCode}-511`;

  return {
    stateCode: opts.stateCode,
    stateName: opts.stateName,
    sourceId,
    bbox: opts.bbox,
    requiresApiKey: true,
    apiKeyEnvVar: opts.apiKeyEnvVar,

    async fetchCameras(): Promise<RawWebcam[]> {
      const key = process.env[opts.apiKeyEnvVar];
      if (!key) return [];

      const url = `${opts.baseUrl}/api/v2/get/cameras?key=${encodeURIComponent(key)}&format=json`;
      const cams = await fetchJson<Ibi511Camera[]>(url, {
        timeoutMs: 15_000,
        errorMessage: ({ status }) => `${opts.stateName} 511 API error: ${status}`,
      });
      const results: RawWebcam[] = [];

      for (const cam of cams) {
        if (!cam.Latitude || !cam.Longitude) continue;

        const activeView = cam.Views?.find((v) => v.Status === "Enabled");
        if (!activeView) continue;

        results.push({
          id: `${sourceId}:${cam.Id}`,
          name: cam.Name || cam.Location || `Camera ${cam.Id}`,
          coordinates: [cam.Longitude, cam.Latitude],
          source: sourceId,
          variant: "traffic",
          thumbnailUrl: activeView.Url,
          direction: mapDirection(cam.Direction),
          location: {
            region: cam.Roadway || undefined,
            country: "US",
          },
        });
      }

      return results;
    },
  };
}

export const ga = makeIbi511Config({
  stateCode: "ga",
  stateName: "Georgia",
  baseUrl: "https://511ga.org",
  apiKeyEnvVar: integrationEnvVarName("webcam", "us-ga-511-api-key"),
  bbox: { south: 30.3, west: -85.6, north: 35.0, east: -80.8 },
});

export const fl = makeIbi511Config({
  stateCode: "fl",
  stateName: "Florida",
  baseUrl: "https://fl511.com",
  apiKeyEnvVar: integrationEnvVarName("webcam", "us-fl-511-api-key"),
  bbox: { south: 24.4, west: -87.7, north: 31.0, east: -80.0 },
});

export const az = makeIbi511Config({
  stateCode: "az",
  stateName: "Arizona",
  baseUrl: "https://az511.com",
  apiKeyEnvVar: integrationEnvVarName("webcam", "us-az-511-api-key"),
  bbox: { south: 31.3, west: -114.8, north: 37.0, east: -109.0 },
});

export const id = makeIbi511Config({
  stateCode: "id",
  stateName: "Idaho",
  baseUrl: "https://511.idaho.gov",
  apiKeyEnvVar: integrationEnvVarName("webcam", "us-id-511-api-key"),
  bbox: { south: 41.9, west: -117.3, north: 49.0, east: -111.0 },
});

export const ut = makeIbi511Config({
  stateCode: "ut",
  stateName: "Utah",
  baseUrl: "https://prod-ut.ibi511.com",
  apiKeyEnvVar: integrationEnvVarName("webcam", "us-ut-511-api-key"),
  bbox: { south: 36.9, west: -114.1, north: 42.0, east: -109.0 },
});

export const la = makeIbi511Config({
  stateCode: "la",
  stateName: "Louisiana",
  baseUrl: "https://511la.org",
  apiKeyEnvVar: integrationEnvVarName("webcam", "us-la-511-api-key"),
  bbox: { south: 28.9, west: -94.1, north: 33.0, east: -88.8 },
});

export const pa = makeIbi511Config({
  stateCode: "pa",
  stateName: "Pennsylvania",
  baseUrl: "https://www.511pa.com",
  apiKeyEnvVar: integrationEnvVarName("webcam", "us-pa-511-api-key"),
  bbox: { south: 39.7, west: -80.6, north: 42.3, east: -74.7 },
});

export const sc = makeIbi511Config({
  stateCode: "sc",
  stateName: "South Carolina",
  baseUrl: "https://511sc.org",
  apiKeyEnvVar: integrationEnvVarName("webcam", "us-sc-511-api-key"),
  bbox: { south: 32.0, west: -83.4, north: 35.2, east: -78.5 },
});

export const ma = makeIbi511Config({
  stateCode: "ma",
  stateName: "Massachusetts",
  baseUrl: "https://www.mass511.com",
  apiKeyEnvVar: integrationEnvVarName("webcam", "us-ma-511-api-key"),
  bbox: { south: 41.2, west: -73.5, north: 42.9, east: -69.9 },
});
