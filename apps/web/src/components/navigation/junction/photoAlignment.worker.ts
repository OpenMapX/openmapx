import type {
  JunctionDecisionPoint,
  JunctionWay,
  LngLat,
  PhotoRoutePath,
  StreetLevelImage,
} from "@openmapx/core";
import {
  type PhotoPixels,
  type PhotoRegistrationResult,
  projectRoutePath,
  registerPhotoRoad,
} from "@openmapx/core/navigation/photo";

export interface PhotoAlignmentRequest {
  geometry: LngLat[];
  point: JunctionDecisionPoint;
  image: StreetLevelImage;
  pixels: PhotoPixels;
  /** Confirmed split layout, independent of permission to draw preferred lanes. */
  layoutLaneCount?: number;
  exitLanes?: { laneCount: number; activeLanes: number[] };
  approachWay?: JunctionWay;
  approachWays?: JunctionWay[];
}

export interface PhotoAlignmentResponse {
  registration: PhotoRegistrationResult;
  path: PhotoRoutePath;
}

self.onmessage = (event: MessageEvent<PhotoAlignmentRequest>) => {
  const { geometry, point, image, pixels, exitLanes, layoutLaneCount, approachWay, approachWays } =
    event.data;
  const registration = registerPhotoRoad(
    geometry,
    point,
    image,
    pixels,
    layoutLaneCount ?? exitLanes?.laneCount,
    approachWay,
    approachWays,
  );
  const path = projectRoutePath(
    geometry,
    point,
    image,
    registration.alignment && exitLanes
      ? {
          alignment: registration.alignment,
          exitLanes,
          aspectRatio: pixels.width / pixels.height,
        }
      : {},
  );
  // The legacy unregistered projection is never a navigation fallback.
  self.postMessage({
    registration,
    path:
      registration.alignment && exitLanes
        ? path
        : { ...path, points: [], ribbons: [], visible: false },
  } satisfies PhotoAlignmentResponse);
};
