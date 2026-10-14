import type { Map as MapLibreMap } from "maplibre-gl";
import { union } from "polyclip-ts";
import { prepareRasterContainment } from "./rasterDomainContainment";

type Frame = MapLibreMap["painter"]["frameRenderContext"];
type Mesh = ReturnType<Frame["getMeshFromTileID"]>;
type Projection = ReturnType<Frame["getProjectionDataForTile"]>;
type MultiPolygon = ReturnType<typeof union>;
type Vertex = number[];
interface MeshBytes {
  vertices: Int16Array;
  indices: Uint16Array;
}
const meshes = new WeakMap<Mesh["indexBuffer"], MeshBytes>();

/** Read each immutable native mesh once. COPY_READ_BUFFER does not alter VAO,
 * ARRAY_BUFFER or ELEMENT_ARRAY_BUFFER state (including MapLibre's GL cache).
 * Restore even on failure. Engine Mesh drops its CPU arrays after upload. */
export function readNativeMesh(
  mesh: Pick<Mesh, "vertexBuffer" | "indexBuffer">,
): MeshBytes | undefined {
  const cached = meshes.get(mesh.indexBuffer);
  if (cached) return cached;
  const gl = mesh.vertexBuffer.context.gl;
  if (
    mesh.vertexBuffer.itemSize !== 4 ||
    mesh.vertexBuffer.dynamicDraw ||
    mesh.indexBuffer.dynamicDraw ||
    gl.isContextLost()
  )
    return undefined;
  const previous = gl.getParameter(gl.COPY_READ_BUFFER_BINDING) as WebGLBuffer | null;
  try {
    gl.bindBuffer(gl.COPY_READ_BUFFER, mesh.vertexBuffer.buffer);
    const size = gl.getBufferParameter(gl.COPY_READ_BUFFER, gl.BUFFER_SIZE) as number;
    if (size !== mesh.vertexBuffer.length * 4 || size > 4 * 1024 * 1024) return undefined;
    const vertices = new Int16Array(size / 2);
    gl.getBufferSubData(gl.COPY_READ_BUFFER, 0, vertices);
    gl.bindBuffer(gl.COPY_READ_BUFFER, mesh.indexBuffer.buffer);
    const indexSize = gl.getBufferParameter(gl.COPY_READ_BUFFER, gl.BUFFER_SIZE) as number;
    if (indexSize % 6 || indexSize > 8 * 1024 * 1024) return undefined;
    const indices = new Uint16Array(indexSize / 2);
    gl.getBufferSubData(gl.COPY_READ_BUFFER, 0, indices);
    const result = { vertices, indices };
    meshes.set(mesh.indexBuffer, result);
    return result;
  } catch {
    return undefined;
  } finally {
    gl.bindBuffer(gl.COPY_READ_BUFFER, previous);
  }
}
function multiply(m: ArrayLike<number>, x: number, y: number, z: number): Vertex {
  return [0, 1, 2, 3].map((i) => m[i] * x + m[4 + i] * y + m[8 + i] * z + m[12 + i]);
}
/** MapLibre 6.13 _projection_globe.vertex.glsl, zero elevation native stencil path.
 * Includes the stable zoom-dependent Mercator/globe blend and pole fade. */
export function projectGlobeVertex(x: number, y: number, p: Projection): Vertex {
  const c = p.tileMercatorCoords;
  const longitude = (c[0] + c[2] * x) * Math.PI * 2 + Math.PI;
  const t = Math.exp(Math.PI - (c[1] + c[3] * y) * Math.PI * 2);
  const cos = (2 * t) / (t * t + 1);
  let sphere = [Math.sin(longitude) * cos, (t * t - 1) / (t * t + 1), Math.cos(longitude) * cos];
  if (y < -32767.5) sphere = [0, 1, 0];
  if (y > 32766.5) sphere = [0, -1, 0];
  const position = multiply(p.mainMatrix, sphere[0], sphere[1], sphere[2]);
  const plane = p.clippingPlane;
  position[2] =
    (1 - (sphere[0] * plane[0] + sphere[1] * plane[1] + sphere[2] * plane[2] + plane[3])) *
    position[3];
  const blend = p.projectionTransition;
  if (blend <= 0.999) {
    if (y < -32767.5 || y > 32766.5) {
      const hidden = Math.max((1 - blend) / 0.02, 0) ** 8;
      position[2] = position[2] + hidden * (100 - position[2]);
    } else {
      const flat = multiply(p.fallbackMatrix, x, y, 0);
      position[2] *= Math.max(0, Math.min(1, (blend - 0.2) / 0.8));
      for (const i of [0, 1, 3]) position[i] = flat[i] + blend * (position[i] - flat[i]);
    }
  }
  position.push(x, y); // retain native tile coordinates through clipping
  return position;
}
const vertexKey = (v: Vertex) => v.join(",");
/** Clip actual triangles in homogeneous coordinates; use canonical edge order
 * so neighboring triangles calculate the exact same intersection vertices. */
