import {
  bilinear,
  cameraMatrix,
  instanceMatrix,
  type MercatorOrigin,
  mercatorOrigin,
} from "@openmapx/core";
import type {
  CustomLayerInterface,
  CustomRenderMethodInput,
  Map as MaplibreMap,
} from "maplibre-gl";
import {
  AmbientLight,
  type BufferGeometry,
  Camera,
  Color,
  DirectionalLight,
  InstancedMesh,
  type MeshBasicMaterial,
  MeshLambertMaterial,
  Scene,
  Vector3,
  WebGLRenderer,
} from "three";
import { INSTANCE_STRIDE, type ModelKind } from "./derive/forest";
import { EARTH_CIRCUMFERENCE_M, tileCentreLat } from "./derive/units";
import {
  applyPalette,
  buildModel,
  contactShadowGeometry,
  contactShadowMaterial,
  type Palette,
} from "./models";
import type { Selection } from "./selection";

export const OBJECTS_LAYER_ID = "openmapx-map-details-objects";

/** The three.js side of the shared scene light; `night` selects the night palette. */
export interface ObjectLighting {
  /** Towards the light, in scene space (x east, y north, z up). */
  direction: [number, number, number];
  color: string;
  intensity: number;
  ambientColor: string;
  ambientIntensity: number;
  night: boolean;
}

/** Below this the globe has fully blended to the flat map at street zoom. */
const GLOBE_TRANSITION_LIMIT = 0.01;
/** At night the objects read as dim silhouettes rather than black. */
const NIGHT_AMBIENT_FLOOR = 0.35;
const TERRAIN_GRID = 9;
const SHADOW_PER_CROWN = 1.3;
const TREE_KINDS = new Set<ModelKind>(["broadleaf", "conifer"]);

type Terrain = Float32Array | "pending" | null;

/**
 * Draws forests and street objects as instanced procedural models inside
 * MapLibre's 3D pass, sharing its depth buffer. One instanced mesh per model
 * and level of detail. Instance matrices are written relative to the origin
 * given with the instances; `render` only sets the camera and draws.
 */
export class MapDetailsObjectsLayer implements CustomLayerInterface {
  readonly id = OBJECTS_LAYER_ID;
  readonly type = "custom" as const;
  readonly renderingMode = "3d" as const;
  private map: MaplibreMap | undefined;
  private renderer: WebGLRenderer | undefined;
  private unsupportedReported = false;
  private readonly scene = new Scene();
  private readonly camera = new Camera();
  private readonly sun = new DirectionalLight();
  private readonly ambient = new AmbientLight();
  private readonly material = new MeshLambertMaterial({ vertexColors: true });
  private readonly shadowMaterial: MeshBasicMaterial = contactShadowMaterial();
  private readonly geometries = new Map<string, BufferGeometry>();
  private readonly meshes = new Map<string, InstancedMesh>();
  private shadows: InstancedMesh;
  private selection: Selection | null = null;
  private origin: MercatorOrigin | null = null;
  private readonly terrain = new Map<string, Terrain>();
  private satellite = false;
  private palette: Palette = "day";

  constructor(private readonly options: { lighting: ObjectLighting; onUnsupported(): void }) {
    this.scene.add(this.ambient, this.sun);
    this.shadows = this.createShadows(0);
    this.applyLighting(options.lighting);
  }

  /** The instanced meshes by "kind|lod" (for tests and diagnostics). */
  instancedMeshes(): ReadonlyMap<string, InstancedMesh> {
    return this.meshes;
  }

  shadowMesh(): InstancedMesh {
    return this.shadows;
  }

  ambientIntensity(): number {
    return this.ambient.intensity;
  }

  /** New instances around `origin` ([lng, lat]); repaints. */
  setInstances(selection: Selection, origin: [number, number]): void {
    this.selection = selection;
    this.origin = mercatorOrigin(origin[0], origin[1]);
    this.layout();
    this.map?.triggerRepaint();
  }

