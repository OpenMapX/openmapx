import type {
  LineStringGeometry,
  MultiLineStringGeometry,
  MultiPolygonGeometry,
  OverpassElement,
  OverpassRelation,
  PolygonGeometry,
} from "./types";

/** Index all nodes by ID → [lon, lat]. */
export function buildNodeMap(elements: OverpassElement[]): Map<number, [number, number]> {
  const nodeMap = new Map<number, [number, number]>();
  for (const el of elements) {
    if (el.type === "node") {
      nodeMap.set(el.id, [el.lon, el.lat]);
    }
  }
  return nodeMap;
}

/** Index all ways by ID → node ID list. */
export function buildWayMap(elements: OverpassElement[]): Map<number, number[]> {
  const wayMap = new Map<number, number[]>();
  for (const el of elements) {
    if (el.type === "way" && el.nodes) {
      wayMap.set(el.id, el.nodes);
    }
  }
  return wayMap;
}

/** Reconstruct a LineString from a list of node IDs. Returns null if < 2 resolved coords. */
export function reconstructLineString(
  nodes: number[],
  nodeMap: Map<number, [number, number]>,
): LineStringGeometry | null {
  const coords = nodes
    .map((id) => nodeMap.get(id))
    .filter((c): c is [number, number] => c !== undefined);
  if (coords.length < 2) return null;
  return { type: "LineString", coordinates: coords };
}

/** Reconstruct a MultiLineString from a relation's way members. */
export function reconstructMultiLineString(
  relation: OverpassRelation,
  wayMap: Map<number, number[]>,
  nodeMap: Map<number, [number, number]>,
): MultiLineStringGeometry | null {
  if (!relation.members) return null;
  const coordinates = relation.members
    .filter((m) => m.type === "way")
    .map((m) => {
      const nodes = wayMap.get(m.ref) ?? [];
      return nodes
        .map((id) => nodeMap.get(id))
        .filter((c): c is [number, number] => c !== undefined);
    })
    .filter((line) => line.length > 1);
  if (coordinates.length === 0) return null;
  return { type: "MultiLineString", coordinates };
}

/** Reconstruct a closed Polygon from a way's node list. Requires >= 4 resolved coords. */
export function reconstructPolygon(
  nodes: number[],
  nodeMap: Map<number, [number, number]>,
): PolygonGeometry | null {
  const coords = nodes
    .map((id) => nodeMap.get(id))
    .filter((c): c is [number, number] => c !== undefined);
  if (coords.length < 4) return null;
  return { type: "Polygon", coordinates: [coords] };
}

/** Reconstruct a MultiPolygon from a relation's outer way members. */
export function reconstructMultiPolygon(
  relation: OverpassRelation,
  wayMap: Map<number, number[]>,
  nodeMap: Map<number, [number, number]>,
): MultiPolygonGeometry | null {
  if (!relation.members) return null;
  const outerRings = relation.members
    .filter((m) => m.type === "way" && (m.role === "outer" || m.role === ""))
    .map((m) => {
      const nodes = wayMap.get(m.ref) ?? [];
      return nodes
        .map((id) => nodeMap.get(id))
        .filter((c): c is [number, number] => c !== undefined);
    })
    .filter((ring) => ring.length >= 4);
  if (outerRings.length === 0) return null;
  return {
    type: "MultiPolygon",
    coordinates: outerRings.map((ring) => [ring]),
  };
}
