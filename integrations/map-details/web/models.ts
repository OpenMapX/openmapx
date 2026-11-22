import {
  AddEquation,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  ConeGeometry,
  CustomBlending,
  CylinderGeometry,
  DataTexture,
  IcosahedronGeometry,
  LinearFilter,
  MeshBasicMaterial,
  OneFactor,
  PlaneGeometry,
  SrcColorFactor,
  ZeroFactor,
} from "three";
import type { ModelKind } from "./derive/forest";

/**
 * Procedural low-poly models for the objects layer (spec §6.4), built in code
 * once per session. Scene frame: x east, y north (the model's front), z up.
 * Every model stands on z = 0 and is one unit tall; trees are one unit wide,
 * so instances scale them by crown (x, y) and height (z). Vertex colours come
 * from a material role per vertex and a day or night palette.
 */

export const MATERIAL_ROLES = [
  "crown",
  "trunk",
  "metal",
  "wood",
  "lens",
  "sign_red",
  "sign_white",
] as const;
export type MaterialRole = (typeof MATERIAL_ROLES)[number];
export type Palette = "day" | "night";

// Sign faces are retroreflective, so at night they stay brighter than the metal around them.
export const ROLE_COLOURS: Record<Palette, Record<MaterialRole, number>> = {
  day: {
    crown: 0x5d8c4a,
    trunk: 0x6b4f3a,
    metal: 0x59636d,
    wood: 0x8a6a4a,
    lens: 0x2b2b2b,
    sign_red: 0xc8102e,
    sign_white: 0xf2f2f2,
  },
  night: {
    crown: 0x1f2f1c,
    trunk: 0x2a2119,
    metal: 0x2a3036,
    wood: 0x382b20,
    lens: 0xffd28a,
    sign_red: 0x8a1626,
    sign_white: 0x9a9a9a,
  },
};

interface Part {
  geometry: BufferGeometry;
  role: MaterialRole;
}

/** A three.js primitive (y up) turned to stand along z, then moved. */
function upright(geometry: BufferGeometry, x: number, y: number, z: number): BufferGeometry {
  return geometry.rotateX(Math.PI / 2).translate(x, y, z);
}

function merge(parts: Part[]): BufferGeometry {
  const pieces = parts.map(({ geometry, role }) => {
    const flat = geometry.index ? geometry.toNonIndexed() : geometry;
    flat.computeVertexNormals();
    return { flat, role: MATERIAL_ROLES.indexOf(role) };
  });
  const count = pieces.reduce((sum, { flat }) => sum + flat.getAttribute("position").count, 0);
  const position = new Float32Array(count * 3);
  const normal = new Float32Array(count * 3);
  const role = new Float32Array(count);
  let offset = 0;
  for (const piece of pieces) {
    const p = piece.flat.getAttribute("position");
    const n = piece.flat.getAttribute("normal");
    position.set(p.array as Float32Array, offset * 3);
    normal.set(n.array as Float32Array, offset * 3);
    role.fill(piece.role, offset, offset + p.count);
    offset += p.count;
    piece.flat.dispose();
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(position, 3));
  geometry.setAttribute("normal", new BufferAttribute(normal, 3));
  geometry.setAttribute("role", new BufferAttribute(role, 1));
  geometry.setAttribute("color", new BufferAttribute(new Float32Array(count * 3), 3));
  return geometry;
}

