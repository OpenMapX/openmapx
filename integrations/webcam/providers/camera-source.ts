import type { BoundingBox } from "@openmapx/core";
import type { RawWebcam } from "./types.js";

export interface CameraSource {
  readonly sourceId: string;
  readonly label: string;
  readonly coverage: BoundingBox;
  isEnabled(): boolean;
  fetchAll(): Promise<RawWebcam[]>;
}

export function bboxOverlaps(a: BoundingBox, b: BoundingBox): boolean {
  return a.south <= b.north && a.north >= b.south && a.west <= b.east && a.east >= b.west;
}

export function filterByBbox(cameras: RawWebcam[], bbox: BoundingBox): RawWebcam[] {
  return cameras.filter((camera) => {
    const [lng, lat] = camera.coordinates;
    return lat >= bbox.south && lat <= bbox.north && lng >= bbox.west && lng <= bbox.east;
  });
}
