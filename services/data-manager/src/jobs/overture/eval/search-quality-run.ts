import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { evaluateSearchQuality, type LabeledSearchCase } from "./search-quality.js";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { labeled: { type: "string" } },
});

if (!values.labeled) {
  throw new Error("Usage: search-quality-run.ts --labeled <cases.json>");
}

const parsed: unknown = JSON.parse(readFileSync(values.labeled, "utf8"));
if (!Array.isArray(parsed)) {
  throw new Error("Labeled search-quality input must be a JSON array");
}

console.log(JSON.stringify(evaluateSearchQuality(parsed as LabeledSearchCase[]), null, 2));
