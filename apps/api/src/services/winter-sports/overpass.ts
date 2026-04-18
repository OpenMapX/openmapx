import type { LineStringGeometry, MultiLineStringGeometry, OverpassElement } from "@openmapx/core";
import {
  buildNodeMap,
  buildWayMap,
  overpassQuery,
  reconstructLineString,
  reconstructMultiLineString,
  reconstructMultiPolygon,
  reconstructPolygon,
} from "@openmapx/core";
import type {
  WinterSportsArea,
  WinterSportsFeaturesResponse,
  WinterSportsLift,
  WinterSportsPiste,
} from "./types";

function buildPistesAndLiftsQuery(
  south: number,
  west: number,
  north: number,
  east: number,
): string {
  const bbox = `${south},${west},${north},${east}`;
  return `[out:json][timeout:30];(way["piste:type"](${bbox});relation["piste:type"](${bbox});way["aerialway"~"cable_car|gondola|chair_lift|mixed_lift|drag_lift|t-bar|j-bar|platter|rope_tow|magic_carpet"](${bbox}););out body;>;out skel qt;`;
}

function buildAreasQuery(south: number, west: number, north: number, east: number): string {
  const bbox = `${south},${west},${north},${east}`;
  return `[out:json][timeout:20];(way["landuse"="winter_sports"](${bbox});relation["landuse"="winter_sports"](${bbox});relation["site"="piste"](${bbox}););out body;>;out skel qt;`;
}

function parseBool(tags: Record<string, string>, key: string): boolean {
  return tags[key] === "yes";
}

function parseNullableBool(tags: Record<string, string>, key: string): boolean | null {
  if (tags[key] === "yes") return true;
  if (tags[key] === "no") return false;
  return null;
}

function parseNullableInt(tags: Record<string, string>, key: string): number | null {
  const val = tags[key];
  if (!val) return null;
  const n = Number.parseInt(val, 10);
  return Number.isFinite(n) ? n : null;
}

function extractPistes(elements: OverpassElement[]): WinterSportsPiste[] {
  const nodeMap = buildNodeMap(elements);
  const wayMap = buildWayMap(elements);
  const pistes: WinterSportsPiste[] = [];

  for (const el of elements) {
    const tags = el.tags ?? {};
    if (!tags["piste:type"]) continue;

    let geometry: LineStringGeometry | MultiLineStringGeometry | null = null;

    if (el.type === "way" && el.nodes) {
      geometry = reconstructLineString(el.nodes, nodeMap);
    } else if (el.type === "relation") {
      geometry = reconstructMultiLineString(el, wayMap, nodeMap);
    }

    if (!geometry) continue;

    pistes.push({
      id: `osm:${el.type}/${el.id}`,
      name: tags["piste:name"] || tags.name || "",
      type: tags["piste:type"],
      difficulty: tags["piste:difficulty"] || "",
      grooming: tags["piste:grooming"] || "",
      lit: parseBool(tags, "piste:lit"),
      snowmaking: parseBool(tags, "piste:snowmaking"),
      ref: tags["piste:ref"] || tags.ref || "",
      geometry,
    });
  }

  return pistes;
}

function extractLifts(elements: OverpassElement[]): WinterSportsLift[] {
  const nodeMap = buildNodeMap(elements);
  const lifts: WinterSportsLift[] = [];

  for (const el of elements) {
    if (el.type !== "way" || !el.nodes) continue;
    const tags = el.tags ?? {};
    if (!tags.aerialway) continue;

    const geometry = reconstructLineString(el.nodes, nodeMap);
    if (!geometry) continue;

    lifts.push({
      id: `osm:way/${el.id}`,
      name: tags.name || "",
      aerialway: tags.aerialway,
      occupancy: parseNullableInt(tags, "aerialway:occupancy"),
      capacity: parseNullableInt(tags, "aerialway:capacity"),
      duration: parseNullableInt(tags, "aerialway:duration"),
      detachable: parseNullableBool(tags, "aerialway:detachable"),
      bubble: parseNullableBool(tags, "aerialway:bubble"),
      heating: parseNullableBool(tags, "aerialway:heating"),
      geometry,
    });
  }

  return lifts;
}

function extractAreas(elements: OverpassElement[]): WinterSportsArea[] {
  const nodeMap = buildNodeMap(elements);
  const wayMap = buildWayMap(elements);
  const areas: WinterSportsArea[] = [];

  for (const el of elements) {
    const tags = el.tags ?? {};
    if (tags.landuse !== "winter_sports" && tags.site !== "piste") continue;

    let geometry: ReturnType<typeof reconstructPolygon | typeof reconstructMultiPolygon> = null;

    if (el.type === "way" && el.nodes) {
      geometry = reconstructPolygon(el.nodes, nodeMap);
    } else if (el.type === "relation") {
      geometry = reconstructMultiPolygon(el, wayMap, nodeMap);
    }

    if (!geometry) continue;

    areas.push({
      id: `osm:${el.type}/${el.id}`,
      name: tags.name || "",
      geometry,
    });
  }

  return areas;
}

export async function fetchWinterSportsFeatures(
  south: number,
  west: number,
  north: number,
  east: number,
): Promise<WinterSportsFeaturesResponse> {
  const query = buildPistesAndLiftsQuery(south, west, north, east);
  const areasQuery = buildAreasQuery(south, west, north, east);

  const [mainResult, areasResult] = await Promise.allSettled([
    overpassQuery(query),
    overpassQuery(areasQuery),
  ]);

  if (mainResult.status === "rejected") throw mainResult.reason;

  const pistes = extractPistes(mainResult.value.elements);
  const lifts = extractLifts(mainResult.value.elements);
  const areas = areasResult.status === "fulfilled" ? extractAreas(areasResult.value.elements) : [];

  return { pistes, lifts, areas };
}
