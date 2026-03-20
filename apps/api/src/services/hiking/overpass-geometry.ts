import { overpassQuery } from "../overpass";

/**
 * Overpass `out body geom` returns inline geometry on members,
 * which extends the standard element shape.
 */
interface GeomElement {
  type: string;
  id: number;
  tags?: Record<string, string>;
  geometry?: Array<{ lat: number; lon: number }>;
  members?: Array<{
    type: string;
    ref: number;
    role: string;
    geometry?: Array<{ lat: number; lon: number }>;
  }>;
}

interface GeomFeature {
  type: "Feature";
  geometry: { type: "LineString"; coordinates: [number, number][] };
  properties: { sac_scale: string; surface: string; highway: string };
}

export async function fetchRouteGeometry(
  relationId: number,
): Promise<{ type: "FeatureCollection"; features: GeomFeature[] }> {
  const query = `[out:json][timeout:25];relation(${relationId});out body geom;way(r);out body;`;
  const raw = await overpassQuery(query);
  const elements = raw.elements as unknown as GeomElement[];

  const features: GeomFeature[] = [];

  for (const el of elements) {
    if (el.type === "relation" && el.members) {
      for (const member of el.members) {
        if (member.type !== "way" || !member.geometry || member.geometry.length < 2) continue;

        const coordinates: [number, number][] = member.geometry.map((p) => [p.lon, p.lat]);
        const wayEl = elements.find((e) => e.type === "way" && e.id === member.ref);
        const tags = wayEl?.tags ?? {};

        features.push({
          type: "Feature",
          geometry: { type: "LineString", coordinates },
          properties: {
            sac_scale: tags.sac_scale ?? "",
            surface: tags.surface ?? "",
            highway: tags.highway ?? "",
          },
        });
      }
    }

    if (el.type === "way" && el.geometry && el.geometry.length >= 2) {
      const coordinates: [number, number][] = el.geometry.map((p) => [p.lon, p.lat]);
      const tags = el.tags ?? {};
      features.push({
        type: "Feature",
        geometry: { type: "LineString", coordinates },
        properties: {
          sac_scale: tags.sac_scale ?? "",
          surface: tags.surface ?? "",
          highway: tags.highway ?? "",
        },
      });
    }
  }

  return { type: "FeatureCollection", features };
}
