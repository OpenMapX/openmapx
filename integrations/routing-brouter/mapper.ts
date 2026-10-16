import {
  haversineDistance,
  type LngLat,
  type Route,
  type RouteStep,
  type RoutingOptions,
} from "@openmapx/core";
import { createTranslator } from "@openmapx/i18n";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid BRouter object");
  return value as Record<string, unknown>;
}
function metric(value: unknown): number {
  if ((typeof value !== "number" && typeof value !== "string") || value === "")
    throw new Error("Missing BRouter metric");
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error("Invalid BRouter metric");
  return n;
}
/** Minimum-distance ordered waypoint assignment. Endpoints are fixed, so loops
 * and repeat visits cannot be mistaken for an earlier destination occurrence. */
function waypointIndices(geometry: LngLat[], waypoints: LngLat[]): number[] {
  if (waypoints.length < 2 || geometry.length < waypoints.length)
    throw new Error("Invalid BRouter waypoints");
  const n = geometry.length;
  let costs = new Float64Array(n).fill(Infinity);
  costs[0] = 0;
  const predecessors: Int32Array[] = [];
  for (let w = 1; w < waypoints.length - 1; w++) {
    const next = new Float64Array(n).fill(Infinity),
      prev = new Int32Array(n).fill(-1);
    let best = Infinity,
      bestIndex = -1;
    for (let i = 1; i < n - 1; i++) {
      if (costs[i - 1] < best) {
        best = costs[i - 1];
        bestIndex = i - 1;
      }
      const distance = haversineDistance(geometry[i], waypoints[w]);
      if (distance <= 1000 && Number.isFinite(best)) {
        next[i] = best + distance;
        prev[i] = bestIndex;
      }
    }
    costs = next;
    predecessors.push(prev);
  }
  let last = 0;
  if (predecessors.length) {
    let best = Infinity;
    for (let i = 1; i < n - 1; i++)
      if (costs[i] < best) {
        best = costs[i];
        last = i;
      }
    if (!Number.isFinite(best)) throw new Error("BRouter waypoint is not on the route");
  }
  const indices = [n - 1];
  for (let w = predecessors.length - 1; w >= 0; w--) {
    indices.unshift(last);
    last = predecessors[w][last];
  }
  indices.unshift(0);
  return indices;
}

const COMMANDS: Record<number, { key: string; type: string; modifier?: string }> = {
  1: { key: "continue", type: "continue", modifier: "straight" },
  2: { key: "left", type: "turn", modifier: "left" },
  3: { key: "slightLeft", type: "turn", modifier: "slight left" },
  4: { key: "sharpLeft", type: "turn", modifier: "sharp left" },
  5: { key: "right", type: "turn", modifier: "right" },
  6: { key: "slightRight", type: "turn", modifier: "slight right" },
  7: { key: "sharpRight", type: "turn", modifier: "sharp right" },
  8: { key: "keepLeft", type: "fork", modifier: "slight left" },
  9: { key: "keepRight", type: "fork", modifier: "slight right" },
  10: { key: "uturn", type: "turn", modifier: "uturn" },
  11: { key: "uturn", type: "turn", modifier: "uturn" },
  12: { key: "offRoute", type: "continue" },
  13: { key: "roundabout", type: "roundabout" },
  14: { key: "roundabout", type: "roundabout" },
  15: { key: "uturn", type: "turn", modifier: "uturn" },
  16: { key: "beeline", type: "continue" },
  17: { key: "exitLeft", type: "off ramp", modifier: "left" },
  18: { key: "exitRight", type: "off ramp", modifier: "right" },
};

