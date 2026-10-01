import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { BrandSuggestResponse } from "../../../types/brand";
import { CATEGORY_DEFINITIONS } from "../../../types/category";
import type { AutocompleteResult } from "../../../types/geocoding";
import type { ChipTranslation, PresetMatch } from "../../../types/presetMatch";
import { haversineDistance } from "../../coordinates";
import {
  brandSuggestionRows,
  type EnterAction,
  enterAction,
  type IntegrationSearchCategory,
  matchCategorySuggestions,
  presetSuggestionRows,
  rankAutocompleteRows,
} from "../../suggestionRanking";
import { EVAL_CASES, type EvalCase, type Expectation } from "./cases";

interface CaseFixture {
  autocomplete: AutocompleteResult[];
  aggregate: AutocompleteResult[];
  brands: BrandSuggestResponse["matches"];
  presets: PresetMatch[];
}

interface SharedFixture {
  chipTranslations: Record<string, Record<string, ChipTranslation>>;
  integrationCategories: IntegrationSearchCategory[];
}

function readFixture<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
}

const shared = readFixture<SharedFixture>("_shared");

/** The rows the search box would show for this case, built the way SearchBar builds them. */
function rankCase(evalCase: EvalCase): AutocompleteResult[] {
  const fixture = readFixture<CaseFixture>(evalCase.id);
  return rankAutocompleteRows(
    {
      categories: matchCategorySuggestions({
        query: evalCase.query,
        categories: CATEGORY_DEFINITIONS,
        integrationCategories: shared.integrationCategories,
        chipTranslations: shared.chipTranslations[evalCase.lang],
        sublabel: "",
      }),
      presets: presetSuggestionRows(fixture.presets, ""),
      brands: brandSuggestionRows(fixture.brands, ""),
      places: [...fixture.aggregate, ...fixture.autocomplete],
    },
    { query: evalCase.query, proximity: evalCase.center, zoom: evalCase.zoom },
  );
}

function matches(row: AutocompleteResult, expectation: Expectation, evalCase: EvalCase): boolean {
  if (expectation.id && row.id !== expectation.id) return false;
  if (expectation.type && row.type !== expectation.type) return false;
  if (expectation.label && !new RegExp(expectation.label, "iu").test(row.label)) return false;
  if (expectation.nearKm !== undefined) {
    if (!row.coordinates) return false;
    const metres = haversineDistance(row.coordinates, expectation.near ?? evalCase.center);
    if (metres > expectation.nearKm * 1000) return false;
  }
  return true;
}

/** 1-based rank of the first row meeting the expectation, or null. */
function rankOf(rows: AutocompleteResult[], expectation: Expectation, evalCase: EvalCase) {
  const index = rows.findIndex((row) => matches(row, expectation, evalCase));
  return index === -1 ? null : index + 1;
}

function describeRows(rows: AutocompleteResult[]): string {
  return rows
    .slice(0, 5)
    .map((row, i) => `${i + 1}. ${row.label} (${row.type})`)
    .join("; ");
}

function describeAction(action: EnterAction): string {
  return action.kind === "open" ? `open ${action.row.label} (${action.row.type})` : action.kind;
}

/** Whether Enter does what the case asks; true when it asks nothing. */
function enterAsExpected(action: EnterAction, evalCase: EvalCase): boolean {
  const wanted = evalCase.enter;
  if (wanted === undefined) return true;
  if (wanted === "search" || wanted === "choose") return action.kind === wanted;
  return action.kind === "open" && matches(action.row, { within: 1, ...wanted.open }, evalCase);
}

const results = EVAL_CASES.map((evalCase) => {
  const rows = rankCase(evalCase);
  const ranks = evalCase.expect.map((expectation) => rankOf(rows, expectation, evalCase));
  const action = enterAction(rows, {
    query: evalCase.query,
    proximity: evalCase.center,
    zoom: evalCase.zoom,
  });
  const passed =
    evalCase.expect.every((expectation, i) => {
      const rank = ranks[i];
      return rank !== null && rank <= expectation.within;
    }) && enterAsExpected(action, evalCase);
  return { evalCase, rows, ranks, action, passed };
});

describe("search ranking eval", () => {
  for (const { evalCase, rows, ranks, action, passed } of results) {
    const title = `${evalCase.id}: “${evalCase.query}”`;
    const report = `ranks ${JSON.stringify(ranks)}; Enter: ${describeAction(action)}; ${describeRows(rows)}`;
    if (evalCase.knownGap) {
      it(`${title} is still a known gap (${evalCase.knownGap})`, () => {
        // Passing now means the gap is fixed: drop `knownGap` so it is guarded.
        expect(passed, report).toBe(false);
      });
    } else {
      it(title, () => {
        expect(passed, report).toBe(true);
      });
    }
  }

  it("keeps the first expectation at rank 1 for most cases", () => {
    const asserted = results.filter(
      ({ evalCase }) => !evalCase.knownGap && evalCase.expect.length > 0,
    );
    const hitAt1 = asserted.filter(({ ranks }) => ranks[0] === 1).length / asserted.length;
    const reciprocalRank =
      asserted.reduce((sum, { ranks }) => sum + (ranks[0] ? 1 / ranks[0] : 0), 0) / asserted.length;
    expect(hitAt1).toBeGreaterThanOrEqual(0.8);
    expect(reciprocalRank).toBeGreaterThanOrEqual(0.85);
  });
});
