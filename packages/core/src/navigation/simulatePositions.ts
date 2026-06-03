import type { LngLat } from "../types/geometry";
import type { FixInput } from "./types";

interface SimulateOptions {
  stepMeters?: number;
  intervalMs?: number;
  startMs?: number;
  accuracy?: number;
  /** Constant lateral offset (meters) applied north, to simulate off-route. */
  offsetMeters?: number;
}

const EARTH = 6_378_137;
const toRad = (d: number) => (d * Math.PI) / 180;

function haversine(a: LngLat, b: LngLat): number {
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH * Math.asin(Math.sqrt(h));
}

function lerp(a: LngLat, b: LngLat, t: number): LngLat {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/** Generate GPS fixes walking along a polyline at a fixed ground spacing. */
export function simulatePositions(geometry: LngLat[], options: SimulateOptions = {}): FixInput[] {
  const stepMeters = options.stepMeters ?? 25;
  const intervalMs = options.intervalMs ?? 1000;
  const startMs = options.startMs ?? 0;
  const accuracy = options.accuracy ?? 5;
  const offsetMeters = options.offsetMeters ?? 0;
  const offsetDegLat = offsetMeters / (toRad(1) * EARTH);

  const fixes: FixInput[] = [];
  let t = 0;
  for (let i = 0; i < geometry.length - 1; i++) {
    const a = geometry[i];
    const b = geometry[i + 1];
    const segLen = haversine(a, b);
    if (segLen === 0) continue;
    for (let d = 0; d < segLen; d += stepMeters) {
      const p = lerp(a, b, d / segLen);
      fixes.push({
        coords: [p[0], p[1] + offsetDegLat],
        accuracy,
        timestampMs: startMs + t * intervalMs,
        heading: null,
        speed: null,
      });
      t++;
    }
  }
  const last = geometry[geometry.length - 1];
  fixes.push({
    coords: [last[0], last[1] + offsetDegLat],
    accuracy,
    timestampMs: startMs + t * intervalMs,
    heading: null,
    speed: null,
  });
  return fixes;
}
