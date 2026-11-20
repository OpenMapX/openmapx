import {
  BufferAttribute,
  type BufferGeometry,
  type Group,
  LoadingManager,
  type Material,
  type Mesh,
  MeshBasicMaterial,
  type MeshStandardMaterial,
  type Texture,
  Vector3,
} from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { nightVertexColors } from "./night";

export type Lod = "low" | "detail";

export interface LoadedModel {
  /** `<asset id>|<lod>`. */
  key: string;
  scene: Group;
  /** Every vertex in model-root space (after node transforms), as x, y, z triplets. */
  positions: Float32Array;
  bytesEstimate: number;
  dispose(): void;
  setNight(night: boolean): void;
}

export interface ModelStoreOptions {
  apiUrl: string;
  maxInFlight?: number;
  maxResident?: number;
  maxBytes?: number;
  fetch?: typeof fetch;
}

type Failure =
  | { state: "retrying"; attempts: number; kind: "busy" | "error" }
  | { state: "skipped" };

interface Request {
  assetId: string;
  lod: Lod;
  path: string;
  priority: number;
}

const MIB = 1024 * 1024;
const OTHER_ERROR_RETRY_MS = 30_000;
const DEFAULT_RETRY_AFTER_S = 5;
const MAX_BUSY_RETRIES = 3;
const TEXTURE_SLOTS = ["map", "emissiveMap", "normalMap", "roughnessMap", "metalnessMap", "aoMap"];

const keyOf = (assetId: string, lod: Lod) => `${assetId}|${lod}`;

const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;

class ExternalResourceError extends Error {}

const isEmbedded = (uri: unknown) =>
  uri === undefined || (typeof uri === "string" && uri.startsWith("data:"));

/**
 * A landmark GLB must carry everything it needs: buffers and images either in
 * the binary chunk or as data URIs. A reference to any other URI would make
 * the browser contact a third party, which the proxy exists to prevent.
 */
function assertSelfContained(glb: ArrayBuffer): void {
  const view = new DataView(glb);
  if (glb.byteLength < 20 || view.getUint32(0, true) !== GLB_MAGIC)
    throw new ExternalResourceError("Not a binary glTF");
  const jsonLength = view.getUint32(12, true);
  if (view.getUint32(16, true) !== JSON_CHUNK || 20 + jsonLength > glb.byteLength)
    throw new ExternalResourceError("Binary glTF without a JSON chunk");
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(glb, 20, jsonLength))) as {
    buffers?: { uri?: unknown }[];
    images?: { uri?: unknown }[];
  };
  for (const entry of [...(json.buffers ?? []), ...(json.images ?? [])]) {
    if (!isEmbedded(entry.uri))
      throw new ExternalResourceError("Model references an external file");
  }
}

/** Defence in depth: the loader may only resolve embedded resources. */
function embeddedOnlyManager(): LoadingManager {
  const manager = new LoadingManager();
  manager.setURLModifier((url) =>
    url.startsWith("data:") || url.startsWith("blob:") ? url : "data:,",
  );
  return manager;
}

function meshesOf(scene: Group): Mesh[] {
  const meshes: Mesh[] = [];
  scene.traverse((object) => {
    if ((object as Mesh).isMesh) meshes.push(object as Mesh);
  });
  return meshes;
}

function materialsOf(mesh: Mesh): Material[] {
  return Array.isArray(mesh.material) ? mesh.material : [mesh.material];
}

function texturesOf(material: Material): Texture[] {
  const record = material as unknown as Record<string, unknown>;
  return TEXTURE_SLOTS.map((slot) => record[slot]).filter(
    (value): value is Texture => !!value && (value as Texture).isTexture === true,
  );
}

function rootPositions(scene: Group): Float32Array {
  scene.updateMatrixWorld(true);
  const values: number[] = [];
  const point = new Vector3();
  for (const mesh of meshesOf(scene)) {
    const position = mesh.geometry.getAttribute("position");
    if (!position) continue;
    for (let i = 0; i < position.count; i++) {
      point.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld);
      values.push(point.x, point.y, point.z);
    }
  }
  return new Float32Array(values);
}

function estimateBytes(scene: Group): number {
  let bytes = 0;
  for (const mesh of meshesOf(scene)) {
    const geometry = mesh.geometry as BufferGeometry;
    for (const attribute of Object.values(geometry.attributes))
      bytes += (attribute as BufferAttribute).array.byteLength;
    bytes += geometry.index?.array.byteLength ?? 0;
    // The night colour variant adds one RGBA float per vertex.
    bytes += (geometry.getAttribute("position")?.count ?? 0) * 16;
    for (const material of materialsOf(mesh)) {
      for (const texture of texturesOf(material)) {
        const image = texture.image as { width?: number; height?: number } | undefined;
        bytes += (image?.width ?? 0) * (image?.height ?? 0) * 4;
      }
    }
  }
  return bytes;
}

