export { createPlace } from "@openmapx/core/place-ids";
export {
  addressComponentsFromOsmTags,
  sanitizeAddressComponents,
} from "@openmapx/core/places/addressEvidence";
export type { PlaceAddressComponents } from "@openmapx/core/types/address";
export type { OsmIdentity } from "@openmapx/core/types/dataSource";
export type { Ids } from "@openmapx/core/types/identified";
export { parseId } from "@openmapx/core/types/identified";
export type { Place, PlaceIds, PlacePhoto } from "@openmapx/core/types/place";
export type { PlaceResolverContext } from "@openmapx/place-ids";
export { getPlaceResolver, registerPlaceResolver } from "@openmapx/place-ids";