export function mapBrouterRoute(
  raw: unknown,
  waypoints: LngLat[],
  options: RoutingOptions = {},
): Route {
  const features = record(raw).features;
  if (!Array.isArray(features)) throw new Error("No BRouter route");
  const line = features.map(record).find((f) => record(f.geometry).type === "LineString");
  if (!line) throw new Error("No BRouter route geometry");
  const coords = record(line.geometry).coordinates;
  if (!Array.isArray(coords) || coords.length < 2 || coords.length > 250000)
    throw new Error("Invalid BRouter geometry");
  const geometry: LngLat[] = coords.map((c: unknown) => {
    if (
      !Array.isArray(c) ||
      c.length < 2 ||
      !Number.isFinite(c[0]) ||
      !Number.isFinite(c[1]) ||
      Math.abs(c[0]) > 180 ||
      Math.abs(c[1]) > 90
    )
      throw new Error("Invalid BRouter coordinate");
    return [c[0], c[1]];
  });
  const properties = record(line.properties),
    distance = metric(properties["track-length"]),
    duration = metric(properties["total-time"]);
  const times = properties.times;
  if (
    !Array.isArray(times) ||
    times.length !== geometry.length ||
    times.some(
      (v, i) =>
        typeof v !== "number" || !Number.isFinite(v) || v < 0 || (i > 0 && v < times[i - 1]),
    ) ||
    times[0] !== 0
  )
    throw new Error("Invalid BRouter times");
  const timeEnd = times.at(-1) as number;
  if (duration > 0 && timeEnd <= 0) throw new Error("Missing BRouter travel times");
  const cumulative = [0];
  for (let i = 1; i < geometry.length; i++)
    cumulative.push(cumulative[i - 1] + haversineDistance(geometry[i - 1], geometry[i]));
  const total = cumulative[cumulative.length - 1];
  if (total <= 0) throw new Error("Empty BRouter route");
  const indices = waypointIndices(geometry, waypoints);
  const hints = properties.voicehints === undefined ? [] : properties.voicehints;
  if (!Array.isArray(hints)) throw new Error("Invalid BRouter maneuvers");
  const commands = new Map<
    number,
    { key: string; type: string; modifier?: string; exit?: number; drivingSide?: "left" | "right" }
  >();
  let previous = -1;
  for (const h of hints) {
    if (
      !Array.isArray(h) ||
      !Number.isInteger(h[0]) ||
      h[0] < 0 ||
      h[0] >= geometry.length ||
      h[0] <= previous ||
      !COMMANDS[h[1]]
    )
      throw new Error("Invalid BRouter maneuver");
    previous = h[0];
    const cmd = COMMANDS[h[1]];
    if (cmd.type === "roundabout" && (!Number.isInteger(h[2]) || h[2] === 0))
      throw new Error("Invalid BRouter roundabout exit");
    commands.set(h[0], {
      ...cmd,
      ...(cmd.type === "roundabout"
        ? {
            exit: Math.abs(h[2]),
            drivingSide: h[1] === 14 ? ("left" as const) : ("right" as const),
          }
        : {}),
    });
  }
  const t = createTranslator(options.lang, "directions.bikeManeuvers");
  const legs = indices.slice(0, -1).map((start, legIndex) => {
    const end = indices[legIndex + 1];
    const starts = [start, ...[...commands.keys()].filter((i) => i > start && i < end)];
    const steps: RouteStep[] = starts.map((index, i) => {
      const next = starts[i + 1] ?? end;
      const cmd =
        index === 0
          ? { key: "depart", type: "depart" }
          : (commands.get(index) ?? { key: "continue", type: "continue" });
      return {
        instruction: t(cmd.key, { exit: cmd.exit ?? 0 }),
        distance: ((cumulative[next] - cumulative[index]) / total) * distance,
        duration: timeEnd === 0 ? 0 : ((times[next] - times[index]) / timeEnd) * duration,
        coordinates: geometry.slice(index, next + 1),
        maneuver: { type: cmd.type, ...(cmd.modifier ? { modifier: cmd.modifier } : {}) },
        ...(cmd.exit ? { roundaboutExitCount: cmd.exit } : {}),
        ...(cmd.drivingSide ? { drivingSide: cmd.drivingSide } : {}),
      };
    });
    // A zero-length arrival cue does not interrupt guidance at intermediate stops.
    if (legIndex === indices.length - 2)
      steps.push({
        instruction: t("arrive"),
        distance: 0,
        duration: 0,
        coordinates: [geometry[end]],
        maneuver: { type: "arrive" },
      });
    return {
      distance: ((cumulative[end] - cumulative[start]) / total) * distance,
      duration: timeEnd === 0 ? 0 : ((times[end] - times[start]) / timeEnd) * duration,
      geometry: geometry.slice(start, end + 1),
      steps,
    };
  });
  const result: Route = {
    distance,
    duration,
    geometry,
    legs,
    steps: legs.flatMap((l) => l.steps),
    mode: "cycling",
    sourceIds: ["brouter"],
  };
  if (coords.every((c) => Array.isArray(c) && typeof c[2] === "number" && Number.isFinite(c[2]))) {
    const count = Math.max(1, Math.min(10000, Math.ceil(distance / 30))),
      interval = distance / count;
    let segment = 1;
    result.elevation = Array.from({ length: count + 1 }, (_, i) => {
      const target = (i / count) * total;
      while (segment < cumulative.length - 1 && cumulative[segment] < target) segment++;
      const span = cumulative[segment] - cumulative[segment - 1];
      const ratio = span > 0 ? (target - cumulative[segment - 1]) / span : 0;
      return coords[segment - 1][2] + ratio * (coords[segment][2] - coords[segment - 1][2]);
    });
    result.elevationInterval = interval;
  }
  return result;
}