function wrapModel(key: string, scene: Group): LoadedModel {
  const meshes = meshesOf(scene);
  const day = new Map<Mesh, Mesh["material"]>(meshes.map((mesh) => [mesh, mesh.material]));
  const dayColors = new Map(meshes.map((mesh) => [mesh, mesh.geometry.getAttribute("color")]));
  let night: Map<Mesh, { material: MeshBasicMaterial; colors: BufferAttribute }> | null = null;
  let isNight = false;

  const buildNight = () => {
    const built = new Map<Mesh, { material: MeshBasicMaterial; colors: BufferAttribute }>();
    for (const mesh of meshes) {
      const source = day.get(mesh);
      if (Array.isArray(source) || !source) continue;
      const standard = source as MeshStandardMaterial;
      const colors = new BufferAttribute(nightVertexColors(mesh.geometry, standard), 4);
      const material = new MeshBasicMaterial({
        vertexColors: true,
        transparent: standard.transparent,
        opacity: standard.opacity,
        side: standard.side,
        depthWrite: standard.depthWrite,
        ...(standard.map ? { map: standard.map } : {}),
      });
      material.name = standard.name;
      built.set(mesh, { material, colors });
    }
    return built;
  };

  return {
    key,
    scene,
    positions: rootPositions(scene),
    bytesEstimate: estimateBytes(scene),
    setNight(next) {
      if (next === isNight) return;
      isNight = next;
      if (next) night ??= buildNight();
      for (const mesh of meshes) {
        const variant = night?.get(mesh);
        if (!variant) continue;
        if (next) {
          mesh.material = variant.material;
          mesh.geometry.setAttribute("color", variant.colors);
        } else {
          mesh.material = day.get(mesh) as Mesh["material"];
          const original = dayColors.get(mesh);
          if (original) mesh.geometry.setAttribute("color", original);
          else mesh.geometry.deleteAttribute("color");
        }
      }
    },
    dispose() {
      for (const mesh of meshes) {
        mesh.geometry.dispose();
        for (const material of materialsOf({ material: day.get(mesh) } as Mesh)) {
          for (const texture of texturesOf(material)) texture.dispose();
          material.dispose();
        }
      }
      for (const variant of night?.values() ?? []) variant.material.dispose();
    },
  };
}

/**
 * Loads landmark GLBs from the API with bounded concurrency, keeps a bounded
 * set resident (least recently touched evicted first, with GPU resources
 * disposed) and remembers failures so a broken model is not retried forever.
 */
export class ModelStore {
  private readonly options: Required<Omit<ModelStoreOptions, "fetch">> & { fetch: typeof fetch };
  private readonly loader = new GLTFLoader(embeddedOnlyManager());
  private readonly resident = new Map<string, LoadedModel>();
  private readonly touched = new Map<string, number>();
  private readonly queue = new Map<string, Request>();
  private readonly inFlight = new Map<string, AbortController>();
  private readonly failures = new Map<string, Failure>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly listeners = new Set<() => void>();
  private clock = 0;
  private disposed = false;

  constructor(options: ModelStoreOptions) {
    this.options = {
      apiUrl: options.apiUrl,
      maxInFlight: options.maxInFlight ?? 4,
      maxResident: options.maxResident ?? 80,
      maxBytes: options.maxBytes ?? 48 * MIB,
      fetch: options.fetch ?? ((...args) => fetch(...args)),
    };
  }

  request(assetId: string, lod: Lod, path: string, priority: number): void {
    const key = keyOf(assetId, lod);
    if (this.disposed || this.resident.has(key)) {
      this.touch(assetId);
      return;
    }
    const failure = this.failures.get(assetId);
    if (failure) return;
    const queued = this.queue.get(key);
    if (queued) queued.priority = priority;
    else if (!this.inFlight.has(key)) this.queue.set(key, { assetId, lod, path, priority });
    this.pump();
  }

  get(assetId: string, lod: Lod): LoadedModel | undefined {
    return this.resident.get(keyOf(assetId, lod));
  }

  /** The wanted level of detail if loaded, otherwise the other one. */
  best(assetId: string, wanted: Lod): LoadedModel | undefined {
    return this.get(assetId, wanted) ?? this.get(assetId, wanted === "detail" ? "low" : "detail");
  }