  setLighting(lighting: ObjectLighting): void {
    if (this.applyLighting(lighting)) this.map?.triggerRepaint();
  }

  setSatellite(on: boolean): void {
    if (on === this.satellite) return;
    this.satellite = on;
    this.layout();
    this.map?.triggerRepaint();
  }

  setTerrain(cellKey: string, grid: Terrain): void {
    if ((this.terrain.get(cellKey) ?? null) === grid) return;
    this.terrain.set(cellKey, grid);
    this.layout();
    this.map?.triggerRepaint();
  }

  private applyLighting(lighting: ObjectLighting): boolean {
    const position = new Vector3(...lighting.direction).normalize();
    const sunColor = new Color(lighting.color);
    const skyColor = new Color(lighting.ambientColor);
    const ambient = lighting.night
      ? Math.max(lighting.ambientIntensity, NIGHT_AMBIENT_FLOOR)
      : lighting.ambientIntensity;
    const palette: Palette = lighting.night ? "night" : "day";
    const changed =
      !this.sun.position.equals(position) ||
      !this.sun.color.equals(sunColor) ||
      this.sun.intensity !== lighting.intensity ||
      !this.ambient.color.equals(skyColor) ||
      this.ambient.intensity !== ambient ||
      palette !== this.palette;
    if (!changed) return false;
    this.sun.position.copy(position);
    this.sun.color.copy(sunColor);
    this.sun.intensity = lighting.intensity;
    this.ambient.color.copy(skyColor);
    this.ambient.intensity = ambient;
    if (palette !== this.palette) {
      this.palette = palette;
      for (const geometry of this.geometries.values()) applyPalette(geometry, palette);
    }
    return true;
  }

  private geometry(kind: ModelKind, lod: "near" | "far"): BufferGeometry {
    const key = `${kind}|${lod}`;
    let geometry = this.geometries.get(key);
    if (!geometry) {
      geometry = buildModel(kind, lod);
      applyPalette(geometry, this.palette);
      this.geometries.set(key, geometry);
    }
    return geometry;
  }

  private meshFor(kind: ModelKind, lod: "near" | "far", needed: number): InstancedMesh {
    const key = `${kind}|${lod}`;
    const existing = this.meshes.get(key);
    if (existing && existing.instanceMatrix.count >= needed) return existing;
    const capacity = Math.max(needed, (existing?.instanceMatrix.count ?? 0) * 2, 16);
    const mesh = new InstancedMesh(this.geometry(kind, lod), this.material, capacity);
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = 1;
    if (existing) {
      this.scene.remove(existing);
      existing.dispose();
    }
    this.scene.add(mesh);
    this.meshes.set(key, mesh);
    return mesh;
  }

  private createShadows(capacity: number): InstancedMesh {
    const mesh = new InstancedMesh(
      contactShadowGeometry(),
      this.shadowMaterial,
      Math.max(capacity, 16),
    );
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    // Discs darken the ground before the trees stand on it.
    mesh.renderOrder = 0;
    mesh.count = 0;
    this.scene.add(mesh);
    return mesh;
  }

