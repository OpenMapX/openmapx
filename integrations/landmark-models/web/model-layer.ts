import { itemAt } from "@openmapx/core";
import type { Attribution } from "@openmapx/integration-framework";
import {
  type CustomLayerInterface,
  type CustomRenderMethodInput,
  type Map as MaplibreMap,
  MercatorCoordinate,
} from "maplibre-gl";
import {
  AmbientLight,
  Box3,
  Camera,
  Color,
  DirectionalLight,
  Frustum,
  type Material,
  type Mesh,
  Plane,
  Ray,
  Raycaster,
  Scene,
  Vector3,
  WebGLRenderer,
} from "three";
import { cameraMatrix, objectMatrix, unprojectRay } from "./frame";
import type { LoadedModel } from "./models";

export const LANDMARK_LAYER_ID = "openmapx-landmark-models";

export interface PlacedModel {
  assetId: string;
  model: LoadedModel;
  anchor: [number, number];
  /** Terrain ground under the model (0 without terrain). */
  groundM: number;
  /** Provider lift; the model base sits at groundM + elevationM. */
  elevationM: number;
  /** Clip everything below groundM (sunken models on a flat map). */
  clipBelowGround: boolean;
  receipts: readonly Attribution[];
}

/** The three.js side of the shared scene light. */
export interface ModelLighting {
  /** Towards the light, in scene space (x east, y north, z up). */
  direction: [number, number, number];
  color: string;
  intensity: number;
  ambientColor: string;
  ambientIntensity: number;
}

/** Below this the globe has fully blended to the flat map at street zoom. */
const GLOBE_TRANSITION_LIMIT = 0.01;

function materialsOf(mesh: Mesh): Material[] {
  return Array.isArray(mesh.material) ? mesh.material : [mesh.material];
}

const samePlacement = (a: PlacedModel, b: PlacedModel) =>
  a.assetId === b.assetId &&
  a.model === b.model &&
  a.anchor[0] === b.anchor[0] &&
  a.anchor[1] === b.anchor[1] &&
  a.groundM === b.groundM &&
  a.elevationM === b.elevationM &&
  a.clipBelowGround === b.clipBelowGround;

/**
 * Draws landmark models with three.js inside MapLibre's 3D pass, sharing its
 * depth buffer so models and extruded buildings hide each other correctly.
 * The renderer lives as long as its GL context: re-adding the layer reuses it,
 * so the GPU copies of resident models are uploaded once, and a new context
 * (after a context loss) gets a new renderer.
 */
export class LandmarkModelLayer implements CustomLayerInterface {
  readonly id = LANDMARK_LAYER_ID;
  readonly type = "custom" as const;
  readonly renderingMode = "3d" as const;
  private map: MaplibreMap | undefined;
  private renderer: WebGLRenderer | undefined;
  private readonly scene = new Scene();
  private readonly camera = new Camera();
  private placed: PlacedModel[] = [];
  private drawn: string[] = [];
  private lastCamera: Float64Array | undefined;
  private unsupportedReported = false;
  private night = false;
  private readonly sun = new DirectionalLight();
  private readonly ambient = new AmbientLight();

  constructor(
    private readonly options: {
      /** The scene light to start from; `setLighting` follows its changes. */
      lighting: ModelLighting;
      onUnsupported(): void;
      onFrame?(drawn: readonly string[]): void;
    },
  ) {
    this.scene.add(this.ambient, this.sun);
    this.applyLighting(options.lighting);
  }

  /**
   * Light the models with the shared scene light. Scene space is x east,
   * y north, z up, the frame `direction` (towards the light) is given in.
   */
  setLighting(lighting: ModelLighting): void {
    if (this.applyLighting(lighting)) this.map?.triggerRepaint();
  }

  private applyLighting({
    direction,
    color,
    intensity,
    ambientColor,
    ambientIntensity,
  }: ModelLighting): boolean {
    const position = new Vector3(...direction).normalize();
    const sunColor = new Color(color);
    const skyColor = new Color(ambientColor);
    const changed =
      !this.sun.position.equals(position) ||
      !this.sun.color.equals(sunColor) ||
      this.sun.intensity !== intensity ||
      !this.ambient.color.equals(skyColor) ||
      this.ambient.intensity !== ambientIntensity;
    if (!changed) return false;
    this.sun.position.copy(position);
    this.sun.color.copy(sunColor);
    this.sun.intensity = intensity;
    this.ambient.color.copy(skyColor);
    this.ambient.intensity = ambientIntensity;
    return true;
  }

