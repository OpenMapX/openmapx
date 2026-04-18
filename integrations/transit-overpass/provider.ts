import type { BBox, OverpassNode, TransitStop, TransportMode } from "@openmapx/core";
import { overpassQuerySafe } from "@openmapx/core";

function tagsToModes(tags: Record<string, string>): TransportMode[] {
  const modes: TransportMode[] = [];
  if (
    tags.train === "yes" ||
    tags.light_rail === "yes" ||
    tags.railway === "stop" ||
    tags.railway === "halt"
  )
    modes.push("rail");
  if (tags.subway === "yes") modes.push("subway");
  if (tags.tram === "yes") modes.push("tram");
  if (tags.bus === "yes") modes.push("bus");
  if (tags.ferry === "yes") modes.push("ferry");
  if (tags.monorail === "yes") modes.push("monorail");
  if (tags.gondola === "yes" || tags.aerialway === "gondola") modes.push("gondola");
  if (tags.funicular === "yes" || tags.aerialway === "funicular") modes.push("funicular");
  if (tags.aerialway === "cable_car") modes.push("cable_car");
  return modes.length ? modes : ["bus"];
}

export async function getStops(bbox: BBox): Promise<TransitStop[]> {
  const [w, s, e, n] = bbox;
  const query = `[out:json][timeout:25];node["public_transport"="stop_position"](${s},${w},${n},${e});out body;`;

  const data = await overpassQuerySafe(query, null);
  if (!data) return [];

  // Query returns only nodes, safe to cast
  const nodes = data.elements as unknown as OverpassNode[];
  return nodes.map((node) => {
    const tags = node.tags ?? {};
    return {
      // Canonical OSM ref form so the `osm:` place resolver can round-trip
      // it — transit stops from Overpass are always nodes.
      id: `osm:node/${node.id}`,
      name: tags.name ?? tags["name:en"] ?? "Unknown",
      lat: node.lat,
      lng: node.lon,
      modes: tagsToModes(tags),
      platformCode: tags.ref ?? undefined,
      provider: "overpass" as const,
    };
  });
}
