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
 * driving direction; the ramp leaves from the outermost lane on `point.side`.
 */
export function buildJunctionSchematic(
  model: GantryModel,
  point: JunctionDecisionPoint,
): JunctionSchematic {
  const laneCount = Math.max(1, model.laneCount);
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

  // The ramp is the outermost lane on the exit side continuing past the top
  // edge of the carriageway and bending away by the divergence angle, so the
  // highlighted lane and the ramp read as one band leaving the road.
  const mirror = point.side === "left" ? -1 : 1;
  const exitLane = point.side === "left" ? 0 : laneCount - 1;
  const laneBottom = (i: number) => left + (BOTTOM_WIDTH / laneCount) * i;
  const laneTop = (i: number) => left + topInset + (TOP_WIDTH / laneCount) * i;
  const angle = (rampAngle(point.divergenceDeg) * Math.PI) / 180;
  const peelX = mirror * Math.sin(angle) * RAMP_LEN;
  const peelY = Math.cos(angle) * RAMP_LEN * 0.6;
  const rampPath = [
    `M ${laneBottom(exitLane).toFixed(1)} ${HEIGHT}`,
    `L ${laneBottom(exitLane + 1).toFixed(1)} ${HEIGHT}`,
    `L ${(laneTop(exitLane + 1) + peelX).toFixed(1)} ${(top - peelY).toFixed(1)}`,
    `L ${(laneTop(exitLane) + peelX).toFixed(1)} ${(top - peelY).toFixed(1)}`,
    "Z",
  ].join(" ");

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
    rampPath,
    lanePolygons,
    panelAnchors,
  };
}
