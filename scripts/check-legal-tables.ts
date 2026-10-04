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
 * An integration whose manifest sets `runtimeDataSources: true` has no static
 * sources: the host validates each source it supplies at runtime, and the legal
 * tables take that source's purpose/dataSent from the entry keyed
 * `domain:<domain>`. For such an integration this check requires a complete
 * `domain:<d>` entry and a section heading for every declared domain, accepts
 * only `domain:<d>` keys, and names the integration in its output.
 *
 * Anything wrong is reported grouped by integration and the process exits
 * non-zero so the commit is blocked. Run on demand with `pnpm check-legal-tables`.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  IntegrationDataSource,
  IntegrationManifest,
  IntegrationStrings,
  LoadedIntegrationMeta,
} from "@openmapx/integration-framework";
import {
  type AttributionRow,
  DOMAIN_TO_SECTION_KEY,
  generateAttributionSectionsFromManifests,
  generatePrivacySectionsFromManifests,
  legalSectionDomain,
  legalSectionStrings,
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

export interface DiscoveredIntegration {
  id: string;
  manifest: IntegrationManifest;
  strings: IntegrationStrings;
  dir: string;
}

/** One row that has at least one empty cell, with the columns that are blank. */
export interface RowIssue {
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

/**
 * The integration's sources in the order the generators emit their rows: grouped
 * by legal section in first-seen order, manifest order within a section. Lets a
 * flattened row be traced back to its sourceId when one integration spans
 * several sections.
 */
function sourcesInRowOrder(meta: LoadedIntegrationMeta): IntegrationDataSource[] {
  const bySection = new Map<string, IntegrationDataSource[]>();
  for (const ds of meta.dataSources ?? []) {
    const domain = legalSectionDomain(meta, ds);
    const key = DOMAIN_TO_SECTION_KEY[domain] ?? domain;
    bySection.set(key, [...(bySection.get(key) ?? []), ds]);
  }
  return [...bySection.values()].flat();
}

function checkIntegration(meta: LoadedIntegrationMeta, dir: string): RowIssue[] {
  const issues: RowIssue[] = [];
  const sources = sourcesInRowOrder(meta);

  for (const locale of LOCALES) {
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
          source: sources[i]?.sourceId ?? row.source ?? `#${i}`,
          missing,
        });
      }
    });
  }

  return issues;
}

const isRuntime = (it: DiscoveredIntegration): boolean => it.manifest.runtimeDataSources === true;

const domainKey = (domain: string): string => `domain:${domain}`;

/**
 * A runtime integration's sources take purpose and dataSent from the
 * `domain:<d>` entry of their domain, so every declared domain needs a
 * complete entry in every locale.
 */
function checkRuntimeDomainStrings(it: DiscoveredIntegration): string[] {
  const problems: string[] = [];
  for (const locale of LOCALES) {
    const ds = it.strings[locale]?.dataSources as Record<string, unknown> | undefined;
    for (const domain of it.manifest.domains ?? []) {
      const key = domainKey(domain);
      const entry = ds && typeof ds === "object" && !Array.isArray(ds) ? ds[key] : undefined;
      if (!entry || typeof entry !== "object") {
        problems.push(
          `${locale}: strings.dataSources["${key}"] is missing — runtime sources of domain "${domain}" take purpose and dataSent from it`,
        );
        continue;
      }
      const fields = entry as Record<string, unknown>;
      if (isEmpty(fields.purpose) && isEmpty(fields.service)) {
        problems.push(`${locale}: strings.dataSources["${key}"].purpose is empty`);
      }
      if (isEmpty(fields.dataSent)) {
        problems.push(`${locale}: strings.dataSources["${key}"].dataSent is empty`);
      }
    }
  }
  return problems;
}

/**
 * Structural guards that keep the sourceId-keyed contract intact: localized
 * `dataSources` must be an OBJECT keyed by manifest sourceId (never a positional
 * array again), and every key must match an actual manifest source (no stale or
 * mistyped keys that silently describe nothing). A runtime integration's keys
 * are `domain:<d>` for its declared domains instead.
 */
function checkStructure(it: DiscoveredIntegration): string[] {
  const problems: string[] = [];
  const runtime = isRuntime(it);
  const allowedKeys = new Set(
    runtime
      ? (it.manifest.domains ?? []).map(domainKey)
      : (it.manifest.dataSources ?? []).map((d) => d.sourceId),
  );
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
      if (!allowedKeys.has(key)) {
        problems.push(
          runtime
            ? `${locale}: strings.dataSources key "${key}" is not "domain:<d>" for a manifest domain`
            : `${locale}: strings.dataSources key "${key}" has no matching manifest sourceId`,
        );
      }
    }
  }
  return problems;
}

