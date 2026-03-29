#!/usr/bin/env npx tsx
/**
 * Translation health checker for OpenMapX.
 *
 * Checks:
 *  1. Key consistency  — keys in en.json missing from other locales and vice versa
 *  2. Unused keys      — keys defined in JSON but never referenced in source
 *  3. Missing keys     — keys referenced in source but not defined in JSON
 *  4. Duplicate values — same English text mapped to multiple keys (info only)
 *  5. Empty values     — keys whose value is an empty string
 *  6. Placeholder consistency — ICU variable names that differ between locales
 *
 * Usage:
 *   pnpm -C apps/web exec tsx scripts/check-translations.ts
 *   pnpm -C apps/web exec tsx scripts/check-translations.ts --fix-missing
 *
 * Limitations:
 *   Dynamic key references (e.g. t(variable) or t(`prefix.${dynamic}`)) can't be
 *   detected statically. Keys only used dynamically will show as UNUSED — review
 *   these manually rather than blindly deleting them.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, "..");
const REPO_ROOT = join(PKG_ROOT, "..", "..");
const MESSAGES_DIR = join(PKG_ROOT, "locales");
const SRC_DIRS = [
  join(REPO_ROOT, "apps", "web", "src"),
  join(REPO_ROOT, "apps", "mobile", "app"),
  join(REPO_ROOT, "apps", "mobile", "src"),
];
const FIX_MISSING = process.argv.includes("--fix-missing");

// Helpers

function flattenKeys(obj: Record<string, unknown>, prefix = ""): Map<string, string> {
  const result = new Map<string, string>();
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      for (const [k, v] of flattenKeys(value as Record<string, unknown>, fullKey)) {
        result.set(k, v);
      }
    } else {
      result.set(fullKey, String(value));
    }
  }
  return result;
}

function collectFiles(dir: string, exts: string[]): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      files.push(...collectFiles(full, exts));
    } else if (exts.some((ext) => entry.endsWith(ext))) {
      files.push(full);
    }
  }
  return files;
}

/** Extract top-level ICU variable names from a message string. */
function extractICUVariables(value: string): string[] {
  const vars = new Set<string>();
  let depth = 0;
  let i = 0;
  while (i < value.length) {
    if (value[i] === "{") {
      if (depth === 0) {
        const rest = value.slice(i + 1);
        const nameMatch = rest.match(/^\s*(\w+)/);
        if (nameMatch) vars.add(nameMatch[1]);
      }
      depth++;
    } else if (value[i] === "}") {
      depth = Math.max(0, depth - 1);
    }
    i++;
  }
  return [...vars].sort();
}

// Load locale files

const localeFiles = readdirSync(MESSAGES_DIR)
  .filter((f) => f.endsWith(".json"))
  .sort();

if (localeFiles.length === 0) {
  console.error("No locale files found in", MESSAGES_DIR);
  process.exit(1);
}

const allLocales = new Map<string, Map<string, string>>();
const localeRaw = new Map<string, Record<string, unknown>>();

for (const file of localeFiles) {
  const locale = file.replace(".json", "");
  const raw = JSON.parse(readFileSync(join(MESSAGES_DIR, file), "utf-8"));
  localeRaw.set(locale, raw);
  allLocales.set(locale, flattenKeys(raw));
}

const referenceLocale = "en";
const referenceKeys = allLocales.get(referenceLocale);
if (!referenceKeys) {
  console.error(`Reference locale "${referenceLocale}" not found`);
  process.exit(1);
}

const counts = { errors: 0, warnings: 0, info: 0 };

function error(category: string, message: string) {
  counts.errors++;
  console.log(`  \x1b[31m[ERROR]\x1b[0m [${category}] ${message}`);
}

function warn(category: string, message: string) {
  counts.warnings++;
  console.log(`  \x1b[33m[WARN]\x1b[0m  [${category}] ${message}`);
}

function info(category: string, message: string) {
  counts.info++;
  console.log(`  \x1b[2m[INFO]\x1b[0m  [${category}] ${message}`);
}

