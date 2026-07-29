import { fetchJson } from "@openmapx/core";
import type { CameraSource } from "./camera-source.js";
import { trafficCamera } from "./traffic-camera.js";

interface OntarioCamera {
  Id?: number;
  Name?: string;
  Location?: string;
  Roadway?: string;
  Direction?: string;
  Latitude?: number;
  Longitude?: number;
  Views?: Array<{ Url?: string; Status?: string; Description?: string }>;
}

export function parseOntarioCameras(cameras: OntarioCamera[]) {
  return cameras.flatMap((item) => {
    const view = item.Views?.find((candidate) => candidate.Status === "Enabled" && candidate.Url);
    if (
      item.Id === undefined ||
      !view?.Url ||
      !Number.isFinite(item.Latitude) ||
      !Number.isFinite(item.Longitude)
    )
      return [];
    return [
      trafficCamera(
        "ca-ontario",
        item.Id,
        item.Name || item.Location || `Camera ${item.Id}`,
        [item.Longitude as number, item.Latitude as number],
        "CA",
        {
          thumbnailUrl: view.Url,
          direction: item.Direction === "Unknown" ? view.Description : item.Direction,
          road: item.Roadway,
          location: { country: "CA", city: item.Location },
        },
      ),
    ];
  });
}

export const caOntario: CameraSource = {
  sourceId: "ca-ontario",
  label: "Ontario 511",
  coverage: { west: -96, south: 41, east: -74, north: 57 },
  isEnabled: () => true,
  async fetchAll() {
    const cameras = await fetchJson<OntarioCamera[]>(
      "https://511on.ca/api/v2/get/cameras?format=json",
      { timeoutMs: 20_000 },
    );
    return parseOntarioCameras(cameras);
  },
};