/**
 * Section headings + exposure labels resolve through DOMAIN_TO_SECTION_KEY to the
 * i18n catalog (`legal.privacySections.<key>`, `legal.attributionSections.<key>`,
 * `legal.exposure.<value>`). The cell-emptiness checks above only look at row
 * data, and a heading falls back to the raw key when its catalog entry is
 * missing — so assert every contributing domain maps to a section key whose
 * catalog entries exist, and every exposure value used has a catalog label.
 * (check-translations separately guarantees en/de parity for the strings.) A
 * runtime integration can credit a source in any declared domain, so every
 * declared domain needs its headings.
 */
function checkHeadings(it: DiscoveredIntegration): string[] {
  const problems: string[] = [];
  const legal = legalSectionStrings("en");
  const integration = { domains: it.manifest.domains ?? [] };
  const domains = new Set(
    isRuntime(it)
      ? integration.domains
      : (it.manifest.dataSources ?? []).map((ds) => legalSectionDomain(integration, ds)),
  );
  for (const domain of domains) {
    const key = DOMAIN_TO_SECTION_KEY[domain];
    if (!key) {
      problems.push(
        `domain "${domain}" has no section key — add it to DOMAIN_TO_SECTION_KEY in generateLegalSections.ts`,
      );
      continue;
    }
    if (!(key in legal.privacySections)) {
      problems.push(
        `Privacy heading missing — add legal.privacySections.${key} to the i18n catalog`,
      );
    }
    if (!(key in legal.attributionSections)) {
      problems.push(
        `Terms heading missing — add legal.attributionSections.${key} to the i18n catalog`,
      );
    }
  }
  const exposures = new Set(
    (it.manifest.dataSources ?? [])
      .map((ds) => ds.endUserExposure)
      .filter((e): e is string => typeof e === "string" && e.length > 0),
  );
  for (const exposure of exposures) {
    if (!(exposure in legal.exposure)) {
      problems.push(`exposure label missing — add legal.exposure.${exposure} to the i18n catalog`);
    }
  }
  return problems;
}

export interface LegalTableProblems {
  /** Integrations with static sources, whose rows are checked cell by cell. */
  contributing: DiscoveredIntegration[];
  /** Integrations that supply their sources at runtime. */
  runtime: DiscoveredIntegration[];
  rowIssues: RowIssue[];
  structuralByDir: Map<string, string[]>;
}

export function collectLegalTableProblems(integrationsDir: string): LegalTableProblems {
  const integrations = discoverIntegrations(integrationsDir);
  const runtime = integrations.filter(isRuntime);
  const contributing = integrations.filter(
    (it) => !isRuntime(it) && it.manifest.dataSources?.length,
  );

  const structuralByDir = new Map<string, string[]>();
  const addProblems = (dir: string, problems: string[]) => {
    if (problems.length)
      structuralByDir.set(dir, [...(structuralByDir.get(dir) ?? []), ...problems]);
  };
  for (const it of integrations) addProblems(it.dir, checkStructure(it));
  for (const it of runtime) addProblems(it.dir, checkRuntimeDomainStrings(it));
  // Heading coverage is only meaningful for integrations that render rows.
  for (const it of [...contributing, ...runtime]) addProblems(it.dir, checkHeadings(it));

  const rowIssues: RowIssue[] = [];
  for (const it of contributing) {
    rowIssues.push(...checkIntegration(toMeta(it), it.dir));
  }

  return { contributing, runtime, rowIssues, structuralByDir };
}

function main(): void {
  const { contributing, runtime, rowIssues, structuralByDir } =
    collectLegalTableProblems(INTEGRATIONS_DIR);

  for (const it of runtime) {
    console.log(
      `ℹ ${it.id}: runtime data sources — no static rows to check; the host validates each ` +
        `source it supplies, and its domain:<d> strings and headings are checked here.`,
    );
  }

  if (rowIssues.length === 0 && structuralByDir.size === 0) {
    console.log(
      `✓ Legal tables complete: ${contributing.length} integration(s) with data sources, ` +
        `${runtime.length} with runtime data sources, ` +
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

// Only run when executed directly (`pnpm check-legal-tables`), not when a test
// imports `collectLegalTableProblems`.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
