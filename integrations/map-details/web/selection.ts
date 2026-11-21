import { INSTANCE_STRIDE, type Instances, type ModelKind } from "./derive/forest";
import { EARTH_CIRCUMFERENCE_M } from "./derive/units";

/** Which z16 cells to fill and which instances to draw (spec §6.4). */

const CELL_ZOOM = 16;
const MAX_CELLS = 400;
const FURNITURE_MIN_ZOOM = 17;
const TREE_KINDS = new Set<ModelKind>(["broadleaf", "conifer"]);

export const cellKey = (x: number, y: number) => `${x}/${y}`;

const lngToX = (lng: number) => ((lng + 180) / 360) * 2 ** CELL_ZOOM;
const latToY = (lat: number) => {
  const rad = (lat * Math.PI) / 180;
  return ((1 - Math.asinh(Math.tan(rad)) / Math.PI) / 2) * 2 ** CELL_ZOOM;
};

/** The z16 cells intersecting `[west, south, east, north]` plus a one-cell ring, at most 400. */
export function visibleCells(
  bounds: [number, number, number, number],
  _zoom: number,
): Array<{ x: number; y: number }> {
  const [west, south, east, north] = bounds;
  const x0 = Math.floor(lngToX(west)) - 1;
  const x1 = Math.floor(lngToX(east)) + 1;
  const y0 = Math.floor(latToY(north)) - 1;
  const y1 = Math.floor(latToY(south)) + 1;
  const cx = (x0 + x1 + 1) / 2;
  const cy = (y0 + y1 + 1) / 2;
  const cells: Array<{ x: number; y: number }> = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) cells.push({ x, y });
  if (cells.length <= MAX_CELLS) return cells;
  return cells
    .map((cell) => ({ cell, d: Math.hypot(cell.x + 0.5 - cx, cell.y + 0.5 - cy) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, MAX_CELLS)
    .map(({ cell }) => cell);
}

/** Selected instances of one kind; positions stay relative to their cell, `cell` indexes `Selection.cells`. */
export interface SelectedInstances extends Instances {
  cell: Uint16Array;
}

export interface Selection {
  near: SelectedInstances[];
  far: SelectedInstances[];
  cells: Array<{ key: string; x: number; y: number }>;
}

/**
 * The instances nearest the camera, up to the tree and furniture budgets
 * (furniture only from zoom 17), split into near and far levels of detail at
 * `nearM` metres. `cells` maps "x/y" z16 cell keys to their instances.
 */
export function selectInstances(
  cells: Map<string, Instances[]>,
  camera: { lng: number; lat: number },
  budget: { trees: number; furniture: number },
  zoom: number,
  nearM = 350,
): Selection {
  const n = 2 ** CELL_ZOOM;
  const metresPerCell = (EARTH_CIRCUMFERENCE_M * Math.cos((camera.lat * Math.PI) / 180)) / n;
  const camX = lngToX(camera.lng);
  const camY = latToY(camera.lat);
  const withFurniture = zoom >= FURNITURE_MIN_ZOOM;
  const usedCells: Selection["cells"] = [];
  const candidates: Array<{
    d: number;
    set: Instances;
    index: number;
    cell: number;
    tree: boolean;
  }> = [];
  for (const [key, sets] of cells) {
    const [x, y] = key.split("/").map(Number) as [number, number];
    // The cell's south-west corner relative to the camera, in metres (x east, y north).
    const west = (x - camX) * metresPerCell;
    const south = (camY - (y + 1)) * metresPerCell;
    const cellIndex = usedCells.length;
    let used = false;
    for (const set of sets) {
      const tree = TREE_KINDS.has(set.kind);
      if (!tree && !withFurniture) continue;
      for (let i = 0; i < set.count; i++) {
        const dx = west + (set.data[i * INSTANCE_STRIDE] as number);
        const dy = south + (set.data[i * INSTANCE_STRIDE + 1] as number);
        candidates.push({ d: Math.hypot(dx, dy), set, index: i, cell: cellIndex, tree });
        used = true;
      }
    }
    if (used) usedCells.push({ key, x, y });
  }
  candidates.sort((a, b) => a.d - b.d);

  const groups = new Map<string, Array<(typeof candidates)[number]>>();
  let trees = 0;
  let furniture = 0;
  for (const candidate of candidates) {
    if (candidate.tree ? trees >= budget.trees : furniture >= budget.furniture) continue;
    if (candidate.tree) trees++;
    else furniture++;
    const group = `${candidate.d < nearM ? "near" : "far"}|${candidate.set.kind}`;
    const list = groups.get(group) ?? [];
    list.push(candidate);
    groups.set(group, list);
  }

  // Keep only the cells something was drawn from, renumbered.
  const remap = new Map<number, number>();
  const cellsOut: Selection["cells"] = [];
  const selection: Selection = { near: [], far: [], cells: cellsOut };
  for (const [group, list] of groups) {
    const [level, kind] = group.split("|") as ["near" | "far", ModelKind];
    const data = new Float32Array(list.length * INSTANCE_STRIDE);
    const cell = new Uint16Array(list.length);
    list.forEach((candidate, i) => {
      const at = candidate.index * INSTANCE_STRIDE;
      data.set(candidate.set.data.subarray(at, at + INSTANCE_STRIDE), i * INSTANCE_STRIDE);
      let mapped = remap.get(candidate.cell);
      if (mapped === undefined) {
        mapped = cellsOut.length;
        remap.set(candidate.cell, mapped);
        cellsOut.push(usedCells[candidate.cell] as Selection["cells"][number]);
      }
      cell[i] = mapped;
    });
    selection[level].push({ kind, count: list.length, data, cell });
  }
  return selection;
}
