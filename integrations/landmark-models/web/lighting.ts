import { type SceneLight, sunVector } from "@/integration-api/map/sceneLight";

/** The three.js side of the shared scene light. Free of three.js, so the map layer can import it. */
export interface ModelLighting {
  /** Towards the light, in scene space (x east, y north, z up). */
  direction: [number, number, number];
  color: string;
  intensity: number;
  ambientColor: string;
  ambientIntensity: number;
}

export function lightingOf(light: SceneLight): ModelLighting {
  return {
    direction: sunVector(light),
    color: light.sunColor,
    intensity: light.sunIntensity,
    ambientColor: light.ambientColor,
    ambientIntensity: light.ambientIntensity,
  };
}
