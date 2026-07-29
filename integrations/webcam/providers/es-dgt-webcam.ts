import type { CameraSource } from "./camera-source.js";
import { parseDatex, xmlNumber, xmlPath, xmlRecords, xmlText } from "./datex.js";
import { fetchText, trafficCamera } from "./traffic-camera.js";

const DGT_URL = "https://nap.dgt.es/datex2/v3/dgt/DevicePublication/camaras_datex2_v37.xml";

export function parseDgtCameras(xml: string) {
  const payload = parseDatex(xml);
  return xmlRecords(payload, "device").flatMap((device) => {
    if (xmlText(device.typeOfDevice)?.toLowerCase() !== "camera") return [];
    const point = xmlPath(
      device,
      "pointLocation",
      "tpegPointLocation",
      "point",
      "pointCoordinates",
    );
    const lat = xmlNumber(xmlPath(point, "latitude"));
    const lng = xmlNumber(xmlPath(point, "longitude"));
    const id = xmlText(device["@_id"]);
    const image = xmlText(device.deviceUrl);
    if (!id || !image || lat === undefined || lng === undefined) return [];
    const road = xmlText(
      xmlPath(
        device,
        "pointLocation",
        "supplementaryPositionalDescription",
        "roadInformation",
        "roadName",
      ),
    );
    const direction = xmlText(
      xmlPath(
        device,
        "pointLocation",
        "supplementaryPositionalDescription",
        "roadInformation",
        "roadDestination",
      ),
    );
    return [
      trafficCamera(
        "es-dgt-webcam",
        id,
        [road, direction].filter(Boolean).join(" → ") || `Traffic camera ${id}`,
        [lng, lat],
        "ES",
        {
          thumbnailUrl: image,
          direction,
          road,
          lastUpdated: xmlText(device.lastUpdateOfDeviceInformation),
        },
      ),
    ];
  });
}

export const esDgtWebcam: CameraSource = {
  sourceId: "es-dgt-webcam",
  label: "Spain DGT",
  coverage: { west: -10, south: 35, east: 5, north: 44 },
  isEnabled: () => true,
  async fetchAll() {
    return parseDgtCameras(await fetchText(DGT_URL, "DGT cameras"));
  },
};