/** A lumpy ellipsoid crown: unit sphere dented by up to 8 % away from the poles. */
function crown(detail: number, centreZ: number, halfHeight: number): BufferGeometry {
  const geometry = new IcosahedronGeometry(1, detail);
  const position = geometry.getAttribute("position");
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    // Three.js builds the sphere y up: its poles are ±y.
    const dent = 1 - 0.08 * (1 - Math.abs(y)) * (0.5 + 0.5 * Math.sin(7 * x + 3 * z));
    position.setXYZ(i, x * dent, y * dent, z * dent);
  }
  // An icosahedron has no vertex on its axes: stretch it to reach exactly ±1 on each.
  geometry.computeBoundingBox();
  const { min, max } = geometry.boundingBox as NonNullable<BufferGeometry["boundingBox"]>;
  geometry.scale(
    1 / Math.max(-min.x, max.x),
    1 / Math.max(-min.y, max.y),
    1 / Math.max(-min.z, max.z),
  );
  return upright(geometry, 0, 0, 0).scale(0.5, 0.5, halfHeight).translate(0, 0, centreZ);
}

function broadleaf(lod: "near" | "far"): Part[] {
  const near = lod === "near";
  return [
    {
      geometry: upright(new CylinderGeometry(0.035, 0.045, 0.4, near ? 6 : 4, 1, true), 0, 0, 0.2),
      role: "trunk",
    },
    { geometry: crown(near ? 1 : 0, 0.64, 0.36), role: "crown" },
  ];
}

function conifer(lod: "near" | "far"): Part[] {
  const trunk: Part = {
    geometry: upright(
      new CylinderGeometry(0.03, 0.04, 0.25, lod === "near" ? 6 : 4, 1, true),
      0,
      0,
      0.125,
    ),
    role: "trunk",
  };
  if (lod === "far")
    return [
      trunk,
      { geometry: upright(new ConeGeometry(0.5, 0.85, 6), 0, 0, 0.575), role: "crown" },
    ];
  const tiers: Array<[number, number, number]> = [
    [0.5, 0.45, 0.15],
    [0.4, 0.4, 0.4],
    [0.28, 0.35, 0.65],
  ];
  return [
    trunk,
    ...tiers.map(([radius, height, base]) => ({
      geometry: upright(new ConeGeometry(radius, height, 8), 0, 0, base + height / 2),
      role: "crown" as const,
    })),
  ];
}

const box = (w: number, d: number, h: number, x: number, y: number, z: number) =>
  new BoxGeometry(w, d, h).translate(x, y, z);

function lampArm(): Part[] {
  return [
    {
      geometry: upright(new CylinderGeometry(0.008, 0.012, 0.97, 6, 1, true), 0, 0, 0.485),
      role: "metal",
    },
    { geometry: box(0.012, 0.25, 0.012, 0, 0.125, 0.96), role: "metal" },
    { geometry: box(0.05, 0.09, 0.025, 0, 0.25, 0.95), role: "metal" },
    { geometry: box(0.04, 0.07, 0.006, 0, 0.25, 0.936), role: "lens" },
  ];
}

function lampLantern(): Part[] {
  return [
    {
      geometry: upright(new CylinderGeometry(0.01, 0.014, 0.9, 6, 1, true), 0, 0, 0.45),
      role: "metal",
    },
    { geometry: upright(new CylinderGeometry(0.04, 0.03, 0.07, 6), 0, 0, 0.935), role: "lens" },
    { geometry: upright(new ConeGeometry(0.05, 0.03, 6), 0, 0, 0.985), role: "metal" },
  ];
}

function signal(): Part[] {
  // Lenses face +y: three.js cylinders already run along y.
  const lens = (z: number) => new CylinderGeometry(0.022, 0.022, 0.01, 8).translate(0, 0.08, z);
  return [
    {
      geometry: upright(new CylinderGeometry(0.012, 0.014, 0.72, 6, 1, true), 0, 0, 0.36),
      role: "metal",
    },
    { geometry: box(0.085, 0.07, 0.26, 0, 0.04, 0.85), role: "metal" },
    { geometry: lens(0.92), role: "lens" },
    { geometry: lens(0.85), role: "lens" },
    { geometry: lens(0.78), role: "lens" },
  ];
}

