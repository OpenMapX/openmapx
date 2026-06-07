/**
 * Pre-commit guard: every cell of the dynamically generated legal tables must be filled.
 *
 * The Privacy Policy ("Third-Party Services and Data Transfers" section) and the
 * Terms of Service ("Data Sources and Attribution" section) each render a table
 * whose rows are derived straight from every integration's `manifest.json`
 * `dataSources` plus its per-locale `strings/<locale>.json`:
 *
 *   - Privacy table   → generatePrivacySectionsFromManifests()
 *       Service · Purpose · Data Transmitted · Data Access · Country · Privacy Info
 *   - Attribution table → generateAttributionSectionsFromManifests()
 *       Source · Description · License
 *
 * Those two functions live in apps/web/src/app/(legal)/generateLegalSections.ts
 * and are imported here verbatim, so this check can never drift from what the
 * pages actually render. For every integration that contributes rows, in every
 * locale the pages render, we assert that no resolved cell is empty.
 *
 * The localized per-source strings (`purpose`/`dataSent`) live under a
 * `dataSources` object KEYED BY the manifest source's `sourceId` — never a
 * positional array — so that adding or reordering a manifest source can't
 * silently shift the strings onto the wrong provider. On top of the emptiness
 * check we therefore enforce two structural guards: `dataSources` must be a
 * keyed object (not an array), and every key must match a real manifest
 * sourceId (no stale/mistyped orphan keys).
 *
 * Anything wrong is reported grouped by integration and the process exits
 * non-zero so the commit is blocked. Run on demand with `pnpm check-legal-tables`.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  IntegrationManifest,
  IntegrationStrings,
  LoadedIntegrationMeta,
} from "@openmapx/integration-framework";
import {
  type AttributionRow,
  generateAttributionSectionsFromManifests,
  generatePrivacySectionsFromManifests,
  type PrivacyServiceRow,
} from "../apps/web/src/app/(legal)/generateLegalSections.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Locales the legal pages render (privacy/terms `content.{en,de}.tsx`). */
const LOCALES = ["en", "de"] as const;

/**
 * Only the committed, authored integrations gate commits. `custom_integrations/`
 * is gitignored and user-installed, so a broken third-party integration there
 * must not block an unrelated commit.
 */
const INTEGRATIONS_DIR = join(REPO_ROOT, "integrations");

/**
 * Columns each table renders, paired with the source-of-truth field a missing
 * cell maps back to. The `key` matches the row shape produced by the generators.
 */
const PRIVACY_COLUMNS: { key: keyof PrivacyServiceRow; label: string; field: string }[] = [
  { key: "service", label: "Service", field: "manifest dataSources[].name" },
  { key: "purpose", label: "Purpose", field: "strings/<locale> dataSources.<sourceId>.purpose" },
  {
    key: "dataSent",
    label: "Data Transmitted",
    field: "strings/<locale> dataSources.<sourceId>.dataSent",
  },
  { key: "endUserExposure", label: "Data Access", field: "manifest dataSources[].endUserExposure" },
  { key: "country", label: "Country", field: "manifest dataSources[].providerCountry" },
  { key: "privacy", label: "Privacy Info", field: "manifest dataSources[].providerPrivacyUrl" },
];

const ATTRIBUTION_COLUMNS: { key: keyof AttributionRow; label: string; field: string }[] = [
  { key: "source", label: "Source", field: "manifest dataSources[].name" },
  {
    key: "desc",
    label: "Description",
    field: "strings/<locale> description (or manifest description)",
  },
  { key: "license", label: "License", field: "manifest dataSources[].license" },
];

interface DiscoveredIntegration {
  id: string;
  manifest: IntegrationManifest;
  strings: IntegrationStrings;
  dir: string;
}

/** One row that has at least one empty cell, with the columns that are blank. */
interface RowIssue {
  dir: string;
  locale: string;
  table: "Privacy Policy (/privacy)" | "Terms of Service (/terms)";
  source: string;
  missing: { label: string; field: string }[];
}

const isEmpty = (value: unknown): boolean =>
  value == null || (typeof value === "string" && value.trim() === "");

function loadStrings(dir: string): IntegrationStrings {
  const stringsDir = join(dir, "strings");
  const strings: IntegrationStrings = {};
  if (!existsSync(stringsDir)) return strings;
  for (const file of readdirSync(stringsDir)) {
    if (!file.endsWith(".json")) continue;
    try {
      const content = JSON.parse(readFileSync(join(stringsDir, file), "utf-8"));
      if (content && typeof content === "object") {
        strings[file.replace(/\.json$/, "")] = content as Record<string, unknown>;
      }
    } catch {
      // Unreadable strings surface as empty cells below; JSON validity is a separate concern.
    }
  }
  return strings;
}

/** Discover every integration with a parseable manifest, mirroring the API host's loader. */
function discoverIntegrations(baseDir: string): DiscoveredIntegration[] {
  if (!existsSync(baseDir)) return [];
  const out: DiscoveredIntegration[] = [];
  for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith("_")) continue; // _placeholder and friends
    const dir = join(baseDir, entry.name);
    const manifestPath = join(dir, "manifest.json");
    if (!existsSync(manifestPath)) continue;
    let manifest: IntegrationManifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as IntegrationManifest;
    } catch {
      continue; // invalid JSON is caught by other tooling, not this check
    }
    out.push({ id: manifest.id ?? entry.name, manifest, strings: loadStrings(dir), dir });
  }
  return out;
}

