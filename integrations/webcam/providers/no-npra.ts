import type { CameraSource } from "./camera-source.js";
import { parseDatex, xmlNumber, xmlPath, xmlRecords, xmlText } from "./datex.js";
import { fetchText, trafficCamera } from "./traffic-camera.js";
import { credential } from "./webcam-config.js";

const URL =
  "https://datex-server-get-v3-1.atlas.vegvesen.no/datexapi/GetCCTVSiteTable/pullsnapshotdata";

export function parseNpraCameras(xml: string) {
  const payload = parseDatex(xml);
  return xmlRecords(payload, "cctvCameraMetadataRecord").flatMap((record) => {
    const coordinates = xmlRecords(record, "pointCoordinates")[0];
    const lat = xmlNumber(coordinates?.latitude);
    const lng = xmlNumber(coordinates?.longitude);
    const id = xmlText(record["@_id"]) ?? xmlText(record.cctvCameraIdentification);
    const image = xmlText(
      xmlPath(record, "cctvStillImageService", "stillImageUrl", "urlLinkAddress"),
    );
    if (!id || !image || lat === undefined || lng === undefined) return [];
    const name =
      xmlText(xmlPath(record, "cctvCameraSiteLocalDescription", "values", "value")) ??
      `Traffic camera ${id}`;
    const road = xmlText(
      xmlPath(
        record,
        "cctvCameraLocation",
        "supplementaryPositionalDescription",
        "roadInformation",
        "roadNumber",
      ),
    );
    return [
      trafficCamera("no-npra", id, name, [lng, lat], "NO", {
        thumbnailUrl: image,
        direction: xmlText(record.cctvCameraOrientationDescription),
        road,
        lastUpdated: xmlText(record.cctvCameraRecordVersionTime),
      }),
    ];
  });
}

export const noNpra: CameraSource = {
  sourceId: "no-npra",
  label: "Norway NPRA",
  coverage: { west: 4, south: 57, east: 32, north: 72 },
  isEnabled: () => !!credential("no-npra-username") && !!credential("no-npra-password"),
  async fetchAll() {
    const username = credential("no-npra-username");
    const password = credential("no-npra-password");
    if (!username || !password) return [];
    const xml = await fetchText(URL, "NPRA DATEX CCTV", {
      Authorization: `Basic ${btoa(`${username}:${password}`)}`,
    });
    return parseNpraCameras(xml);
  },
};