/** A thin grey sign post, three quarters of the model's height. */
function signPost(): Part {
  return {
    geometry: upright(new CylinderGeometry(0.012, 0.012, 0.76, 6, 1, true), 0, 0, 0.38),
    role: "metal",
  };
}

function stopSign(): Part[] {
  // A flat 8-sided cylinder along y is an octagon facing +y; turned a sixteenth
  // so its top edge is flat.
  const face = new CylinderGeometry(0.13, 0.13, 0.008, 8).rotateY(Math.PI / 8);
  return [signPost(), { geometry: face.translate(0, 0.014, 0.85), role: "sign_red" }];
}

function giveWaySign(): Part[] {
  // A 3-sided cylinder along y is a triangle facing +y with a corner on top;
  // turned half a circle, the corner points down.
  const triangle = (radius: number, depth: number, y: number) =>
    new CylinderGeometry(radius, radius, depth, 3).rotateY(Math.PI).translate(0, y, 0.85);
  return [
    signPost(),
    { geometry: triangle(0.15, 0.008, 0.014), role: "sign_red" },
    { geometry: triangle(0.09, 0.004, 0.02), role: "sign_white" },
  ];
}

function bench(): Part[] {
  // The sitter faces +y, so the backrest is on the −y side.
  return [
    { geometry: box(2, 0.5, 0.06, 0, 0, 0.5), role: "wood" },
    { geometry: box(2, 0.06, 0.44, 0, -0.22, 0.775), role: "wood" },
    ...[-0.85, 0.85].flatMap((x) => [
      { geometry: box(0.06, 0.45, 0.47, x, 0, 0.235), role: "metal" as const },
    ]),
  ];
}

/** A model's geometry with `position`, `normal`, `role` and `color` attributes (colours unset). */
export function buildModel(kind: ModelKind, lod: "near" | "far"): BufferGeometry {
  switch (kind) {
    case "broadleaf":
      return merge(broadleaf(lod));
    case "conifer":
      return merge(conifer(lod));
    case "lamp_arm":
      return merge(lampArm());
    case "lamp_lantern":
      return merge(lampLantern());
    case "signal":
      return merge(signal());
    case "bench":
      return merge(bench());
    case "stop":
      return merge(stopSign());
    case "give_way":
      return merge(giveWaySign());
  }
}

/** Write the palette's colours into the geometry's `color` attribute by material role. */
export function applyPalette(geometry: BufferGeometry, palette: Palette): void {
  const role = geometry.getAttribute("role");
  const colour = geometry.getAttribute("color") as BufferAttribute;
  const colours = MATERIAL_ROLES.map((name) => new Color(ROLE_COLOURS[palette][name]));
  for (let i = 0; i < role.count; i++) {
    const c = colours[role.getX(i)] as Color;
    colour.setXYZ(i, c.r, c.g, c.b);
  }
  colour.needsUpdate = true;
}

/** A unit square on the ground for one contact shadow (two triangles). */
export function contactShadowGeometry(): BufferGeometry {
  return new PlaneGeometry(1, 1).translate(0, 0, 0.02);
}

/** A radial falloff: dark in the middle, white (no change) at the rim. */
function shadowTexture(): DataTexture {
  const size = 32;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const r = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) / (size / 2);
      const value = Math.round(255 * (1 - 0.35 * Math.max(0, 1 - r) ** 1.5));
      data.set([value, value, value, 255], (y * size + x) * 4);
    }
  const texture = new DataTexture(data, size, size);
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Multiplies the colour already drawn (darkens the ground under a tree) and
 * keeps the canvas alpha, so the map underneath never turns transparent.
 */
export function contactShadowMaterial(): MeshBasicMaterial {
  return new MeshBasicMaterial({
    map: shadowTexture(),
    blending: CustomBlending,
    blendEquation: AddEquation,
    blendSrc: ZeroFactor,
    blendDst: SrcColorFactor,
    blendSrcAlpha: ZeroFactor,
    blendDstAlpha: OneFactor,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
}
