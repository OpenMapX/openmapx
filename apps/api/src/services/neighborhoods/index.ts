import type { KnowledgeResult, NeighborhoodCard, OverpassElement, Place } from "@openmapx/core";
import { overpassQuery } from "@openmapx/core";
import { getPlaceKnowledge } from "../knowledge/index.js";

/** Settlement sub-divisions we surface as "neighbourhoods" in the city panel. */
const NEIGHBORHOOD_PLACE = "suburb|neighbourhood|quarter|borough|city_block";

/** Cap on enriched cards returned to the client. */
const MAX_NEIGHBORHOODS = 12;

const OSM_REF_PREFIX: Record<string, string> = {
  node: "node",
  way: "way",
  relation: "relation",
};

function buildQuery(south: number, west: number, north: number, east: number): string {
  const bbox = `${south},${west},${north},${east}`;
  return (
    `[out:json][timeout:25];(` +
    `node["place"~"^(${NEIGHBORHOOD_PLACE})$"](${bbox});` +
    `way["place"~"^(${NEIGHBORHOOD_PLACE})$"](${bbox});` +
    `relation["place"~"^(${NEIGHBORHOOD_PLACE})$"](${bbox});` +
    `);out center tags;`
  );
}

interface RawNeighborhood {
  id: string;
  name: string;
  lat: number;
  lng: number;
  tags: Record<string, string>;
  /** Sort hint — entries with an encyclopaedic reference rank higher. */
  hasWiki: boolean;
}

function elementCenter(el: OverpassElement): { lat: number; lng: number } | null {
  if (el.type === "node") return { lat: el.lat, lng: el.lon };
  // Ways and relations carry a `center` only when queried with `out center`.
  const center = (el as { center?: { lat: number; lon: number } }).center;
  if (center) return { lat: center.lat, lng: center.lon };
  return null;
}

function extractRaw(elements: OverpassElement[]): RawNeighborhood[] {
  const seen = new Set<string>();
  const out: RawNeighborhood[] = [];
  for (const el of elements) {
    const tags = el.tags;
    const name = tags?.name;
    if (!tags || !name) continue;
    const center = elementCenter(el);
    if (!center) continue;
    // De-dupe by name — OSM often carries both a node and a boundary relation
    // for the same suburb.
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: `${OSM_REF_PREFIX[el.type]}/${el.id}`,
      name,
      lat: center.lat,
      lng: center.lng,
      tags,
      hasWiki: Boolean(tags.wikipedia || tags.wikidata),
    });
  }
  return out;
}

/** First sentence of a Wikipedia extract, trimmed to a card-friendly length. */
function firstSentence(extract: string): string {
  const match = extract.match(/^.*?[.!?](?:\s|$)/);
  const sentence = (match ? match[0] : extract).trim();
  return sentence.length > 160 ? `${sentence.slice(0, 157).trimEnd()}…` : sentence;
}

async function enrich(raw: RawNeighborhood, lang?: string): Promise<NeighborhoodCard> {
  const card: NeighborhoodCard = {
    id: raw.id,
    name: raw.name,
    coordinates: [raw.lng, raw.lat],
  };
  if (!raw.hasWiki) return card;

  // Reuse the place knowledge pipeline (Wikipedia + Wikidata) by handing it a
  // minimal place-like object built from the OSM tags.
  const place = {
    osmTags: raw.tags,
    coordinates: [raw.lng, raw.lat],
    name: raw.name,
  } as Place;
  const knowledge = await getPlaceKnowledge(place, lang).catch((): KnowledgeResult => ({}));

  const extract = knowledge.wikipediaExtract ?? knowledge.description;
  if (extract) card.description = firstSentence(extract);
  if (knowledge.wikipediaUrl) card.wikipediaUrl = knowledge.wikipediaUrl;
  const photo = knowledge.photos?.[0];
  if (photo) card.photoUrl = photo.thumbnailUrl ?? photo.url;
  return card;
}

/**
 * Neighbourhoods within a bounding box for the city place panel. Queries
 * Overpass for sub-municipal settlements, ranks encyclopaedically-referenced
 * ones first, and enriches the top {@link MAX_NEIGHBORHOODS} with a Wikipedia
 * photo + first-sentence blurb. Returns an empty list on any Overpass failure
 * so the panel section self-hides rather than erroring.
 */
export async function fetchNeighborhoods(
  south: number,
  west: number,
  north: number,
  east: number,
  lang?: string,
): Promise<{ neighborhoods: NeighborhoodCard[] }> {
  const data = await overpassQuery(buildQuery(south, west, north, east));
  const raw = extractRaw(data.elements as OverpassElement[]);

  raw.sort((a, b) => {
    if (a.hasWiki !== b.hasWiki) return a.hasWiki ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const top = raw.slice(0, MAX_NEIGHBORHOODS);
  const neighborhoods = await Promise.all(top.map((n) => enrich(n, lang)));
  return { neighborhoods };
}
