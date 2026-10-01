/**
 * Records the provider responses behind each search-eval case, so the ranking
 * eval (packages/core/src/utils/__tests__/search-eval) runs offline and
 * deterministically. Needs a running API:
 *
 *   pnpm search-eval:record [--api http://localhost:3001] [case-id …]
 *
 * Re-record after changing a provider, the geocoding chain, or a case's query
 * or location; the fixtures are what the eval scores.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EVAL_CASES,
  type EvalCase,
} from "../packages/core/src/utils/__tests__/search-eval/cases.js";

const FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../packages/core/src/utils/__tests__/search-eval/fixtures",
);

const args = process.argv.slice(2);
const apiFlag = args.indexOf("--api");
const api = apiFlag === -1 ? "http://localhost:3001" : args[apiFlag + 1];
const only = new Set(args.filter((arg, i) => !arg.startsWith("--") && args[i - 1] !== "--api"));

async function get<T>(path: string, params: Record<string, string>): Promise<T> {
  const url = new URL(path, api);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} → ${response.status}`);
  return (await response.json()) as T;
}

/** The fields ranking reads; everything else would only bloat the fixtures. */
const PLACE_FIELDS = [
  "id",
  "ids",
  "label",
  "sublabel",
  "coordinates",
  "type",
  "rawCategory",
  "searchMatch",
  "importance",
  "fame",
  "provider",
] as const;

function pick<T extends object>(item: T, fields: readonly string[]): Partial<T> {
  return Object.fromEntries(
    fields.filter((field) => field in item).map((field) => [field, item[field as keyof T]]),
  ) as Partial<T>;
}

async function recordCase(evalCase: EvalCase) {
  const [lng, lat] = evalCase.center;
  const near = { lat: lat.toFixed(2), lng: lng.toFixed(2) };
  const q = evalCase.query;
  const country = await get<{ countryCode: string | null }>(
    "/api/integrations/geocoding/geocode/country",
    { lat: String(Math.round(lat)), lng: String(Math.round(lng)) },
  );
  const [autocomplete, aggregate, brands, presets] = await Promise.all([
    get<object[]>("/api/integrations/geocoding/autocomplete", {
      q,
      lang: evalCase.lang,
      ...near,
      zoom: String(Math.floor(evalCase.zoom)),
    }),
    get<{ suggestions: object[] }>("/api/integrations/search-suggestions/search", {
      q,
      lang: evalCase.lang,
      ...near,
      limit: "8",
    }).catch(() => ({ suggestions: [] })),
    get<{ matches: object[] }>("/api/integrations/poi-search/brand-suggest", {
      q,
      kind: "brand",
      ...(country.countryCode ? { country: country.countryCode } : {}),
    }),
    get<{ matches: object[] }>("/api/integrations/poi-search/preset-suggest", {
      q,
      lang: evalCase.lang,
    }),
  ]);
  return {
    autocomplete: autocomplete.map((item) => pick(item, PLACE_FIELDS)),
    aggregate: aggregate.suggestions.map((item) => pick(item, PLACE_FIELDS)),
    brands: brands.matches.map((item) =>
      pick(item, ["qid", "name", "description", "kind", "matchedOn", "presence"]),
    ),
    presets: presets.matches.map((item) => pick(item, ["id", "name", "tags", "matchedOn"])),
  };
}

async function main() {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  const langs = new Set(EVAL_CASES.map((evalCase) => evalCase.lang));
  const chipTranslations: Record<string, unknown> = {};
  for (const lang of langs) {
    chipTranslations[lang] = (
      await get<{ translations: unknown }>("/api/integrations/poi-search/chip-translations", {
        lang,
      })
    ).translations;
  }
  const { integrations } = await get<{
    integrations: { id: string; frontend?: { searchCategory?: { id: string; label?: string } } }[];
  }>("/api/integrations", {});
  const integrationCategories = integrations.flatMap((integration) => {
    const category = integration.frontend?.searchCategory;
    return category ? [{ id: category.id, label: category.label ?? category.id }] : [];
  });
  writeFileSync(
    join(FIXTURE_DIR, "_shared.json"),
    `${JSON.stringify({ chipTranslations, integrationCategories }, null, 1)}\n`,
  );

  for (const evalCase of EVAL_CASES) {
    if (only.size > 0 && !only.has(evalCase.id)) continue;
    const recorded = await recordCase(evalCase);
    writeFileSync(
      join(FIXTURE_DIR, `${evalCase.id}.json`),
      `${JSON.stringify(recorded, null, 1)}\n`,
    );
    console.log(
      `${evalCase.id}: ${recorded.autocomplete.length} geocoder, ${recorded.aggregate.length} aggregate, ${recorded.brands.length} chains, ${recorded.presets.length} presets`,
    );
  }
  // Written as the repository formats JSON, so a re-record passes `biome check`.
  execFileSync("pnpm", ["exec", "biome", "format", "--write", FIXTURE_DIR], { stdio: "ignore" });
}

await main();