  /** Repaints only when the placement changed; callers may call this every frame. */
  setPlaced(models: readonly PlacedModel[]): void {
    const unchanged =
      models.length === this.placed.length &&
      models.every((model, i) => samePlacement(model, itemAt(this.placed, i)));
    if (unchanged) return;
    const next = new Set(models.map((p) => p.model.scene));
    for (const previous of this.placed)
      if (!next.has(previous.model.scene)) this.scene.remove(previous.model.scene);
    for (const placed of models) {
      const root = placed.model.scene;
      if (root.parent !== this.scene) this.scene.add(root);
      root.matrixAutoUpdate = false;
      placed.model.setNight(this.night);
    }
    this.placed = [...models];
    this.map?.triggerRepaint();
  }

  setNight(night: boolean): void {
    if (night === this.night) return;
    this.night = night;
    for (const placed of this.placed) placed.model.setNight(night);
    this.map?.triggerRepaint();
  }

  /** Asset ids drawn in the last frame inside the view frustum. */
  drawnAssetIds(): readonly string[] {
    return this.drawn;
  }

  /** The asset under a canvas pixel, nearest first, or null. */
  pick(point: { x: number; y: number }): string | null {
    const canvas = this.map?.getCanvas();
    if (!this.lastCamera || !canvas) return null;
    const { origin, direction } = unprojectRay(this.lastCamera, point, {
      width: canvas.clientWidth,
      height: canvas.clientHeight,
    });
    const raycaster = new Raycaster();
    raycaster.ray = new Ray(new Vector3(...origin), new Vector3(...direction));
    let best: { assetId: string; distance: number } | null = null;
    for (const placed of this.placed) {
      if (!this.drawn.includes(placed.assetId)) continue;
      const box = new Box3().setFromObject(placed.model.scene);
      if (!raycaster.ray.intersectsBox(box)) continue;
      const hit = raycaster.intersectObject(placed.model.scene, true)[0];
      if (hit && (!best || hit.distance < best.distance))
        best = { assetId: placed.assetId, distance: hit.distance };
    }
    return best?.assetId ?? null;
  }

  onAdd(map: MaplibreMap, gl: WebGL2RenderingContext): void {
    this.map = map;
    if (this.renderer?.getContext() === gl) return;
    this.disposeRenderer();
    try {
      const renderer = new WebGLRenderer({ canvas: map.getCanvas(), context: gl });
      renderer.autoClear = false;
      renderer.localClippingEnabled = true;
      this.renderer = renderer;
    } catch {
      this.renderer = undefined;
      if (!this.unsupportedReported) {
        this.unsupportedReported = true;
        this.options.onUnsupported();
      }
    }
  }

  render(_gl: WebGL2RenderingContext, args: CustomRenderMethodInput): void {
    const renderer = this.renderer;
    const map = this.map;
    if (!renderer || !map) return;
    const projection = args.defaultProjectionData;
    if (projection.projectionTransition >= GLOBE_TRANSITION_LIMIT) {
      this.drawn = [];
      return;
    }
    const center = map.getCenter();
    const origin = MercatorCoordinate.fromLngLat([center.lng, center.lat]);
    const camera = cameraMatrix(projection.mainMatrix, origin);
    this.lastCamera = camera;
    this.camera.projectionMatrix.fromArray(camera);
    this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert();

    for (const placed of this.placed) {
      const root = placed.model.scene;
      root.matrix.fromArray(
        objectMatrix(placed.anchor, placed.groundM + placed.elevationM, origin),
      );
      root.matrixWorldNeedsUpdate = true;
      const planes = placed.clipBelowGround
        ? [new Plane(new Vector3(0, 0, 1), -placed.groundM)]
        : null;
      root.traverse((object) => {
        if ((object as Mesh).isMesh)
          for (const material of materialsOf(object as Mesh)) material.clippingPlanes = planes;
      });
    }
    this.scene.updateMatrixWorld();

    const frustum = new Frustum().setFromProjectionMatrix(this.camera.projectionMatrix);
    this.drawn = this.placed
      .filter((placed) => frustum.intersectsBox(new Box3().setFromObject(placed.model.scene)))
      .map((placed) => placed.assetId);

    renderer.resetState();
    renderer.render(this.scene, this.camera);
    renderer.resetState();
    this.options.onFrame?.(this.drawn);
  }

  /** Off the map: forget the placement but keep the renderer for this GL context. */
  onRemove(): void {
    for (const placed of this.placed) this.scene.remove(placed.model.scene);
    this.placed = [];
    this.drawn = [];
  }

  /** Release the renderer; the models belong to their store and stay loaded. */
  dispose(): void {
    this.onRemove();
    this.disposeRenderer();
  }

  private disposeRenderer(): void {
    this.renderer?.dispose();
    this.renderer = undefined;
  }
}