  touch(assetId: string): void {
    this.clock += 1;
    for (const lod of ["low", "detail"] as const) {
      const key = keyOf(assetId, lod);
      if (this.resident.has(key)) this.touched.set(key, this.clock);
    }
  }

  /** Drop queued and in-flight loads of assets no longer wanted. */
  cancelExcept(wanted: ReadonlySet<string>): void {
    for (const [key, request] of this.queue)
      if (!wanted.has(request.assetId)) this.queue.delete(key);
    for (const [key, controller] of this.inFlight) {
      if (!wanted.has(key.slice(0, key.lastIndexOf("|")))) {
        controller.abort();
        this.inFlight.delete(key);
      }
    }
    this.pump();
  }

  failure(assetId: string): "none" | "retrying" | "skipped" {
    return this.failures.get(assetId)?.state ?? "none";
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.disposed = true;
    for (const controller of this.inFlight.values()) controller.abort();
    for (const timer of this.timers) clearTimeout(timer);
    for (const model of this.resident.values()) model.dispose();
    this.inFlight.clear();
    this.queue.clear();
    this.resident.clear();
    this.listeners.clear();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  private pump(): void {
    while (!this.disposed && this.inFlight.size < this.options.maxInFlight && this.queue.size > 0) {
      let next: [string, Request] | undefined;
      for (const entry of this.queue)
        if (!next || entry[1].priority < next[1].priority) next = entry;
      if (!next) return;
      this.queue.delete(next[0]);
      void this.load(next[0], next[1]);
    }
  }

  private later(ms: number, run: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      run();
    }, ms);
    this.timers.add(timer);
  }

  private retry(request: Request, kind: "busy" | "error", delayMs: number): void {
    const previous = this.failures.get(request.assetId);
    const attempts =
      previous?.state === "retrying" && previous.kind === kind ? previous.attempts + 1 : 1;
    const limit = kind === "busy" ? MAX_BUSY_RETRIES : 1;
    if (attempts > limit) {
      this.failures.set(request.assetId, { state: "skipped" });
      this.notify();
      return;
    }
    this.failures.set(request.assetId, { state: "retrying", attempts, kind });
    this.later(delayMs, () => {
      if (this.disposed) return;
      const current = this.failures.get(request.assetId);
      if (current?.state !== "retrying") return;
      this.queue.set(keyOf(request.assetId, request.lod), request);
      this.pump();
    });
  }

  private async load(key: string, request: Request): Promise<void> {
    const controller = new AbortController();
    this.inFlight.set(key, controller);
    try {
      const response = await this.options.fetch(`${this.options.apiUrl}${request.path}`, {
        signal: controller.signal,
      });
      if (response.status === 404) {
        this.failures.set(request.assetId, { state: "skipped" });
        this.notify();
        return;
      }
      if (response.status === 503) {
        const seconds = Number(response.headers.get("retry-after")) || DEFAULT_RETRY_AFTER_S;
        this.retry(request, "busy", seconds * 1000);
        return;
      }
      if (!response.ok) throw new Error(`Landmark model answered ${response.status}`);
      const glb = await response.arrayBuffer();
      try {
        assertSelfContained(glb);
      } catch {
        this.failures.set(request.assetId, { state: "skipped" });
        this.notify();
        return;
      }
      const gltf = await this.loader.parseAsync(glb, "");
      if (this.disposed || controller.signal.aborted) return;
      const model = wrapModel(key, gltf.scene);
      this.failures.delete(request.assetId);
      this.resident.set(key, model);
      this.clock += 1;
      this.touched.set(key, this.clock);
      this.evict(key);
      this.notify();
    } catch {
      if (controller.signal.aborted || this.disposed) return;
      this.retry(request, "error", OTHER_ERROR_RETRY_MS);
    } finally {
      if (this.inFlight.get(key) === controller) this.inFlight.delete(key);
      this.pump();
    }
  }

  private evict(keep: string): void {
    const total = () => [...this.resident.values()].reduce((sum, m) => sum + m.bytesEstimate, 0);
    while (this.resident.size > this.options.maxResident || total() > this.options.maxBytes) {
      let oldest: string | undefined;
      for (const key of this.resident.keys()) {
        if (key === keep) continue;
        if (!oldest || (this.touched.get(key) ?? 0) < (this.touched.get(oldest) ?? 0)) oldest = key;
      }
      if (!oldest) return;
      this.resident.get(oldest)?.dispose();
      this.resident.delete(oldest);
      this.touched.delete(oldest);
    }
  }
}
