import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";

/**
 * QLever's public Wikidata endpoint answers a query over every place with
 * coordinates in seconds and streams the result as TSV; the Wikidata Query
 * Service times out on the same query. Any SPARQL endpoint over the Wikidata
 * RDF dump with QLever's per-language label predicates works.
 */
export const DEFAULT_NOTABLE_PLACES_SPARQL_URL = "https://qlever.dev/api/wikidata";

/**
 * A place needs this many Wikipedia language editions to be known well beyond
 * its own town. About 136,000 places that are not settlements qualify (the
 * Eiffel Tower has 191, the Louvre 169, a regional museum around 10).
 */
export const DEFAULT_NOTABLE_MIN_SITELINKS = 8;

/**
 * A settlement needs this many to count: about 1,000 cities known worldwide
 * (Rome has 344, Cologne 190, Bamberg 100). Below it, editions written by
 * bots for every village say little, and an old town merged into Berlin
 * (Cölln, 23) must not answer "köln" there.
 */
export const NOTABLE_MIN_SETTLEMENT_SITELINKS = 100;

/**
 * Kinds of thing Wikidata gives a coordinate that are no place to go to:
 * languages (their speakers' centre), historical states and periods, sports
 * seasons and clubs, paintings, and lines round the globe. Events are left out
 * by their date instead (P585), since no class covers them cleanly. Broader
 * classes catch places too: "administrative territorial entity" includes the
 * Eiffel Tower, "business" most universities.
 */
export const NOTABLE_EXCLUDED_CLASSES = [
  "Q34770", // language
  "Q3024240", // historical country
  "Q11514315", // historical period
  "Q27020041", // sports season
  "Q847017", // sports club
  "Q3305213", // painting
  "Q146591", // circle of latitude
  "Q32099", // meridian
];

export type NotablePlaceKind = "place" | "settlement";

/**
 * Languages whose labels and aliases are searchable. `mul` is Wikidata's label
 * for all languages at once; the rest cover the names people type most often,
 * including a place's own ("Colosseo", "Tour Eiffel").
 */
export const NOTABLE_NAME_LANGUAGES = ["mul", "en", "de", "fr", "es", "it", "nl", "pl", "pt"];

/** Languages the app is shown in; their descriptions become the row's second line. */
export const NOTABLE_DESCRIPTION_LANGUAGES = ["en", "de"];

/** Labels kept per language to name a place in the app's language, `mul` the fallback. */
export const NOTABLE_DISPLAY_LANGUAGES = ["mul", ...NOTABLE_DESCRIPTION_LANGUAGES];

const PREFIXES = `PREFIX wd: <http://www.wikidata.org/entity/>
PREFIX wdt: <http://www.wikidata.org/prop/direct/>
PREFIX wikibase: <http://wikiba.se/ontology#>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
PREFIX schema: <http://schema.org/>`;

/**
 * Places with coordinates and enough sitelinks, and the cities known
 * worldwide, as `?kind`. Places leave out anything with a population (P1082)
 * or of a kind of human settlement (Q486972), which catches countries, old
 * towns and former municipalities: geocoders rank areas themselves. Cities
 * come in for their names in other languages, which geocoders do not search
 * ("rom" is Rome to a German). The sitelink count is cast: QLever compares
 * the stored `xsd:int` with a plain number as no match at all. Each branch
 * repeats the shared patterns, which QLever's planner needs.
 */
function notablePlaces(minSitelinks: number): string {
  const excluded = NOTABLE_EXCLUDED_CLASSES.map(
    (qid) => `MINUS { ?item wdt:P31/wdt:P279* wd:${qid} }`,
  );
  return `{
    ?item wdt:P625 ?coord .
    ?item wikibase:sitelinks ?links .
    FILTER(xsd:integer(?links) >= ${Math.trunc(minSitelinks)})
    MINUS { ?item wdt:P1082 ?population }
    MINUS { ?item wdt:P31/wdt:P279* wd:Q486972 }
    MINUS { ?item wdt:P585 ?when }
    ${excluded.join("\n    ")}
    BIND("place" AS ?kind)
  } UNION {
    ?item wdt:P625 ?coord .
    ?item wikibase:sitelinks ?links .
    FILTER(xsd:integer(?links) >= ${NOTABLE_MIN_SETTLEMENT_SITELINKS})
    ?item wdt:P31/wdt:P279* wd:Q486972 .
    BIND("settlement" AS ?kind)
  }`;
}

export function placesQuery(minSitelinks: number): string {
  return `${PREFIXES}
SELECT ?item ?coord ?links ?kind WHERE {
  ${notablePlaces(minSitelinks)}
}`;
}

export function namesQuery(lang: string, kind: "label" | "alias", minSitelinks: number): string {
  assertLanguage(lang);
  const predicate = kind === "label" ? "rdfs:label" : "skos:altLabel";
  return `${PREFIXES}
SELECT ?item ?name WHERE {
  ${notablePlaces(minSitelinks)}
  ?item @${lang}@${predicate} ?name
}`;
}

/** Airport codes (IATA P238, ICAO P239) shared with the airport catalog's rows for the same place. */
export const NOTABLE_CODE_PROPERTIES = { iata: "P238", icao: "P239" } as const;