/**
 * Mirror of `toIntegrationMeta` (integration-framework loader), but with
 * `enabled` forced on: completeness is a property of the authored data, not of
 * any one deployment's enable/disable config.
 */
function toMeta(it: DiscoveredIntegration): LoadedIntegrationMeta {
  const en = it.strings.en as Record<string, unknown> | undefined;
  return {
    id: it.id,
    name: (en?.name as string) ?? it.manifest.name ?? it.id,
    description: (en?.description as string) ?? it.manifest.description,
    enabled: true,
    domains: it.manifest.domains,
    frontend: it.manifest.frontend,
    dataSources: it.manifest.dataSources,
    healthCheck: it.manifest.healthCheck,
    strings: Object.keys(it.strings).length > 0 ? it.strings : undefined,
  };
}

function checkIntegration(meta: LoadedIntegrationMeta, dir: string): RowIssue[] {
  const issues: RowIssue[] = [];
  const sources = meta.dataSources ?? [];

  for (const locale of LOCALES) {
    // Privacy table: every data source contributes a row (dynamic sources included).
    const privacyRows = generatePrivacySectionsFromManifests([meta], locale).flatMap(
      (section) => section.rows,
    );
    privacyRows.forEach((row, i) => {
      const missing = PRIVACY_COLUMNS.filter((c) => isEmpty(row[c.key]));
      if (missing.length) {
        issues.push({
          dir,
          locale,
          table: "Privacy Policy (/privacy)",
          source: sources[i]?.sourceId ?? row.service ?? `#${i}`,
          missing,
        });
      }
    });

    // Attribution table: dynamic sources are excluded, so rows track the
    // non-dynamic sources in manifest order.
    const nonDynamic = sources.filter((ds) => !ds.dynamic);
    const attributionRows = generateAttributionSectionsFromManifests([meta], locale).flatMap(
      (section) => section.rows,
    );
    attributionRows.forEach((row, i) => {
      const missing = ATTRIBUTION_COLUMNS.filter((c) => isEmpty(row[c.key]));
      if (missing.length) {
        issues.push({
          dir,
          locale,
          table: "Terms of Service (/terms)",
          source: nonDynamic[i]?.sourceId ?? row.source ?? `#${i}`,
          missing,
        });
      }
    });
  }

  return issues;
}

/**
 * Structural guards that keep the sourceId-keyed contract intact: localized
 * `dataSources` must be an OBJECT keyed by manifest sourceId (never a positional
 * array again), and every key must match an actual manifest source (no stale or
 * mistyped keys that silently describe nothing).
 */
function checkStructure(it: DiscoveredIntegration): string[] {
  const problems: string[] = [];
  const sourceIds = new Set((it.manifest.dataSources ?? []).map((d) => d.sourceId));
  for (const locale of LOCALES) {
    const ds = it.strings[locale]?.dataSources as unknown;
    if (ds == null) continue;
    if (Array.isArray(ds) || typeof ds !== "object") {
      problems.push(
        `${locale}: strings.dataSources must be an object keyed by manifest sourceId` +
          (Array.isArray(ds) ? " (found a positional array — convert it to a keyed object)" : ""),
      );
      continue;
    }
    for (const key of Object.keys(ds)) {
      if (!sourceIds.has(key)) {
        problems.push(
          `${locale}: strings.dataSources key "${key}" has no matching manifest sourceId`,
        );
      }
    }
  }
  return problems;
}

function main(): void {
  const integrations = discoverIntegrations(INTEGRATIONS_DIR);
  const contributing = integrations.filter((it) => it.manifest.dataSources?.length);

  const structuralByDir = new Map<string, string[]>();
  for (const it of integrations) {
    const problems = checkStructure(it);
    if (problems.length) structuralByDir.set(it.dir, problems);
  }

  const rowIssues: RowIssue[] = [];
  for (const it of contributing) {
    rowIssues.push(...checkIntegration(toMeta(it), it.dir));
  }

  if (rowIssues.length === 0 && structuralByDir.size === 0) {
    console.log(
      `✓ Legal tables complete: ${contributing.length} integration(s) with data sources, ` +
        `no empty cells across ${LOCALES.length} locale(s).`,
    );
    return;
  }

  const byDir = new Map<string, RowIssue[]>();
  for (const issue of rowIssues) {
    const list = byDir.get(issue.dir) ?? [];
    list.push(issue);
    byDir.set(issue.dir, list);
  }

  const emptyCellCount = rowIssues.reduce((sum, issue) => sum + issue.missing.length, 0);
  const structuralCount = [...structuralByDir.values()].reduce((n, p) => n + p.length, 0);
  const dirs = [...new Set([...byDir.keys(), ...structuralByDir.keys()])].sort();
  console.error(
    `✖ Legal tables: ${emptyCellCount} empty cell(s) and ${structuralCount} structural problem(s) ` +
      `across ${dirs.length} integration(s).\n` +
      "  Cells render in /privacy and /terms; fill the noted manifest/strings fields.\n" +
      "  strings.dataSources must be an object keyed by manifest sourceId.\n",
  );

  for (const dir of dirs) {
    console.error(`${relative(REPO_ROOT, dir)}`);
    for (const problem of structuralByDir.get(dir) ?? []) {
      console.error(`  ⚠ structure · ${problem}`);
    }
    for (const issue of byDir.get(dir) ?? []) {
      const cols = issue.missing.map((m) => `${m.label} (${m.field})`).join(", ");
      console.error(`  • ${issue.table} · ${issue.locale} · source "${issue.source}" → ${cols}`);
    }
    console.error("");
  }

  process.exit(1);
}

main();