// 1. Key consistency

console.log("\n\x1b[1m1. Key consistency between locales\x1b[0m\n");

let consistencyOk = true;
for (const [locale, keys] of allLocales) {
  if (locale === referenceLocale) continue;

  const missingInLocale = [...referenceKeys.keys()].filter((k) => !keys.has(k));
  const extraInLocale = [...keys.keys()].filter((k) => !referenceKeys.has(k));

  for (const k of missingInLocale) {
    error("MISSING", `${locale}.json is missing "${k}"`);
    consistencyOk = false;
  }
  for (const k of extraInLocale) {
    warn("EXTRA", `${locale}.json has extra "${k}" (not in ${referenceLocale}.json)`);
    consistencyOk = false;
  }
}

if (consistencyOk) console.log("  All locales have matching keys.");

// 2 & 3. Unused and missing keys

console.log(
  '\n\x1b[1m2. Unused keys\x1b[0m (defined but never referenced via static t("key") calls)\n',
);

const sourceFiles = SRC_DIRS.filter((d) => {
  try {
    statSync(d);
    return true;
  } catch {
    return false;
  }
}).flatMap((d) => collectFiles(d, [".tsx", ".ts"]));

const usedKeys = new Set<string>();
const namespacesWithDynamicCalls = new Set<string>();

