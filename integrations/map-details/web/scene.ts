import { MapDetailsObjectsLayer, type ObjectLighting } from "./objects-layer";

export type { ObjectLighting };

/**
 * The only module the map layer loads dynamically: everything that needs
 * three.js lives behind it, so people who never tilt into the 3D view never
 * download it.
 */
export function createMapDetailsScene(options: {
  lighting: ObjectLighting;
  onUnsupported(): void;
}): { layer: MapDetailsObjectsLayer } {
  return { layer: new MapDetailsObjectsLayer(options) };
}