function clipNativeTriangle(input: Vertex[]): Vertex[] {
  let result = input;
  const planes = [
    (v: Vertex) => v[3] + v[0],
    (v: Vertex) => v[3] - v[0],
    (v: Vertex) => v[3] + v[1],
    (v: Vertex) => v[3] - v[1],
    (v: Vertex) => v[3] + v[2],
    (v: Vertex) => v[3] - v[2],
  ];
  for (const distance of planes) {
    const out: Vertex[] = [];
    for (let i = 0; i < result.length; i++) {
      const from = result[i],
        to = result[(i + 1) % result.length];
      const df = distance(from),
        dt = distance(to);
      if (df >= 0) out.push(from);
      if (df >= 0 !== dt >= 0) {
        const [a, b] = vertexKey(from) < vertexKey(to) ? [from, to] : [to, from];
        const da = distance(a),
          db = distance(b);
        const t = da / (da - db);
        out.push(a.map((v, j) => v + t * (b[j] - v)));
      }
    }
    result = out;
  }
  return result;
}

/** Actual front/frustum-clipped native stencil domain, expressed in tile units.
 * Interior edges cancel before boolean operations; no screen-space globe hole
 * triangulation, no synthetic bridge or bbox replacing actual exposure. */
export function visibleNativeTileDomain(
  frame: Frame,
  coordinate: Parameters<Frame["getProjectionDataForTile"]>[0],
  background = false,
  opaque: MultiPolygon = [],
): MultiPolygon | undefined {
  const p = frame.getProjectionDataForTile(coordinate);
  if (
    !Number.isFinite(p.projectionTransition) ||
    p.projectionTransition < 0 ||
    p.projectionTransition > 1
  )
    return undefined;
  const mesh = readNativeMesh(
    frame.getMeshFromTileID(
      coordinate.canonical,
      !background,
      true,
      background ? "raster" : "stencil",
    ),
  );
  if (!mesh) return undefined;
  const covered = prepareRasterContainment(opaque);
  const vertices = new Map<number, Vertex>();
  const project = (index: number) => {
    let vertex = vertices.get(index);
    if (!vertex) {
      vertex = projectGlobeVertex(mesh.vertices[index * 2], mesh.vertices[index * 2 + 1], p);
      vertices.set(index, vertex);
    }
    return vertex;
  };
  const edges = new Map<string, { a: [number, number]; b: [number, number] }>();
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const indices = [mesh.indices[i], mesh.indices[i + 1], mesh.indices[i + 2]];
    const xs = indices.map((index) => mesh.vertices[index * 2]),
      ys = indices.map((index) => mesh.vertices[index * 2 + 1]);
    // Negative-only exact containment: a triangle whose entire tile-space
    // rectangle is opaque cannot intersect the final exposed query. Avoid its
    // projection/clipping work, retaining the exact final mask subtraction.
    if (covered([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)])) continue;
    const polygon = clipNativeTriangle(indices.map(project));
    if (polygon.length < 3) continue;
    if (polygon.some((v) => v[3] <= 0 || v.some((n) => !Number.isFinite(n)))) return undefined;
    const area = polygon.reduce((sum, a, j) => {
      const b = polygon[(j + 1) % polygon.length];
      return sum + (a[0] * b[1] - a[1] * b[0]) / (a[3] * b[3]);
    }, 0);
    if (area <= 0) continue; // CCW front face in GL coordinates
    const ring = polygon.map((v) => [v[4], v[5]] as [number, number]);
    for (let j = 0; j < ring.length; j++) {
      const a = ring[j],
        b = ring[(j + 1) % ring.length];
      if (a[0] === b[0] && a[1] === b[1]) continue;
      const key = `${a.join(",")}/${b.join(",")}`,
        reverse = `${b.join(",")}/${a.join(",")}`;
      if (edges.has(reverse)) edges.delete(reverse);
      else edges.set(key, { a, b });
    }
  }
  const outgoing = new Map<string, Array<{ a: [number, number]; b: [number, number] }>>();
  for (const edge of edges.values()) {
    const key = edge.a.join(",");
    const list = outgoing.get(key) ?? [];
    list.push(edge);
    outgoing.set(key, list);
  }
  const polygons: MultiPolygon = [];
  while (outgoing.size) {
    const first = outgoing.values().next().value?.[0];
    if (!first) return undefined;
    const ring: [number, number][] = [first.a];
    let current = first.a.join(",");
    for (let n = 0; n <= edges.size; n++) {
      const list = outgoing.get(current);
      if (!list?.length) return undefined;
      const edge = list.pop();
      if (!edge) return undefined;
      if (!list.length) outgoing.delete(current);
      ring.push(edge.b);
      current = edge.b.join(",");
      if (current === ring[0].join(",")) break;
      if (n === edges.size) return undefined;
    }
    if (ring.length >= 4) polygons.push([ring]);
  }
  return polygons.length ? union(polygons) : [];
}
