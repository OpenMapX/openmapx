// Night palette adapted from alexwohlbruck/landmarks web/night-model.ts (CC0-1.0),
// https://github.com/alexwohlbruck/landmarks/tree/4d92e9c718f2f6e2ba5ff6c116d880271681614a
import type { BufferGeometry, MeshStandardMaterial } from "three";

const linear = (hex: string) =>
  [1, 3, 5].map((i) => (Number.parseInt(hex.slice(i, i + 2), 16) / 255) ** 2.2);
const FLOOD_COLOR = linear("#ffeacf");
const LAMP_COLOR = linear("#ffe7c4");
const WINDOW_GLOW = [1, 0.72, 0.4];
const AMBIENT = [0.012, 0.016, 0.03];

/**
 * The night colour of one surface: lamps, windows and entrances glow; neon
 * keeps its own hue; floodlit surfaces (the `_FLOODLIGHT` attribute) light up
 * warm; everything else falls to a dim blue ambient. Colours are linear RGB.
 */
export function nightColor(
  base: readonly number[],
  materialName: string,
  flood: number,
  light: number,
  emissive: readonly number[] = [],
): [number, number, number] {
  const glow = materialName.startsWith("lamp")
    ? LAMP_COLOR
    : materialName.startsWith("window") || materialName === "entrance"
      ? WINDOW_GLOW
      : materialName.startsWith("neon")
        ? base.slice(0, 3).map((v) => Math.min(1, v * 1.3 + 0.04))
        : null;
  const f = Math.max(0, Math.min(1, flood)) * 0.9;
  const channel = (i: number) => {
    const v = base[i] ?? 1;
    const dim = v * light * 0.16 + (AMBIENT[i] as number);
    const lit = v * (FLOOD_COLOR[i] as number) * light;
    const value = glow ? (glow[i] as number) : dim + (lit - dim) * f;
    return Math.min(1, Math.max(0, value) + (emissive[i] ?? 0));
  };
  return [channel(0), channel(1), channel(2)];
}

/**
 * Per-vertex RGBA night colours for an unlit material: the material's base
 * colour (times any vertex colour), lit softly from above by the vertex normal
 * in the model's frame, then passed through `nightColor`.
 */
export function nightVertexColors(
  geometry: BufferGeometry,
  material: MeshStandardMaterial,
): Float32Array {
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  const vertexColor = geometry.getAttribute("color");
  const floodlight = geometry.getAttribute("_floodlight");
  const count = position?.count ?? 0;
  const base = [material.color.r, material.color.g, material.color.b];
  const emissive = [material.emissive.r, material.emissive.g, material.emissive.b].map(
    (v) => v * material.emissiveIntensity,
  );
  const colors = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    const tint = vertexColor
      ? [vertexColor.getX(i), vertexColor.getY(i), vertexColor.getZ(i)]
      : [1, 1, 1];
    const [nx, ny, nz] = normal ? [normal.getX(i), normal.getY(i), normal.getZ(i)] : [0, 1, 0];
    const light = (0.72 + 0.28 * ((nx * -0.408 + ny * 0.816 + nz * 0.408) * 0.5 + 0.5)) ** 2.2;
    const flood = floodlight ? floodlight.getX(i) : 0;
    const [r, g, b] = nightColor(
      base.map((v, k) => v * (tint[k] as number)),
      material.name,
      flood,
      light,
      emissive,
    );
    const alpha =
      material.opacity * (vertexColor && vertexColor.itemSize === 4 ? vertexColor.getW(i) : 1);
    colors.set([r, g, b, alpha], i * 4);
  }
  return colors;
}
