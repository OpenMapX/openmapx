import type { JunctionDecisionPoint, LngLat, StreetLevelImage } from "@openmapx/core";
import {
  alignPhotoRoad,
  type PhotoPixels,
  projectRoutePath,
} from "@openmapx/core/navigation/photo";

export interface PhotoAlignmentRequest {
  geometry: LngLat[];
  point: JunctionDecisionPoint;
  image: StreetLevelImage;
  pixels: PhotoPixels;
  exitLanes: { laneCount: number; activeLanes: number[] };
}

self.onmessage = (event: MessageEvent<PhotoAlignmentRequest>) => {
  const { geometry, point, image, pixels, exitLanes } = event.data;
  const alignment = alignPhotoRoad(geometry, point, image, pixels, exitLanes.laneCount);
  self.postMessage(
    alignment
      ? projectRoutePath(geometry, point, image, {
          alignment,
          exitLanes,
          aspectRatio: pixels.width / pixels.height,
        })
      : null,
  );
};