  /** Write every visible instance's matrix relative to the origin. */
  private layout(): void {
    for (const mesh of this.meshes.values()) mesh.count = 0;
    this.shadows.count = 0;
    const { selection, origin } = this;
    if (!selection || !origin) return;
    const matrix = new Float32Array(16);
    const tint = new Color();
    const shadowRows: number[][] = [];
    const cells = selection.cells.map((cell) => {
      const lat = tileCentreLat(16, cell.y);
      const size = (EARTH_CIRCUMFERENCE_M * Math.cos((lat * Math.PI) / 180)) / 2 ** 16;
      const corner = { x: cell.x / 2 ** 16, y: (cell.y + 1) / 2 ** 16 };
      // Ground metres in the cell, scaled to the origin's metres (Mercator scale).
      const k =
        1 / (EARTH_CIRCUMFERENCE_M * Math.cos((lat * Math.PI) / 180)) / origin.metersToUnits;
      return {
        size,
        k,
        east: (corner.x - origin.x) / origin.metersToUnits,
        north: -(corner.y - origin.y) / origin.metersToUnits,
        terrain: this.terrain.get(cell.key) ?? null,
      };
    });
    for (const level of ["near", "far"] as const) {
      for (const set of selection[level]) {
        const mesh = this.meshFor(set.kind, level, set.count);
        const tree = TREE_KINDS.has(set.kind);
        let n = 0;
        for (let i = 0; i < set.count; i++) {
          const cell = cells[set.cell[i] as number];
          if (!cell || cell.terrain === "pending") continue;
          const d = set.data.subarray(i * INSTANCE_STRIDE, (i + 1) * INSTANCE_STRIDE);
          const [x, y, heading, height, crown, , jitter, mapped] = d as unknown as number[];
          if (this.satellite && mapped === 0) continue;
          const ground = cell.terrain
            ? bilinear(
                cell.terrain,
                TERRAIN_GRID,
                (x as number) / cell.size,
                (y as number) / cell.size,
              )
            : 0;
          const px = cell.east + (x as number) * cell.k;
          const py = cell.north + (y as number) * cell.k;
          const pz = ground * cell.k;
          instanceMatrix(
            matrix,
            0,
            px,
            py,
            pz,
            heading as number,
            (tree ? (crown as number) : (height as number)) * cell.k,
            (height as number) * cell.k,
          );
          mesh.instanceMatrix.array.set(matrix, n * 16);
          const shade = 1 + (jitter as number);
          mesh.setColorAt(n, tint.setRGB(shade, shade, shade));
          if (tree) shadowRows.push([px, py, pz, (crown as number) * SHADOW_PER_CROWN * cell.k]);
          n++;
        }
        mesh.count = n;
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      }
    }
    if (shadowRows.length > this.shadows.instanceMatrix.count) {
      this.scene.remove(this.shadows);
      this.shadows.dispose();
      this.shadows = this.createShadows(shadowRows.length * 2);
    }
    shadowRows.forEach(([px, py, pz, size], i) => {
      instanceMatrix(matrix, 0, px as number, py as number, pz as number, 0, size as number, 1);
      this.shadows.instanceMatrix.array.set(matrix, i * 16);
    });
    this.shadows.count = shadowRows.length;
    this.shadows.instanceMatrix.needsUpdate = true;
  }

  onAdd(map: MaplibreMap, gl: WebGL2RenderingContext): void {
    this.map = map;
    if (this.renderer?.getContext() === gl) return;
    this.disposeRenderer();
    try {
      const renderer = new WebGLRenderer({ canvas: map.getCanvas(), context: gl });
      renderer.autoClear = false;
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
    if (!renderer || !this.origin) return;
    const projection = args.defaultProjectionData;
    if (projection.projectionTransition >= GLOBE_TRANSITION_LIMIT) return;
    this.camera.projectionMatrix.fromArray(cameraMatrix(projection.mainMatrix, this.origin));
    this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert();
    renderer.resetState();
    renderer.render(this.scene, this.camera);
    renderer.resetState();
  }

  /** Off the map: keep the renderer for this GL context and the instances for a re-add. */
  onRemove(): void {}

  dispose(): void {
    for (const mesh of this.meshes.values()) mesh.dispose();
    this.meshes.clear();
    for (const geometry of this.geometries.values()) geometry.dispose();
    this.geometries.clear();
    this.shadows.geometry.dispose();
    this.shadows.dispose();
    this.material.dispose();
    this.shadowMaterial.map?.dispose();
    this.shadowMaterial.dispose();
    this.disposeRenderer();
  }

  private disposeRenderer(): void {
    this.renderer?.dispose();
    this.renderer = undefined;
  }
}
