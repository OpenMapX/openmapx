import { describe, expect, it } from "vitest";
import { CATEGORY_DEFINITIONS } from "../../types/category";
import type { AutocompleteResult } from "../../types/geocoding";
import { CONFIDENT_TEXT_SCORE, textMatchScore } from "../searchSuggestion";
import {
  brandSuggestionRows,
  enterAction,
  matchCategorySuggestions,
  matchRecentSearches,
  presetSuggestionRows,
  rankAutocompleteRows,
} from "../suggestionRanking";

const BERLIN: [number, number] = [13.405, 52.52];

const place = (
  id: string,
  label: string,
  coordinates: [number, number],
  extra: Partial<AutocompleteResult> = {},
): AutocompleteResult => ({ id, label, coordinates, type: "poi", ...extra });

const brand = (
  id: string,
  label: string,
  brandPresence: AutocompleteResult["brandPresence"],
): AutocompleteResult => ({ id: `brand:${id}`, label, type: "brand", brandPresence });

const preset = (id: string, label: string): AutocompleteResult => ({
  id: `category-preset:${id}`,
  label,
  type: "category",
});

const cafes: AutocompleteResult = {
  id: "category-cafes",
  label: "Cafe",
  type: "category",
  searchMatch: { kind: "explicit_alias", value: "coffee", normalized: "coffee" },
};

