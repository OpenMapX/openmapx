import type { RoadConditionEvent } from "./types.js";

const CLUSTER_METERS = 60;

/** A representative [lon,lat] for proximity tests; first vertex of any geometry. */
function representativePoint(geometry: RoadConditionEvent["geometry"]): [number, number] | null {
  const g = geometry as { type: string; coordinates?: unknown };
  let c: unknown = g.coordinates;
  while (Array.isArray(c) && Array.isArray(c[0])) c = c[0];
  if (Array.isArray(c) && typeof c[0] === "number" && typeof c[1] === "number") {
    return [c[0], c[1]];
  }
  return null;
}

function haversineMeters(a: [number, number], b: [number, number]): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function words(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );
}

function headlineSimilar(a: string, b: string): boolean {
  const wa = words(a);
  const wb = words(b);
  if (wa.size === 0 || wb.size === 0) return false;
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  const union = wa.size + wb.size - inter;
  return union > 0 && inter / union >= 0.5;
}

function newer(a: RoadConditionEvent, b: RoadConditionEvent): RoadConditionEvent {
  const ta = a.dataUpdatedAt ? Date.parse(a.dataUpdatedAt) : 0;
  const tb = b.dataUpdatedAt ? Date.parse(b.dataUpdatedAt) : 0;
  return tb > ta ? b : a;
}

/**
 * Merges duplicate road-condition events across providers. First collapses exact
 * `id` matches, then clusters same-`type` events within {@link CLUSTER_METERS}
 * with similar headlines (so NDW and TomTom reporting the same accident become
 * one). The newest `dataUpdatedAt` survives, keeping its own provider/source.
 *
 * O(n²) within coordinate buckets; fine for a bbox query's few hundred events.
 */
export function dedupeRoadConditionEvents(events: RoadConditionEvent[]): RoadConditionEvent[] {
  if (events.length === 0) return [];

  const byId = new Map<string, RoadConditionEvent>();
  for (const e of events) {
    const prev = byId.get(e.id);
    byId.set(e.id, prev ? newer(prev, e) : e);
  }
  const unique = [...byId.values()];

  const survivors: RoadConditionEvent[] = [];
  for (const e of unique) {
    const p = representativePoint(e.geometry);
    const dupIdx = survivors.findIndex((s) => {
      if (s.type !== e.type) return false;
      const sp = representativePoint(s.geometry);
      if (!p || !sp) return false;
      if (haversineMeters(p, sp) > CLUSTER_METERS) return false;
      return headlineSimilar(s.headline, e.headline);
    });
    if (dupIdx === -1) {
      survivors.push(e);
    } else {
      survivors[dupIdx] = newer(survivors[dupIdx]!, e);
    }
  }
  return survivors;
}
