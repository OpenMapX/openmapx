import type { CameraSource } from "./camera-source.js";
import { fetchBytes, trafficCamera } from "./traffic-camera.js";

const LOCATIONS_URL =
  "https://static.data.gov.hk/td/traffic-snapshot-images/code/Traffic_Camera_Locations_En.csv";

export function parseHongKongCameras(bytes: ArrayBuffer) {
  const text = new TextDecoder("utf-16le").decode(bytes);
  return text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .slice(1)
    .flatMap((line) => {
      const [id, region, district, name, , , latitude, longitude, imageUrl] = line.split("\t");
      const lat = Number(latitude);
      const lng = Number(longitude);
      if (!id || !imageUrl || !Number.isFinite(lat) || !Number.isFinite(lng)) return [];
      return [
        trafficCamera("hk-transport", id, name || `Traffic camera ${id}`, [lng, lat], "HK", {
          thumbnailUrl: imageUrl,
          location: { country: "HK", region, city: district },
        }),
      ];
    });
}

export const hkTransport: CameraSource = {
  sourceId: "hk-transport",
  label: "Hong Kong Transport Department",
  coverage: { west: 113.8, south: 22.1, east: 114.5, north: 22.6 },
  isEnabled: () => true,
  async fetchAll() {
    return parseHongKongCameras(await fetchBytes(LOCATIONS_URL, "Hong Kong traffic cameras"));
  },
};
