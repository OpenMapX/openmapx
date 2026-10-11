/** Pure image registration and projection, suitable for a browser worker. */

export { projectRoutePath } from "./photoProjection";
export {
  alignPhotoRoad,
  PHOTO_REGISTRATION_VERSION,
  type PhotoPixels,
  type PhotoRegistrationResult,
  registerPhotoRoad,
} from "./photoRoadAlignment";
