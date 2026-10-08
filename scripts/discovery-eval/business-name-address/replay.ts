/** Offline diagnostic replay. It never calls providers or changes production data. */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { getQueryVariants } from "../../../integrations/geocoding/query-expansion.js";
import type { AutocompleteResult } from "../../../packages/core/src/types/geocoding.js";
import {
  enterAction,
  rankAutocompleteRows,
} from "../../../packages/core/src/utils/suggestionRanking.js";

interface QuerySet {
  baseline: string;
  center: [number, number];
  zoom: number;
  cases: Array<{ id: string; query: string }>;
}
interface Responses {
  features: Array<{ raw: { id: string }; adapted: AutocompleteResult }>;
  cases: Array<{
    caseId: string;
    rawIds: string[];
  }>;
}
function read<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(name, import.meta.url), "utf8")) as T;
}
const queries = read<QuerySet>("queries-v1.json");
const responses = read<Responses>("responses-v1.json");
const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const report = {
  captureBaseline: queries.baseline,
  replayRevision: revision,
  dirty: execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim() !== "",
  sameRevision: revision === queries.baseline,
  mode: "place-only source replay; shortcuts and live UI are separate evidence",
  cases: responses.cases.map((fixture) => {
    const entry = queries.cases.find((query) => query.id === fixture.caseId);
    if (!entry) throw new Error("Missing business retrieval query");
    const context = { query: entry.query, proximity: queries.center, zoom: queries.zoom };
    // The historical aggregate was empty/partial. Replay the captured geocoder
    // pool; do not treat the unavailable aggregate as source absence.
    const combined = fixture.rawIds.map((id) => {
      const feature = responses.features.find((candidate) => candidate.raw.id === id);
      if (!feature) throw new Error("Missing captured candidate");
      return feature.adapted;
    });
    const ranked = rankAutocompleteRows({ places: combined }, context);
    const action = enterAction(ranked, context);
    return {
      caseId: fixture.caseId,
      variants: getQueryVariants(entry.query),
      partial: true,
      combinedIds: combined.map((row) => row.id),
      rankedIds: ranked.map((row) => row.id),
      enter: action.kind === "open" ? { kind: "open", id: action.row.id } : action,
    };
  }),
};
const output = `${JSON.stringify(report, null, 2)}\n`;
const outIndex = process.argv.indexOf("--out");
if (outIndex >= 0) {
  const out = process.argv[outIndex + 1];
  if (!out) throw new Error("Missing --out path");
  writeFileSync(out, output);
} else process.stdout.write(output);