for (const file of sourceFiles) {
  const content = readFileSync(file, "utf-8");

  // Map variable names to namespaces
  const varNsPattern = /const\s+(\w+)\s*=\s*useTranslations\(\s*["']([^"']+)["']\s*\)/g;
  const varToNs = new Map<string, string>();
  for (const match of content.matchAll(varNsPattern)) {
    varToNs.set(match[1], match[2]);
  }

  for (const [varName, ns] of varToNs) {
    // Static calls: varName("literal")
    const staticPattern = new RegExp(`\\b${varName}\\(\\s*["']([^"']+)["']`, "g");
    for (const match of content.matchAll(staticPattern)) {
      usedKeys.add(`${ns}.${match[1]}`);
    }

    // Dynamic calls: varName(variable) or varName(`template`)
    const dynamicPattern = new RegExp(`\\b${varName}\\(\\s*(?!["'])([\\w\`])`, "g");
    if (dynamicPattern.test(content)) {
      namespacesWithDynamicCalls.add(ns);
    }
  }

  // react-i18next: const { t } = useTranslation() — uses flat dotted keys like t("ns.key")
  const i18nextPattern = /\{\s*t\s*\}\s*=\s*useTranslation\(\)/;
  if (i18nextPattern.test(content)) {
    const flatPattern = /\bt\(\s*["']([^"']+)["']/g;
    for (const match of content.matchAll(flatPattern)) {
      usedKeys.add(match[1]);
    }
  }
}

// Gather all source content for string literal matching (catches dynamic labelKey patterns)
const allSourceContent = sourceFiles.map((f) => readFileSync(f, "utf-8")).join("\n");

let unusedCount = 0;
for (const key of referenceKeys.keys()) {
  if (usedKeys.has(key)) continue;

  // Skip parent namespace keys
  const isParent = [...usedKeys].some((uk) => uk.startsWith(`${key}.`));
  if (isParent) continue;

  const lastSegment = key.split(".").pop() ?? "";

  // If the key's last segment appears as a string literal somewhere in source,
  // it's likely used dynamically (e.g. labelKey pattern, mode mapping, etc.)
  if (
    allSourceContent.includes(`"${lastSegment}"`) ||
    allSourceContent.includes(`'${lastSegment}'`) ||
    allSourceContent.includes(`\`${lastSegment}\``)
  ) {
    continue;
  }

  warn("UNUSED", `"${key}" — not found via static analysis (may be used dynamically)`);
  unusedCount++;
}
if (unusedCount === 0) console.log("  All keys appear to be referenced.");

console.log("\n\x1b[1m3. Missing keys\x1b[0m (referenced in source but not defined)\n");

let missingCount = 0;
for (const key of usedKeys) {
  if (!referenceKeys.has(key)) {
    error("UNDEFINED", `"${key}" is used in source but not in ${referenceLocale}.json`);
    missingCount++;
  }
}
if (missingCount === 0) console.log("  All referenced keys are defined.");

// 4. Duplicate values

console.log("\n\x1b[1m4. Duplicate values\x1b[0m in reference locale (informational)\n");

const valueToKeys = new Map<string, string[]>();
for (const [key, value] of referenceKeys) {
  const existing = valueToKeys.get(value) ?? [];
  existing.push(key);
  valueToKeys.set(value, existing);
}

let dupCount = 0;
for (const [value, keys] of valueToKeys) {
  // Only flag cross-namespace duplicates for non-trivial strings
  const namespaces = new Set(keys.map((k) => k.split(".")[0]));
  if (keys.length > 1 && namespaces.size > 1 && value.length > 5) {
    info("DUPLICATE", `"${value}" -> ${keys.join(", ")}`);
    dupCount++;
  }
}
if (dupCount === 0) console.log("  No cross-namespace duplicates found.");

// 5. Empty values

console.log("\n\x1b[1m5. Empty values\x1b[0m\n");

let emptyCount = 0;
for (const [locale, keys] of allLocales) {
  for (const [key, value] of keys) {
    if (value.trim() === "") {
      error("EMPTY", `${locale}.json: "${key}" has an empty value`);
      emptyCount++;
    }
  }
}
if (emptyCount === 0) console.log("  No empty values found.");

// 6. ICU placeholder consistency

console.log("\n\x1b[1m6. ICU placeholder consistency\x1b[0m\n");

let placeholderIssues = 0;
for (const [locale, keys] of allLocales) {
  if (locale === referenceLocale) continue;
  for (const [key, value] of keys) {
    const refValue = referenceKeys.get(key);
    if (!refValue) continue;

    const refVars = extractICUVariables(refValue);
    const locVars = extractICUVariables(value);

    if (JSON.stringify(refVars) !== JSON.stringify(locVars)) {
      error(
        "PLACEHOLDER",
        `${locale}.json "${key}": variables differ — ${referenceLocale}=[${refVars.join(", ")}] vs ${locale}=[${locVars.join(", ")}]`,
      );
      placeholderIssues++;
    }
  }
}
if (placeholderIssues === 0) console.log("  All ICU variables are consistent.");

// Fix mode

if (FIX_MISSING) {
  console.log("\n\x1b[1mFix mode: stubbing missing keys\x1b[0m\n");

  for (const [locale, keys] of allLocales) {
    if (locale === referenceLocale) continue;

    const missingKeys = [...referenceKeys.keys()].filter((k) => !keys.has(k));
    if (missingKeys.length === 0) {
      console.log(`  ${locale}.json: no missing keys.`);
      continue;
    }

    const raw = localeRaw.get(locale) as Record<string, unknown>;

    for (const flatKey of missingKeys) {
      const parts = flatKey.split(".");
      let obj = raw;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!(parts[i] in obj) || typeof obj[parts[i]] !== "object") {
          (obj as Record<string, unknown>)[parts[i]] = {};
        }
        obj = obj[parts[i]] as Record<string, unknown>;
      }
      const refValue = referenceKeys.get(flatKey) ?? "";
      (obj as Record<string, unknown>)[parts[parts.length - 1]] = `TODO: ${refValue}`;
      console.log(`  Stubbed "${flatKey}" in ${locale}.json`);
    }

    writeFileSync(join(MESSAGES_DIR, `${locale}.json`), `${JSON.stringify(raw, null, 2)}\n`);
    console.log(`  Wrote ${locale}.json\n`);
  }
}

// Summary

const color = counts.errors > 0 ? "\x1b[31m" : counts.warnings > 0 ? "\x1b[33m" : "\x1b[32m";

console.log(`\n${color}Errors:   ${counts.errors}`);
console.log(`Warnings: ${counts.warnings}`);
console.log(`Info:     ${counts.info}\x1b[0m\n`);

process.exit(counts.errors > 0 ? 1 : 0);
