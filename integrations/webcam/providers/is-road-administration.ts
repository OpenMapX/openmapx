import { fetchJson } from "@openmapx/core";
import type { CameraSource } from "./camera-source.js";
import { trafficCamera } from "./traffic-camera.js";

interface IcelandCamera {
  Maelist_nr?: number;
  Myndavel?: string;
  Vegheiti?: string;
  NrVegur?: string;
  Skyring?: string;
  Slod?: string;
  Breidd?: number;
  Lengd?: number;
}

export function parseIcelandCameras(cameras: IcelandCamera[]) {
  return cameras.flatMap((item, index) => {
    if (!item.Slod || !Number.isFinite(item.Breidd) || !Number.isFinite(item.Lengd)) return [];
    const id = String(item.Maelist_nr ?? item.Slod.split("/").pop() ?? index);
    return [
      trafficCamera(
        "is-road-administration",
        id,
        item.Myndavel || item.Skyring || `Road camera ${id}`,
        [item.Lengd as number, item.Breidd as number],
        "IS",
        {
          thumbnailUrl: item.Slod,
          direction: item.Skyring,
          road: item.Vegheiti || item.NrVegur,
        },
      ),
    ];
  });
}

export const isRoadAdministration: CameraSource = {
  sourceId: "is-road-administration",
  label: "Iceland Road Administration",
  coverage: { west: -25, south: 63, east: -13, north: 67 },
  isEnabled: () => true,
  async fetchAll() {
    const cameras = await fetchJson<IcelandCamera[]>(
      "https://gagnaveita.vegagerdin.is/api/vefmyndavelar2014_1",
      { timeoutMs: 20_000 },
    );
    return parseIcelandCameras(cameras);
  },
};
