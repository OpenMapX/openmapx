import type { BoundingBox, DataSourceDetail, DataSourceResult } from "@openmapx/core";
import { withCache } from "../cache.js";
import { auNswWebcam } from "./au-nsw-webcam.js";
import { caOntario } from "./ca-ontario.js";
import { bboxOverlaps, type CameraSource, filterByBbox } from "./camera-source.js";
import { esDgtWebcam } from "./es-dgt-webcam.js";
import { fiDigitrafficWebcam } from "./fi-digitraffic-webcam.js";
import { hkTransport } from "./hk-transport.js";
import { isRoadAdministration } from "./is-road-administration.js";
import { noNpra } from "./no-npra.js";
import { seTrafikverket } from "./se-trafikverket.js";
import { mapTrafficCameraToDetail, mapTrafficCameraToResult } from "./traffic-camera.js";
import { twTdxWebcam } from "./tw-tdx-webcam.js";
import type { RawWebcam } from "./types.js";

const sources: CameraSource[] = [
  fiDigitrafficWebcam,
  seTrafikverket,
  noNpra,
  isRoadAdministration,
  esDgtWebcam,
  caOntario,
  hkTransport,
  auNswWebcam,
  twTdxWebcam,
];
const load = (source: CameraSource) =>
  withCache(`webcam:${source.sourceId}:all`, 3600, () => source.fetchAll());

export { setCameraSourceCredentials } from "./webcam-config.js";
export const getCameraSourceIds = () =>
  sources
    .filter((source) => source.isEnabled())
    .map((source) => ({ id: source.sourceId, label: source.label }));
export const mapCameraSourceToResult = (raw: RawWebcam): DataSourceResult =>
  mapTrafficCameraToResult(raw);
export const mapCameraSourceToDetail = (raw: RawWebcam): DataSourceDetail =>
  mapTrafficCameraToDetail(raw);

export async function searchCameraSources(bbox: BoundingBox): Promise<RawWebcam[]> {
  const settled = await Promise.allSettled(
    sources.filter((source) => source.isEnabled() && bboxOverlaps(source.coverage, bbox)).map(load),
  );
  return filterByBbox(
    settled.flatMap((result) => (result.status === "fulfilled" ? result.value : [])),
    bbox,
  );
}

export async function getCameraSourceDetail(itemId: string): Promise<RawWebcam | null> {
  const source = sources.find((candidate) => candidate.sourceId === itemId.split(":", 1)[0]);
  if (!source?.isEnabled()) return null;
  return (await load(source)).find((camera) => camera.id === itemId) ?? null;
}
