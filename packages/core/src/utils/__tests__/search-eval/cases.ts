import type { AutocompleteResult } from "../../../types/geocoding";
import type { LngLat } from "../../../types/geometry";

/**
 * One thing a good answer must contain: a row among the first `within` that
 * matches every given field.
 */
export interface Expectation {
  within: number;
  /** Case-insensitive regular expression source, tested against the label. */
  label?: string;
  type?: AutocompleteResult["type"];
  id?: string;
  /** The row lies within this many kilometres of `near` (default: the case's map centre). */
  nearKm?: number;
  near?: LngLat;
}

export interface EvalCase {
  id: string;
  query: string;
  lang: string;
  /** Map centre and zoom the search is typed at. */
  center: LngLat;
  zoom: number;
  /** Rows that must be shown; may be empty when only `enter` matters. */
  expect: Expectation[];
  /**
   * What plain Enter must do: open a row meeting the expectation (its
   * `within` is ignored), search the visible area, or leave the list open to
   * choose from. Unset when it does not matter for the case.
   */
  enter?: { open: Omit<Expectation, "within"> } | "search" | "choose";
  /**
   * Why a case is known to fail today. Known gaps are scored but not asserted,
   * so they show up in the report without blocking; fixing one means deleting
   * this and letting the case be asserted.
   */
  knownGap?: string;
}

const BERLIN: LngLat = [13.405, 52.52];
const MUNICH: LngLat = [11.575, 48.137];
const PARIS: LngLat = [2.3522, 48.8566];
const NEW_YORK: LngLat = [-73.9855, 40.758];
const LONDON: LngLat = [-0.1276, 51.5072];
const ROME: LngLat = [12.4829, 41.8933];
const AACHEN: LngLat = [6.084, 50.775];
const OSLO: LngLat = [10.752, 59.911];
const GERMANY: LngLat = [10.45, 51.16];

const at = (center: LngLat, zoom: number) => ({ center, zoom });
const berlin = at(BERLIN, 14);

/**
 * Golden queries for the search box: what someone typing this, looking at
 * this map, should find near the top. Recorded provider responses for each
 * live in `fixtures/` (see scripts/record-search-eval.mts).
 */
