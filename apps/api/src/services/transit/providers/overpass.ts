import type { BBox, TransitStop, TransportMode } from "../types";

const OVERPASS_URL = "https://overpass-api.de/api/interpreter";

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
  try {
    const res = await fetch(OVERPASS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `data=${encodeURIComponent(query)}`,
    });
    if (!res.ok) return [];
    // biome-ignore lint/suspicious/noExplicitAny: external API response
    const data = (await res.json()) as { elements?: any[] };
    return (data.elements ?? []).map(
      // biome-ignore lint/suspicious/noExplicitAny: external API response
      (node: any): TransitStop => ({
        id: `osm:${node.id}`,
        name: node.tags?.name ?? node.tags?.["name:en"] ?? "Unknown",
        lat: node.lat,
        lng: node.lon,
        modes: tagsToModes(node.tags ?? {}),
        platformCode: node.tags?.ref ?? undefined,
        provider: "overpass",
      }),
    );
  } catch {
    return [];
  }
}