export function codesQuery(property: string, minSitelinks: number): string {
  if (!/^P\d+$/.test(property)) throw new Error(`invalid property: ${property}`);
  return `${PREFIXES}
SELECT ?item ?code WHERE {
  ${notablePlaces(minSitelinks)}
  ?item wdt:${property} ?code
}`;
}

export function descriptionsQuery(lang: string, minSitelinks: number): string {
  assertLanguage(lang);
  return `${PREFIXES}
SELECT ?item ?description WHERE {
  ${notablePlaces(minSitelinks)}
  ?item @${lang}@schema:description ?description
}`;
}

function assertLanguage(lang: string): void {
  if (!/^[a-z]{2,3}$/.test(lang)) throw new Error(`invalid language code: ${lang}`);
}

const EARTH = "Q2";

/** The `?kind` a places row was found as; undefined for anything else. */
export function parseKind(cell: string): NotablePlaceKind | undefined {
  const kind = parseLiteral(cell) ?? cell;
  return kind === "place" || kind === "settlement" ? kind : undefined;
}

/** `<http://www.wikidata.org/entity/Q243>` → `Q243`; undefined for anything else. */
export function parseEntity(cell: string): string | undefined {
  return /^<http:\/\/www\.wikidata\.org\/entity\/(Q\d+)>$/.exec(cell)?.[1];
}

/** A TSV literal's text: `"Tour Eiffel"@fr` → `Tour Eiffel`, escapes undone. */
export function parseLiteral(cell: string): string | undefined {
  const match = /^"((?:[^"\\]|\\.)*)"(?:@[\w-]+|\^\^<[^>]+>)?$/.exec(cell);
  if (!match) return undefined;
  return match[1].replace(/\\(.)/g, (_, escaped: string) => {
    if (escaped === "t") return "\t";
    if (escaped === "n") return "\n";
    if (escaped === "r") return "\r";
    return escaped;
  });
}

/**
 * A WKT point as QLever writes it (`POINT(2.294479 48.858296)`) or as the
 * Wikidata Query Service does (`"Point(…)"^^<…wktLiteral>`) → `[lng, lat]`.
 * A point on another globe names it first (`<…/entity/Q405> Point(…)`, the
 * Moon) and is none of ours.
 */
export function parsePoint(cell: string): [number, number] | undefined {
  const globe = /<http:\/\/www\.wikidata\.org\/entity\/(Q\d+)>\s*POINT\(/i.exec(cell)?.[1];
  if (globe !== undefined && globe !== EARTH) return undefined;
  const match = /POINT\(\s*(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)\s*\)/i.exec(cell);
  if (!match) return undefined;
  const lng = Number(match[1]);
  const lat = Number(match[2]);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return undefined;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return undefined;
  return [lng, lat];
}

export interface SparqlFetchOptions {
  endpoint: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  /** How long to wait before each new try while the endpoint is busy. */
  retryDelaysMs?: readonly number[];
}

/**
 * A public endpoint turns bursts away for a while (QLever answers 429 to a
 * few quick queries in a row), and a monthly refresh can wait for it rather
 * than fail halfway.
 */
const BUSY_STATUSES = new Set([429, 502, 503, 504]);
const DEFAULT_RETRY_DELAYS_MS = [30_000, 60_000, 120_000];
const MAX_RETRY_AFTER_MS = 300_000;

async function postQuery(
  query: string,
  {
    endpoint,
    signal,
    fetchImpl = fetch,
    retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
  }: SparqlFetchOptions,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        Accept: "text/tab-separated-values",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "OpenMapX data-manager (+https://openmapx.org)",
      },
      body: new URLSearchParams({ query }).toString(),
      signal,
    });
    const delay = retryDelaysMs[attempt];
    if (!BUSY_STATUSES.has(response.status) || delay === undefined) return response;
    await response.body?.cancel();
    const retryAfterMs = Number(response.headers.get("retry-after")) * 1000;
    await sleep(retryAfterMs > 0 ? Math.min(retryAfterMs, MAX_RETRY_AFTER_MS) : delay, undefined, {
      signal,
    });
  }
}

/**
 * Runs `query` and yields each result row as its raw TSV cells, header
 * skipped. Rows stream as they arrive, so a few hundred thousand of them never
 * sit in memory at once.
 */
export async function* sparqlRows(
  query: string,
  options: SparqlFetchOptions,
): AsyncGenerator<string[]> {
  const response = await postQuery(query, options);
  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => "");
    throw new Error(`SPARQL endpoint answered ${response.status}: ${detail.slice(0, 300)}`);
  }
  const lines = createInterface({
    input: Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  let header = true;
  let error: string | undefined;
  for await (const line of lines) {
    if (error !== undefined) {
      // An endpoint error can arrive as a JSON body under a 200; keep enough
      // of it to say what went wrong.
      error += line.trim();
      if (error.length >= 300) break;
      continue;
    }
    if (header) {
      header = false;
      if (!line.startsWith("?")) error = line.trim();
      continue;
    }
    if (line.length > 0) yield line.split("\t");
  }
  if (error !== undefined) throw new Error(`SPARQL endpoint answered: ${error.slice(0, 300)}`);
}