export const EVAL_CASES: EvalCase[] = [
  {
    id: "berlin-coffee",
    query: "coffee",
    lang: "en",
    ...berlin,
    expect: [
      { within: 1, type: "category", id: "category-cafes" },
      { within: 3, label: "coffee", type: "poi", nearKm: 3 },
    ],
  },
  {
    id: "berlin-cafe",
    query: "cafe",
    lang: "en",
    ...berlin,
    expect: [{ within: 1, id: "category-cafes" }],
  },
  {
    id: "berlin-alexanderplatz",
    query: "alexanderplatz",
    lang: "en",
    ...berlin,
    expect: [{ within: 1, label: "^alexanderplatz", nearKm: 2 }],
  },
  {
    id: "berlin-alexanderpl-prefix",
    query: "alexanderpl",
    lang: "en",
    ...berlin,
    expect: [{ within: 1, label: "^alexanderplatz", nearKm: 2 }],
  },
  {
    id: "berlin-ikea",
    query: "ikea",
    lang: "en",
    ...berlin,
    expect: [{ within: 3, label: "ikea", nearKm: 30 }],
  },
  {
    id: "berlin-pizza",
    query: "pizza",
    lang: "en",
    ...berlin,
    expect: [{ within: 3, label: "pizza", nearKm: 10 }],
  },
  {
    id: "berlin-rewe",
    query: "rewe",
    lang: "en",
    ...berlin,
    expect: [{ within: 3, label: "rewe", nearKm: 15 }],
  },
  {
    id: "berlin-kudamm-21",
    query: "kurfürstendamm 21",
    lang: "de",
    ...berlin,
    expect: [{ within: 1, label: "kurfürstendamm 21", nearKm: 15 }],
  },
  {
    id: "berlin-museumsinsel",
    query: "museumsinsel",
    lang: "de",
    ...berlin,
    expect: [{ within: 1, label: "museumsinsel", nearKm: 5 }],
  },
  {
    id: "berlin-brandenburger-tor",
    query: "brandenburger tor",
    lang: "de",
    ...berlin,
    expect: [{ within: 1, label: "brandenburger tor", nearKm: 5 }],
  },
  {
    id: "berlin-hauptbahnhof",
    query: "berlin hauptbahnhof",
    lang: "de",
    ...berlin,
    expect: [{ within: 1, label: "hauptbahnhof", nearKm: 5 }],
  },
  {
    id: "berlin-fernsehturm",
    query: "fernsehturm",
    lang: "de",
    ...berlin,
    expect: [{ within: 1, label: "fernsehturm", nearKm: 5 }],
  },
  {
    id: "berlin-tegel",
    query: "tegel",
    lang: "de",
    ...berlin,
    expect: [{ within: 3, label: "tegel", nearKm: 20 }],
  },
  {
    id: "berlin-tempelhof",
    query: "tempelhof",
    lang: "de",
    ...berlin,
    expect: [{ within: 3, label: "tempelhof", nearKm: 15 }],
  },
  {
    id: "berlin-charite",
    query: "charité",
    lang: "de",
    ...berlin,
    expect: [{ within: 3, label: "charit", nearKm: 10 }],
  },
  {
    id: "berlin-kaufland",
    query: "kaufland",
    lang: "de",
    ...berlin,
    expect: [{ within: 3, label: "kaufland", nearKm: 20 }],
  },
  {
    id: "berlin-starbucks",
    query: "starbucks",
    lang: "en",
    ...berlin,
    expect: [{ within: 3, label: "starbucks" }],
  },
  {
    id: "berlin-mcdonalds",
    query: "mcdonalds",
    lang: "en",
    ...berlin,
    expect: [{ within: 3, label: "mcdonald" }],
  },
  {
    id: "berlin-apotheke",
    query: "apotheke",
    lang: "de",
    ...berlin,
    expect: [{ within: 1, id: "category-pharmacies" }],
  },
  {
    id: "berlin-supermarkt",
    query: "supermarkt",
    lang: "de",
    ...berlin,
    expect: [{ within: 1, type: "category", label: "^supermarkt" }],
  },
  {
    id: "berlin-paris",
    query: "paris",
    lang: "en",
    ...berlin,
    expect: [{ within: 1, label: "^paris", nearKm: 30, near: PARIS }],
  },
  {
    id: "berlin-hamburg",
    query: "hamburg",
    lang: "de",
    ...berlin,
    expect: [{ within: 1, label: "^hamburg", nearKm: 20, near: [9.99, 53.55] }],
  },
  {
    id: "berlin-munchen",
    query: "münchen",
    lang: "de",
    ...berlin,
    expect: [{ within: 1, label: "^münchen", nearKm: 20, near: MUNICH }],
  },
  {
    id: "berlin-heathrow",
    query: "london heathrow",
    lang: "en",
    ...berlin,
    expect: [{ within: 3, label: "heathrow", nearKm: 30, near: LONDON }],
  },
  {
    id: "berlin-lax",
    query: "LAX",
    lang: "en",
    ...berlin,
    expect: [{ within: 1, label: "los angeles", nearKm: 30, near: [-118.41, 33.94] }],
  },
  {
    id: "berlin-ber",
    query: "BER",
    lang: "en",
    ...berlin,
    expect: [{ within: 3, label: "brandenburg", nearKm: 40 }],
  },
  {
    id: "berlin-hbf",
    query: "hbf",
    lang: "de",
    ...berlin,
    expect: [{ within: 1, label: "hauptbahnhof", nearKm: 5 }],
    enter: { open: { label: "hauptbahnhof", nearKm: 5 } },
  },
  {
    id: "munich-marienplatz",
    query: "marienplatz",
    lang: "de",
    ...at(MUNICH, 13),
    expect: [{ within: 1, label: "marienplatz", nearKm: 3 }],
  },
  {
    id: "munich-hauptbahnhof",
    query: "hauptbahnhof",
    lang: "de",
    ...at(MUNICH, 13),
    expect: [{ within: 1, label: "hauptbahnhof", nearKm: 5 }],
  },
  {
    id: "munich-englischer-garten",
    query: "englischer garten",
    lang: "de",
    ...at(MUNICH, 13),
    expect: [{ within: 1, label: "englischer garten", nearKm: 5 }],
  },
  {
    id: "munich-coffee",
    query: "coffee",
    lang: "en",
    ...at(MUNICH, 13),
    expect: [
      { within: 1, id: "category-cafes" },
      { within: 3, label: "coffee", nearKm: 8 },
    ],
  },
  {
    id: "paris-louvre",
    query: "louvre",
    lang: "fr",
    ...at(PARIS, 13),
    expect: [{ within: 1, label: "louvre", nearKm: 5 }],
  },
  {
    id: "paris-gare-de-lyon",
    query: "gare de lyon",
    lang: "fr",
    ...at(PARIS, 13),
    expect: [{ within: 1, label: "gare de lyon", nearKm: 5 }],
  },
  {
    id: "paris-boulangerie",
    query: "boulangerie",
    lang: "fr",
    ...at(PARIS, 13),
    expect: [{ within: 3, label: "boulangerie", nearKm: 8 }],
  },
  {
    id: "nyc-central-park",
    query: "central park",
    lang: "en",
    ...at(NEW_YORK, 13),
    expect: [{ within: 1, label: "central park", nearKm: 10 }],
  },
  {
    id: "nyc-times-square",
    query: "times square",
    lang: "en",
    ...at(NEW_YORK, 13),
    expect: [{ within: 1, label: "times square", nearKm: 3 }],
  },
  {
    id: "nyc-coffee",
    query: "coffee",
    lang: "en",
    ...at(NEW_YORK, 13),
    expect: [
      { within: 1, id: "category-cafes" },
      { within: 3, label: "coffee", nearKm: 8 },
    ],
  },
  {
    id: "nyc-jfk",
    query: "JFK",
    lang: "en",
    ...at(NEW_YORK, 13),
    expect: [{ within: 1, label: "kennedy", nearKm: 30 }],
  },
  {
    id: "london-big-ben",
    query: "big ben",
    lang: "en",
    ...at(LONDON, 13),
    expect: [{ within: 1, label: "big ben", nearKm: 5 }],
  },
  {
    id: "london-kings-cross",
    query: "kings cross",
    lang: "en",
    ...at(LONDON, 13),
    expect: [{ within: 1, label: "king", nearKm: 5 }],
  },
  {
    id: "london-pret",
    query: "pret",
    lang: "en",
    ...at(LONDON, 13),
    expect: [{ within: 3, label: "pret" }],
  },
  {
    id: "aachen-hbf",
    query: "aachen hbf",
    lang: "de",
    ...at(AACHEN, 13),
    expect: [{ within: 1, label: "aachen", nearKm: 5 }],
  },
  {
    id: "aachen-dom",
    query: "aachener dom",
    lang: "de",
    ...at(AACHEN, 13),
    expect: [{ within: 1, label: "dom", nearKm: 5 }],
  },
  {
    id: "oslo-s",
    query: "oslo s",
    lang: "en",
    ...at(OSLO, 13),
    expect: [{ within: 1, label: "oslo", nearKm: 3 }],
  },
  {
    id: "germany-berlin",
    query: "berlin",
    lang: "de",
    ...at(GERMANY, 6),
    expect: [{ within: 1, label: "^berlin", nearKm: 25, near: BERLIN }],
  },
  {
    id: "germany-frankfurt",
    query: "frankfurt",
    lang: "de",
    ...at(GERMANY, 6),
    expect: [{ within: 2, label: "^frankfurt am main", nearKm: 25, near: [8.68, 50.11] }],
  },
  {
    id: "germany-coffee",
    query: "coffee",
    lang: "en",
    ...at(GERMANY, 6),
    expect: [{ within: 1, id: "category-cafes" }],
  },
  {
    id: "munich-alexanderplatz",
    query: "alexanderplatz",
    lang: "de",
    ...at(MUNICH, 13),
    expect: [{ within: 3, label: "alexanderplatz", nearKm: 5, near: BERLIN }],
  },
  {
    id: "berlin-tankstelle",
    query: "tankstelle",
    lang: "de",
    ...berlin,
    expect: [{ within: 1, id: "category-fuel" }],
  },
  {
    id: "berlin-typo-alexanderplatz",
    query: "alexnderplatz",
    lang: "de",
    ...berlin,
    expect: [{ within: 1, label: "alexanderplatz", nearKm: 3 }],
    enter: { open: { label: "alexanderplatz", nearKm: 3 } },
  },
  // What Enter does. A word that starts many names, a chain's branches or an
  // obscure namesake far away must not be opened as if it were the place meant.
  {
    id: "berlin-vegan",
    query: "vegan",
    lang: "en",
    ...berlin,
    expect: [{ within: 3, label: "vegan", nearKm: 10 }],
    enter: "search",
  },
  {
    id: "aachen-vegan",
    query: "vegan",
    lang: "en",
    ...at(AACHEN, 14),
    expect: [],
    enter: "search",
  },
  {
    id: "berlin-doner",
    query: "döner",
    lang: "de",
    ...berlin,
    expect: [{ within: 3, label: "döner", nearKm: 5 }],
    enter: "search",
  },
  {
    id: "berlin-spatkauf",
    query: "spätkauf",
    lang: "de",
    ...berlin,
    expect: [{ within: 3, label: "spätkauf", nearKm: 5 }],
    enter: "search",
  },
  {
    id: "berlin-vegetarisch",
    query: "vegetarisch",
    lang: "de",
    ...berlin,
    expect: [],
    enter: "choose",
  },
  {
    id: "berlin-wifi",
    query: "wifi",
    lang: "en",
    ...berlin,
    expect: [],
    enter: "choose",
  },
  {
    id: "berlin-rewe-enter",
    query: "rewe",
    lang: "de",
    ...berlin,
    expect: [{ within: 3, label: "rewe", nearKm: 15 }],
    enter: { open: { type: "brand", label: "^rewe$" } },
  },
  {
    id: "berlin-springfield",
    query: "springfield",
    lang: "en",
    ...berlin,
    expect: [{ within: 1, label: "^springfield$", type: "region" }],
    enter: "choose",
  },
  // Lower-case words that are also airport codes or OurAirports keywords.
  {
    id: "berlin-bar",
    query: "bar",
    lang: "en",
    ...berlin,
    expect: [{ within: 1, type: "category", label: "^bar" }],
    enter: { open: { type: "category" } },
  },
  {
    id: "berlin-bio",
    query: "bio",
    lang: "de",
    ...berlin,
    expect: [{ within: 1, label: "^bio", nearKm: 5 }],
    enter: "search",
  },
  {
    id: "berlin-restaurant",
    query: "restaurant",
    lang: "en",
    ...berlin,
    expect: [{ within: 1, id: "category-restaurants" }],
    enter: { open: { id: "category-restaurants" } },
  },
  {
    id: "berlin-bank",
    query: "bank",
    lang: "de",
    ...berlin,
    expect: [{ within: 1, type: "category" }],
    enter: { open: { type: "category" } },
  },
  {
    id: "berlin-museum",
    query: "museum",
    lang: "en",
    ...berlin,
    expect: [{ within: 1, id: "category-museums" }],
    enter: { open: { id: "category-museums" } },
  },
  {
    id: "berlin-lax-lower",
    query: "lax",
    lang: "en",
    ...berlin,
    expect: [{ within: 1, label: "los angeles", nearKm: 30, near: [-118.41, 33.94] }],
    enter: { open: { label: "los angeles" } },
  },
  {
    id: "berlin-koln",
    query: "köln",
    lang: "de",
    ...berlin,
    expect: [{ within: 1, label: "^köln$", type: "region" }],
    enter: { open: { label: "^köln$", type: "region" } },
  },
  // A city's own name typed with the app in another language: the label is
  // the exonym, the match is on the native name.
  {
    id: "berlin-koln-in-english",
    query: "köln",
    lang: "en",
    ...berlin,
    expect: [{ within: 1, label: "^cologne$", type: "region" }],
    enter: { open: { label: "^cologne$", type: "region" } },
  },
  // Rome's German name, typed with the app in English: a village called Rom
  // two hours away is no match for it.
  {
    id: "berlin-rom-in-english",
    query: "rom",
    lang: "en",
    ...berlin,
    expect: [{ within: 1, label: "^rome$", type: "region", nearKm: 20, near: ROME }],
    enter: { open: { label: "^rome$", type: "region", nearKm: 20, near: ROME } },
  },
  // The city, not ancient Rome, which Wikidata gives a coordinate too.
  {
    id: "berlin-rome",
    query: "rome",
    lang: "en",
    ...berlin,
    expect: [{ within: 1, label: "^rome$", type: "region", nearKm: 20, near: ROME }],
    enter: { open: { label: "^rome$", type: "region", nearKm: 20, near: ROME } },
  },
  {
    id: "berlin-munchen-in-english",
    query: "münchen",
    lang: "en",
    ...berlin,
    expect: [{ within: 1, label: "^munich$", nearKm: 20, near: MUNICH }],
    enter: { open: { label: "^munich$", nearKm: 20, near: MUNICH } },
  },
  {
    id: "aachen-hbf-alone",
    query: "hbf",
    lang: "de",
    ...at(AACHEN, 14),
    expect: [{ within: 1, label: "hauptbahnhof", nearKm: 3 }],
    enter: { open: { label: "aachen hauptbahnhof" } },
  },
  // Far places, addresses and typos.
  {
    id: "berlin-paris-enter",
    query: "paris",
    lang: "en",
    ...berlin,
    expect: [{ within: 1, label: "^paris$", nearKm: 30, near: PARIS }],
    enter: { open: { label: "^paris$", nearKm: 30, near: PARIS } },
  },
  {
    id: "berlin-eiffel-tower",
    query: "eiffel tower",
    lang: "en",
    ...berlin,
    expect: [{ within: 1, label: "eiffel tower", nearKm: 5, near: PARIS }],
    enter: { open: { label: "eiffel tower", nearKm: 5, near: PARIS } },
  },
  // Famous places far away, against namesakes nearby or obscure ones abroad:
  // the notable-places index knows which is meant.
  {
    id: "berlin-louvre",
    query: "louvre",
    lang: "en",
    ...berlin,
    expect: [{ within: 1, label: "louvre", nearKm: 3, near: PARIS }],
    enter: { open: { label: "louvre", nearKm: 3, near: PARIS } },
  },
  {
    id: "berlin-colosseum",
    query: "colosseum",
    lang: "en",
    ...berlin,
    expect: [{ within: 1, label: "colosseum", nearKm: 3, near: [12.4922, 41.8902] }],
    enter: { open: { label: "colosseum", nearKm: 3, near: [12.4922, 41.8902] } },
  },
  {
    id: "berlin-sagrada-familia",
    query: "sagrada familia",
    lang: "en",
    ...berlin,
    expect: [{ within: 1, label: "sagrada fam", nearKm: 3, near: [2.1744, 41.4036] }],
    enter: { open: { label: "sagrada fam", nearKm: 3, near: [2.1744, 41.4036] } },
  },
  {
    id: "berlin-big-ben",
    query: "big ben",
    lang: "en",
    ...berlin,
    expect: [{ within: 1, label: "big ben", nearKm: 3, near: LONDON }],
    enter: { open: { label: "big ben", nearKm: 3, near: LONDON } },
  },
  {
    id: "berlin-neuschwanstein",
    query: "neuschwanstein",
    lang: "de",
    ...berlin,
    expect: [{ within: 1, label: "neuschwanstein", nearKm: 3, near: [10.7498, 47.5576] }],
    enter: { open: { label: "neuschwanstein", nearKm: 3, near: [10.7498, 47.5576] } },
  },
  {
    id: "berlin-colosseo-in-english",
    query: "colosseo",
    lang: "en",
    ...berlin,
    expect: [{ within: 1, label: "colosseo", nearKm: 3, near: [12.4922, 41.8902] }],
  },
  {
    id: "berlin-brandenburger-tor-enter",
    query: "brandenburger tor",
    lang: "en",
    ...berlin,
    expect: [{ within: 1, label: "brandenburg", nearKm: 3 }],
    enter: { open: { label: "brandenburg", nearKm: 3 } },
  },
  {
    id: "berlin-sanssouci",
    query: "schloss sanssouci",
    lang: "de",
    ...berlin,
    expect: [{ within: 1, label: "sanssouci", nearKm: 35 }],
    enter: { open: { label: "sanssouci", nearKm: 35 } },
  },
  {
    id: "berlin-mauerpark",
    query: "mauerpark",
    lang: "de",
    ...berlin,
    expect: [{ within: 1, label: "^mauerpark$", nearKm: 5 }],
    enter: { open: { label: "^mauerpark$" } },
  },
  {
    id: "berlin-typo-potsdamer-platz",
    query: "potsdamer plaz",
    lang: "de",
    ...berlin,
    expect: [{ within: 1, label: "potsdamer platz", nearKm: 5 }],
    enter: { open: { label: "potsdamer platz", nearKm: 5 } },
  },
  {
    id: "berlin-friedrichstrasse-100",
    query: "friedrichstraße 100 berlin",
    lang: "de",
    ...berlin,
    expect: [{ within: 1, label: "friedrichstra(ss|ß)e 100", nearKm: 5 }],
    enter: { open: { label: "friedrichstra(ss|ß)e 100", nearKm: 5 } },
  },
  {
    id: "berlin-postcode-city",
    query: "10115 berlin",
    lang: "de",
    ...berlin,
    expect: [{ within: 1, label: "^10115$" }],
    enter: { open: { label: "^10115$" } },
  },
];
