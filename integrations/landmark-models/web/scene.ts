import { LandmarkModelLayer, type PlacedModel } from "./model-layer";
import { type LoadedModel, type Lod, ModelStore } from "./models";

export type { LoadedModel, Lod, PlacedModel };

export interface LandmarkScene {
  layer: LandmarkModelLayer;
  models: ModelStore;
  dispose(): void;
}

/**
 * The only module the map layer loads dynamically: everything that needs
 * three.js lives behind it, so users who never tilt into the 3D view never
 * download it.
 */
export function createLandmarkScene(options: {
  apiUrl: string;
  onUnsupported(): void;
  onFrame(drawn: readonly string[]): void;
}): LandmarkScene {
  const models = new ModelStore({ apiUrl: options.apiUrl });
  const layer = new LandmarkModelLayer({
    onUnsupported: options.onUnsupported,
    onFrame: options.onFrame,
  });
  return {
    layer,
    models,
    dispose() {
      layer.dispose();
      models.dispose();
    },
  };
}