describe("rankAutocompleteRows", () => {
  it.each([
    ["Kentucky Fried Chicken", 1.3, "open"],
    ["Kentucky", 0.8, "open"],
    ["Fried", 0.7, "search"],
  ])("uses the full brand alias without inflating %s confidence", (query, score, action) => {
    const rows = rankAutocompleteRows(
      {
        brands: brandSuggestionRows(
          [
            {
              qid: "Q524757",
              name: "KFC",
              kind: ["brand"],
              matchedOn: "alias",
              matchedValue: "kentucky fried chicken",
              presence: "here",
            },
          ],
          "",
        ),
      },
      { query },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe("KFC");
    expect(textMatchScore(rows[0], query)).toBe(score);
    expect(enterAction(rows, { query }).kind).toBe(action);
  });

  it.each([
    ["frozen dessert", 0.7],
    ["frozen", 0.5],
    ["rozen", 0.3],
  ])("keeps a preset term visible with weak %s confidence", (query, score) => {
    const rows = rankAutocompleteRows(
      {
        presets: presetSuggestionRows(
          [
            {
              id: "shop/sweets",
              name: "Sweet Store",
              tags: { shop: "confectionery" },
              matchedOn: "term",
              matchedValue: "frozen dessert",
            },
          ],
          "",
        ),
      },
      { query },
    );
    expect(rows).toHaveLength(1);
    expect(textMatchScore(rows[0], query)).toBe(score);
    expect(textMatchScore(rows[0], query)).toBeLessThan(CONFIDENT_TEXT_SCORE);
    expect(enterAction(rows, { query }).kind).toBe("search");
  });

  it("retains canonical scoring when legacy responses omit evidence", () => {
    const rows = rankAutocompleteRows(
      {
        brands: brandSuggestionRows(
          [{ qid: "Q524757", name: "KFC", kind: ["brand"], matchedOn: "alias", presence: "here" }],
          "",
        ),
      },
      { query: "KFC" },
    );
    expect(rows[0].searchMatch).toBeUndefined();
    expect(textMatchScore(rows[0], "KFC")).toBe(1);
  });

  it("normalizes curated alias case and diacritics using the client text rules", () => {
    const [row] = brandSuggestionRows(
      [
        {
          qid: "Q1",
          name: "CDM",
          kind: ["brand"],
          matchedOn: "alias",
          matchedValue: "cafe du monde",
          presence: "global",
        },
      ],
      "",
    );
    expect(textMatchScore(row, "CAFÉ DU MONDE")).toBe(1.3);
    expect(row.searchMatch?.value).toBe("cafe du monde");
  });

  it("keeps partial place keywords at their existing confidence", () => {
    const row = place("p1", "Sweet Store", BERLIN, {
      searchMatch: { kind: "keyword", value: "frozen dessert", normalized: "frozen dessert" },
    });
    expect(textMatchScore(row, "rozen")).toBe(0.15);
  });
  it("orders the coffee search from Berlin: category, nearby cafés, then capped chains", () => {
    const rows = rankAutocompleteRows(
      {
        categories: [cafes],
        presets: [
          preset("amenity/cafe/coffee_shop", "Coffeehouse"),
          preset("shop/coffee", "Coffee Store"),
          preset("amenity/vending_machine/coffee", "Coffee Vending Machine"),
        ],
        brands: [
          brand("Q1", "Coffee Lab", "elsewhere"),
          brand("Q2", "Coffee Fellows", "here"),
          brand("Q3", "Coffee Culture", "elsewhere"),
          brand("Q4", "Coffee Company", "elsewhere"),
        ],
        places: [
          place("county-1", "Coffee", [-82.84, 31.53], {
            type: "region",
            rawCategory: "place/county",
          }),
          place("circle", "Coffee Circle", [13.4, 52.52]),
          place("jungle", "Coffee Jungle", [13.41, 52.525]),
          place("airfield", "Coffee Point Airstrip", [-157.44, 58.21], {
            rawCategory: "aeroway/aerodrome",
            importance: 0.2,
          }),
        ],
      },
      { query: "coffee", proximity: BERLIN, zoom: 14 },
    );

    expect(rows.map((row) => row.id)).toEqual([
      "category-cafes",
      "category-preset:amenity/cafe/coffee_shop",
      "circle",
      "jungle",
      "brand:Q2",
      "county-1",
      "airfield",
      "brand:Q1",
    ]);
  });

  it("keeps saved places first and respects the total cap", () => {
    const saved: AutocompleteResult = {
      id: "labeled-home",
      label: "Home",
      type: "labeled_place",
      coordinates: BERLIN,
    };
    const places = Array.from({ length: 20 }, (_, i) =>
      place(`p${i}`, `Rewe ${i}`, [13.4 + i / 100, 52.52]),
    );
    const rows = rankAutocompleteRows(
      { saved: [saved], places },
      { query: "rewe", proximity: BERLIN },
      { total: 5, categories: 2, brands: 2, recents: 2 },
    );
    expect(rows).toHaveLength(5);
    expect(rows[0].id).toBe("labeled-home");
    expect(rows[1].id).toBe("p0");
  });

  it("drops a preset that repeats a built-in category and shortcuts that only contain the text", () => {
    const rows = rankAutocompleteRows(
      {
        categories: [cafes],
        presets: [preset("amenity/cafe", "Cafe")],
        brands: [brand("Q9", "Palmers Brewery", "unknown")],
      },
      { query: "coffee" },
    );
    expect(rows.map((row) => row.id)).toEqual(["category-cafes"]);
  });

  it("deduplicates the same place reported by two sources", () => {
    const rows = rankAutocompleteRows(
      {
        places: [
          place("geo", "Alexanderplatz", [13.4133, 52.5219]),
          place("agg", "Alexanderplatz", [13.4134, 52.522], { type: "transit_stop" }),
        ],
      },
      { query: "alexanderplatz", proximity: BERLIN },
    );
    expect(rows).toHaveLength(1);
  });
});

describe("matchCategorySuggestions", () => {
  it("finds a category through a localized search term at a word start", () => {
    const rows = matchCategorySuggestions({
      query: "coffee",
      categories: CATEGORY_DEFINITIONS,
      chipTranslations: { cafes: { name: "Cafe", terms: ["bistro", "coffee", "espresso"] } },
      sublabel: "Search category",
    });
    expect(rows).toEqual([
      expect.objectContaining({
        id: "category-cafes",
        label: "Cafe",
        sublabel: "Search category",
        searchMatch: { kind: "explicit_alias", value: "coffee", normalized: "coffee" },
      }),
    ]);
  });

  it("ignores text in the middle of a word", () => {
    const rows = matchCategorySuggestions({
      query: "tea",
      categories: CATEGORY_DEFINITIONS,
      chipTranslations: { restaurants: { name: "Restaurant", terms: ["steak house"] } },
      sublabel: "",
    });
    expect(rows.map((row) => row.id)).not.toContain("category-restaurants");
  });

  it("lets an integration category own a built-in id", () => {
    const rows = matchCategorySuggestions({
      query: "park",
      categories: CATEGORY_DEFINITIONS,
      integrationCategories: [{ id: "parking", label: "Parking", iconPath: "M0" }],
      sublabel: "",
    });
    expect(rows.filter((row) => row.id === "category-parking")).toEqual([
      expect.objectContaining({ iconPath: "M0" }),
    ]);
  });

  it("finds an integration category through its localized search terms", () => {
    const rows = matchCategorySuggestions({
      query: "tanke",
      categories: CATEGORY_DEFINITIONS,
      integrationCategories: [{ id: "fuel", label: "Gas Stations" }],
      chipTranslations: { fuel: { name: "Tankstelle", terms: ["tankstelle", "tanke"] } },
      sublabel: "",
    });
    expect(rows).toEqual([expect.objectContaining({ id: "category-fuel", label: "Tankstelle" })]);
  });

  it("finds the snake_case translation of a kebab-case integration category", () => {
    const rows = matchCategorySuggestions({
      query: "ladestation",
      categories: CATEGORY_DEFINITIONS,
      integrationCategories: [{ id: "ev-charging", label: "EV Charging" }],
      chipTranslations: { ev_charging: { name: "Ladestation", terms: ["ladestation"] } },
      sublabel: "",
    });
    expect(rows).toEqual([expect.objectContaining({ id: "category-ev-charging" })]);
  });
});

describe("matchRecentSearches", () => {
  it("matches word starts and leaves out the query itself", () => {
    expect(
      matchRecentSearches(["Berlin Hauptbahnhof", "hauptbahnhof", "Bahnhofstraße"], "hauptbahnhof"),
    ).toEqual([
      { id: "recent:berlin hauptbahnhof", label: "Berlin Hauptbahnhof", type: "recent_search" },
    ]);
  });
});

describe("enterAction", () => {
  const AACHEN: [number, number] = [6.084, 50.775];
  const at = (query: string, proximity: [number, number] = BERLIN, zoom = 14) => ({
    query,
    proximity,
    zoom,
  });
  const area = (
    id: string,
    label: string,
    coordinates: [number, number],
    rawCategory: string,
  ): AutocompleteResult => ({ id, label, coordinates, type: "region", rawCategory });
  const decide = (places: AutocompleteResult[], context: ReturnType<typeof at>, extra = {}) =>
    enterAction(rankAutocompleteRows({ places, ...extra }, context), context);

  it("opens a place the text names, counting a square and its station as one", () => {
    const action = decide(
      [
        area("square", "Alexanderplatz", [13.4132, 52.5219], "place/square"),
        place("station", "Alexanderplatz", [13.4115, 52.5219], {
          rawCategory: "railway/station",
        }),
      ],
      at("alexanderpl"),
    );
    expect(action).toMatchObject({ kind: "open", row: { label: "Alexanderplatz" } });
  });

  it("searches the area when several nearby places answer as well", () => {
    // A chain's branches.
    expect(
      decide(
        [
          place("a1", "Aldi", [13.39, 52.51], { rawCategory: "shop/supermarket" }),
          place("a2", "Aldi", [13.42, 52.53], { rawCategory: "shop/supermarket" }),
        ],
        at("aldi"),
      ),
    ).toEqual({ kind: "search", weak: false });
    // A word many names start with.
    expect(
      decide(
        [
          place("v1", "Vegang", [13.41, 52.53], { rawCategory: "amenity/restaurant" }),
          place("v2", "Vegan Haus", [13.42, 52.54], { rawCategory: "amenity/restaurant" }),
        ],
        at("vegan"),
      ),
    ).toEqual({ kind: "search", weak: false });
  });

  it("opens the chain when its branches tie and it trades in the map's country", () => {
    const branches = [
      place("a1", "Aldi", [13.39, 52.51], { rawCategory: "shop/supermarket" }),
      place("a2", "Aldi", [13.42, 52.53], { rawCategory: "shop/supermarket" }),
    ];
    expect(
      decide(branches, at("aldi"), { brands: [brand("Q125054", "Aldi", "here")] }),
    ).toMatchObject({ kind: "open", row: { type: "brand" } });
    expect(decide(branches, at("aldi"), { brands: [brand("Q1", "Aldi", "elsewhere")] })).toEqual({
      kind: "search",
      weak: false,
    });
  });

  it("never opens an obscure namesake far away", () => {
    const hamlets = [
      area("no", "Vegan", [9.7, 59.3], "place/hamlet"),
      area("us", "Vegan", [-84.0, 34.8], "place/hamlet"),
    ];
    // Something nearby starts with the word: search here.
    expect(
      decide(
        [...hamlets, place("v", "Veganland", [6.15, 50.86], { rawCategory: "amenity/fast_food" })],
        at("vegan", AACHEN),
      ),
    ).toEqual({ kind: "search", weak: false });
    // Nothing nearby: show what there is.
    expect(decide(hamlets, at("vegan", AACHEN))).toEqual({ kind: "choose" });
  });

  it("asks which of several equally famous places far away is meant", () => {
    expect(
      decide(
        [
          area("il", "Springfield", [-89.65, 39.8], "place/city"),
          area("mo", "Springfield", [-93.29, 37.21], "place/city"),
        ],
        at("springfield"),
      ),
    ).toEqual({ kind: "choose" });
  });

  it("opens a famous place over a namesake far less known", () => {
    // Big Ben in London over the volcano of that name; the Louvre over a bar.
    expect(
      decide(
        [
          place("ben", "Big Ben", [-0.1246, 51.5007], { fame: 0.81 }),
          place("volcano", "Big Ben", [73.5, -53.1], { fame: 0.52 }),
        ],
        at("big ben"),
      ),
    ).toMatchObject({ kind: "open", row: { id: "ben" } });
    expect(
      decide(
        [
          place("museum", "Louvre", [2.336, 48.861], { fame: 0.89 }),
          place("bar", "Louvre", [13.36, 52.5]),
        ],
        at("louvre"),
      ),
    ).toMatchObject({ kind: "open", row: { id: "museum" } });
  });

  it("counts places a short walk apart as one destination, whatever they are called", () => {
    // The Brandenburg Gate and the station named after it are not alternatives.
    expect(
      decide(
        [
          place("gate", "Brandenburg Gate", [13.3777, 52.5163], {
            fame: 0.76,
            searchMatch: {
              kind: "name",
              value: "Brandenburger Tor",
              normalized: "brandenburger tor",
            },
          }),
          place("station", "Berlin Brandenburger Tor station", [13.3811, 52.5169], {
            fame: 0.45,
            searchMatch: {
              kind: "name",
              value: "Brandenburger Tor",
              normalized: "brandenburger tor",
            },
          }),
        ],
        at("brandenburger tor"),
      ),
    ).toMatchObject({ kind: "open", row: { id: "gate" } });
  });

  it("opens a famous city far away, not rivalled by its own airport", () => {
    expect(
      decide(
        [
          area("koeln", "Köln", [6.96, 50.94], "place/city"),
          place("cgn", "Cologne Bonn Airport", [7.14, 50.87], {
            rawCategory: "aeroway/aerodrome",
            importance: 0.9,
            searchMatch: { kind: "name", value: "Köln", normalized: "koln" },
          }),
        ],
        at("köln"),
      ),
    ).toMatchObject({ kind: "open", row: { label: "Köln" } });
  });

  it("opens an address with the house number typed, wherever it is", () => {
    expect(
      decide(
        [{ ...place("h", "Hauptstraße 5, Köln", [6.96, 50.94]), type: "address" }],
        at("hauptstraße 5 köln"),
      ),
    ).toMatchObject({ kind: "open" });
  });

  it("opens a category or other shortcut the text names", () => {
    const context = at("coffee");
    expect(enterAction(rankAutocompleteRows({ categories: [cafes] }, context), context)).toEqual({
      kind: "open",
      row: cafes,
    });
  });

  it("leaves a weak match to the geocoder and the area search", () => {
    expect(
      decide([place("b", "Einstein", BERLIN, { sublabel: "Unter den Linden 42" })], at("linden")),
    ).toEqual({ kind: "search", weak: true });
    expect(enterAction([], at("anything"))).toEqual({ kind: "search", weak: true });
  });
});
