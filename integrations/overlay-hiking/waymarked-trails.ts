import { USER_AGENT } from "@openmapx/core";
import { bboxToMercator } from "./coord-transform";

const BASE_URL = "https://hiking.waymarkedtrails.org/api/v1";

interface WaymarkedSearchResult {
  type: string;
  id: number;
  name: string;
  group: string;
  linear: string;
  symbol_description: string;
  symbol_id: string;
}

interface WaymarkedDetailResult extends WaymarkedSearchResult {
  operator?: string;
  bbox?: [number, number, number, number];
  length?: number;
  wikipedia?: Record<string, string>;
  tags?: Record<string, string>;
}

export interface TrailSummary {
  type: "relation";
  id: number;
  name: string;
  group: string;
  linear: string;
  symbolDescription: string;
  symbolId: string;
}

export interface TrailDetail extends TrailSummary {
  operator?: string;
  bbox?: [number, number, number, number];
  length?: number;
  wikipedia?: Record<string, string>;
  tags: Record<string, string>;
}

function mapSummary(r: WaymarkedSearchResult): TrailSummary {
  return {
    type: "relation",
    id: r.id,
    name: r.name || "",
    group: r.group || "LOC",
    linear: r.linear || "no",
    symbolDescription: r.symbol_description || "",
    symbolId: r.symbol_id || "",
  };
}

export async function searchTrails(query: string, limit = 20): Promise<TrailSummary[]> {
  const url = `${BASE_URL}/list/search?query=${encodeURIComponent(query)}&limit=${limit}`;
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Waymarked Trails search returned ${res.status}`);
  const data = (await res.json()) as { results: WaymarkedSearchResult[] };
  return (data.results ?? []).map(mapSummary);
}

export async function trailsByArea(
  south: number,
  west: number,
  north: number,
  east: number,
  limit = 50,
): Promise<TrailSummary[]> {
  const [mx1, my1, mx2, my2] = bboxToMercator(south, west, north, east);
  const bbox = `${mx1},${my1},${mx2},${my2}`;
  const url = `${BASE_URL}/list/by_area?bbox=${bbox}&limit=${limit}`;
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Waymarked Trails by_area returned ${res.status}`);
  const data = (await res.json()) as { results: WaymarkedSearchResult[] };
  return (data.results ?? []).map(mapSummary);
}

export async function trailDetail(id: number): Promise<TrailDetail> {
  const url = `${BASE_URL}/details/relation/${id}`;
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Waymarked Trails detail returned ${res.status}`);
  const r = (await res.json()) as WaymarkedDetailResult;
  return {
    ...mapSummary(r),
    operator: r.operator,
    bbox: r.bbox,
    length: r.length,
    wikipedia: r.wikipedia,
    tags: r.tags ?? {},
  };
}
