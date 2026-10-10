import type { GantryModel, JunctionDecisionPoint, JunctionSchematic } from "../types/junction";

/**
 * Deterministic schematic geometry for one decision point, in a 320×140
 * viewBox. The carriageway is a perspective trapezoid (wide at the bottom,
 * narrow at the top), the lanes are bands across it, and the ramp peels off
 * the exit side with an angle proportional to the divergence. Pure numbers and
 * path strings — React only draws them.
 */

const WIDTH = 320;
const HEIGHT = 140;
const BOTTOM_WIDTH = 280;
const TOP_WIDTH = 120;
const RAMP_LEN = 46;

/** The ramp angle, clamped so a 3° drift and a 90° split both read sensibly. */
function rampAngle(divergenceDeg: number): number {
  return Math.min(Math.max(Math.abs(divergenceDeg), 8), 45);
}

/**
 * Build the schematic for one decision point. The lanes run left to right in
 * driving direction. A ramp is drawn only for a contiguous group of known
 * exit lanes reaching the edge on `point.side`.
 */
export function buildJunctionSchematic(
  model: GantryModel,
  point: JunctionDecisionPoint,
): JunctionSchematic {
  const laneCount = model.laneCount;
  if (laneCount < 1) {
    return {
      width: WIDTH,
      height: HEIGHT,
      laneCount: 0,
      activeLanes: [],
      side: point.side,
      divergenceDeg: point.divergenceDeg,
      throughPath: "",
      rampPath: "",
      lanePolygons: [],
      panelAnchors: [],
    };
  }
  const left = (WIDTH - BOTTOM_WIDTH) / 2;
  const right = left + BOTTOM_WIDTH;
  const topInset = (BOTTOM_WIDTH - TOP_WIDTH) / 2;
  const top = HEIGHT * 0.42;

  const throughPath = `M ${left} ${HEIGHT} L ${left + topInset} ${top} L ${right - topInset} ${top} L ${right} ${HEIGHT} Z`;

  const lanePolygons: string[] = [];
  for (let i = 0; i < laneCount; i += 1) {
    const x0b = left + (BOTTOM_WIDTH / laneCount) * i;
    const x1b = left + (BOTTOM_WIDTH / laneCount) * (i + 1);
    const x0t = left + topInset + (TOP_WIDTH / laneCount) * i;
    const x1t = left + topInset + (TOP_WIDTH / laneCount) * (i + 1);
    lanePolygons.push(
      `M ${x0b.toFixed(1)} ${HEIGHT} L ${x0t.toFixed(1)} ${top} L ${x1t.toFixed(1)} ${top} L ${x1b.toFixed(1)} ${HEIGHT} Z`,
    );
  }

  // Start above the bands: painting the ramp over them erases the seams of a
  // multi-lane exit. Do not bridge unconfirmed lanes to the carriageway edge.
  const mirror = point.side === "left" ? -1 : 1;
  const exitLanes = [...model.activeLanes].sort((a, b) => a - b);
  const first = exitLanes[0];
  const last = exitLanes.at(-1);
  const contiguous =
    first !== undefined &&
    last !== undefined &&
    exitLanes.every((lane, index) => lane === first + index) &&
    first >= 0 &&
    last < laneCount &&
    (point.side === "left" ? first === 0 : last === laneCount - 1);
  const laneTop = (i: number) => left + topInset + (TOP_WIDTH / laneCount) * i;
  const angle = (rampAngle(point.divergenceDeg) * Math.PI) / 180;
  const peelX = mirror * Math.sin(angle) * RAMP_LEN;
  const peelY = Math.cos(angle) * RAMP_LEN * 0.6;
  const rampPath = contiguous
    ? [
        `M ${laneTop(first).toFixed(1)} ${top}`,
        `L ${laneTop(last + 1).toFixed(1)} ${top}`,
        `L ${(laneTop(last + 1) + peelX).toFixed(1)} ${(top - peelY).toFixed(1)}`,
        `L ${(laneTop(first) + peelX).toFixed(1)} ${(top - peelY).toFixed(1)}`,
        "Z",
      ].join(" ")
    : "";

  const branches = model.branches?.map((branch, index, all) => {
    const x = 70 + (180 * index) / Math.max(1, all.length - 1);
    const path = `M 160 ${top} Q ${x} ${top - 10} ${x} 8`;
    const count = branch.laneCount;
    const lanePaths =
      count === undefined
        ? []
        : Array.from({ length: count }, (_, lane) => {
            const end = x + (lane - (count - 1) / 2) * 8;
            return `M 160 ${top} Q ${end} ${top - 10} ${end} 8`;
          });
    return { wayId: branch.wayId, selected: branch.selected, path, lanePaths };
  });

  const panelAnchors = model.panels.map((panel) => {
    const first = panel.lanes[0] ?? 0;
    const last = panel.lanes.at(-1) ?? first;
    const topStart = left + topInset + (TOP_WIDTH / laneCount) * first;
    const topEnd = left + topInset + (TOP_WIDTH / laneCount) * (last + 1);
    return { x: Number(((topStart + topEnd) / 2).toFixed(2)), y: top - 6 };
  });

  return {
    width: WIDTH,
    height: HEIGHT,
    laneCount,
    // The model's lanes, not the engine's: the bands drawn are the model's, and
    // where its lane count differs from the engine's, or the engine sent no
    // lanes, the model has already worked out which of them the exit leaves from.
    activeLanes: model.activeLanes,
    side: point.side,
    divergenceDeg: point.divergenceDeg,
    throughPath,
    rampPath: branches ? "" : rampPath,
    lanePolygons,
    panelAnchors,
    ...(branches ? { branches } : {}),
  };
}
