import { describe, expect, it } from "vitest";
import { CATEGORY_DEFINITIONS } from "../../types/category";
import type { AutocompleteResult } from "../../types/geocoding";
import {
  isConfidentTopRow,
  matchCategorySuggestions,
  matchRecentSearches,
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

describe("isConfidentTopRow", () => {
  it("accepts exact and prefix matches but not address-only or action rows", () => {
    expect(isConfidentTopRow(place("a", "Alexanderplatz", BERLIN), "alexanderpl")).toBe(true);
    expect(
      isConfidentTopRow(
        place("b", "Einstein", BERLIN, { sublabel: "Unter den Linden 42" }),
        "linden",
      ),
    ).toBe(false);
    expect(isConfidentTopRow({ id: "s", label: "Search", type: "text_search" }, "search")).toBe(
      false,
    );
  });
});
