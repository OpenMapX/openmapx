/**
 * Codemod that applies the finalized feed-id migration map
 * (`scripts/feed-ids/feed-id-map.json`) across the source tree: manifests,
 * strings, poi-source declarations, provider modules, and the one web
 * component that hard-codes a source id.
 *
 * `oldId`s overlap as substrings of one another (e.g. "apag" inside
 * "apag-mobidrom") and also appear inside import specifiers, filenames, and
 * identifiers ("./apag.js", "searchApag"). A naive boundary/substring replace
 * would corrupt those. `rewriteText` instead only ever replaces a FULL quoted
 * string literal (`"apag"` / `'apag'`) or a bare object-key token in key
 * position — both of which require the whole token, not just a prefix, to
 * equal `oldId`/`oldPrefix`. That makes it safe to run every migrating entry
 * over every target file rather than curating a per-file entry subset.
 *
 * This codemod only rewrites id/prefix string literals — it does not inject
 * the new `parts: { … }` field the poi-source declarations could adopt
 * (`packages/poi-source-registry` already derives `id`/`stationIdPrefix` from
 * `parts` when present, see `derive.ts`). Doing that safely needs an AST edit
 * (a new object property), which is out of scope for a text-literal codemod;
 * it is a manual follow-up once the id rename lands.
 *
 * Default is dry-run: prints, per file, which oldId -> newId replacements
 * would occur plus a compact line diff. Pass `--write` to apply.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MAP_FILE = join(REPO_ROOT, "scripts", "feed-ids", "feed-id-map.json");

const EXCLUDED_DIRS = new Set(["node_modules", ".next", "dist", ".turbo"]);

interface RawMapEntry {
  domain: string;
  oldId: string;
  oldPrefix?: string | null;
  parts: unknown;
  newId: string | null;
  newPrefix: string | null;
  migrate: boolean;
  tableOld?: string;
  tableNew?: string;
}

/** The subset of a map entry `rewriteText` needs — id + prefix tokens only. */
export interface MigrateEntry {
  oldId: string;
  newId: string;
  oldPrefix?: string | null;
  newPrefix?: string | null;
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type CommentRange = readonly [start: number, end: number];

/**
 * Byte ranges of `//` line comments and `/* *\/` block comments in `text`, so
 * a rewrite rule can skip a quoted oldId that only appears in comment prose
 * (e.g. a JSDoc line like `Source id is unchanged ("barcelona-es", ...)`).
 * Tracks string/template literals too, purely so a `//`/`/*` byte sequence
 * inside a string (e.g. a URL) is never misread as a comment start.
 */
function findCommentRanges(text: string): CommentRange[] {
  const ranges: CommentRange[] = [];
  const n = text.length;
  let i = 0;
  let mode: "code" | "line" | "block" | "dquote" | "squote" | "template" = "code";
  let start = -1;
  while (i < n) {
    const c = text[i];
    const c2 = text[i + 1];
    if (mode === "code") {
      if (c === "/" && c2 === "/") {
        mode = "line";
        start = i;
        i += 2;
      } else if (c === "/" && c2 === "*") {
        mode = "block";
        start = i;
        i += 2;
      } else if (c === '"') {
        mode = "dquote";
        i += 1;
      } else if (c === "'") {
        mode = "squote";
        i += 1;
      } else if (c === "`") {
        mode = "template";
        i += 1;
      } else {
        i += 1;
      }
    } else if (mode === "line") {
      if (c === "\n") {
        ranges.push([start, i]);
        mode = "code";
      }
      i += 1;
    } else if (mode === "block") {
      if (c === "*" && c2 === "/") {
        ranges.push([start, i + 2]);
        mode = "code";
        i += 2;
      } else {
        i += 1;
      }
    } else {
      // dquote / squote / template: consume until the matching closer,
      // skipping escaped characters.
      if (c === "\\") {
        i += 2;
        continue;
      }
      const closer = mode === "dquote" ? '"' : mode === "squote" ? "'" : "`";
      if (c === closer) mode = "code";
      i += 1;
    }
  }
  if (mode === "line" || mode === "block") ranges.push([start, n]);
  return ranges;
}

function isInAnyRange(offset: number, ranges: readonly CommentRange[]): boolean {
  return ranges.some(([start, end]) => offset >= start && offset < end);
}

/**
 * Every quoted/keyed regex this entry contributes to a rewrite pass, paired
 * with its replacement. Built once per entry so `rewriteText` and the
 * per-file match counter (used for dry-run reporting + the not-found check)
 * share one definition and can never drift apart.
 */
function entryRules(entry: MigrateEntry): { pattern: RegExp; replacement: string }[] {
  const oldIdPattern = escapeRegExp(entry.oldId);
  const rules: { pattern: RegExp; replacement: string }[] = [
    { pattern: new RegExp(`"${oldIdPattern}"`, "g"), replacement: `"${entry.newId}"` },
    { pattern: new RegExp(`'${oldIdPattern}'`, "g"), replacement: `'${entry.newId}'` },
    // Bare (unquoted) object key, e.g. `apag: 1,` -> `"de-apag": 1,`. Only
    // matches oldId in key position (preceded by `{`/`,`, followed by `:`),
    // so it never touches the same token inside a comment, path, or identifier.
    {
      pattern: new RegExp(`(?<=[{,]\\s*)${oldIdPattern}(?=\\s*:)`, "g"),
      replacement: `"${entry.newId}"`,
    },
  ];
  if (entry.oldPrefix && entry.newPrefix) {
    const oldPrefixPattern = escapeRegExp(entry.oldPrefix);
    rules.push(
      { pattern: new RegExp(`"${oldPrefixPattern}"`, "g"), replacement: `"${entry.newPrefix}"` },
      { pattern: new RegExp(`'${oldPrefixPattern}'`, "g"), replacement: `'${entry.newPrefix}'` },
    );
  }
  return rules;
}

/** Runs one rule over `text`, leaving any match that falls inside a comment untouched. */
function applyRule(text: string, pattern: RegExp, replacement: string): string {
  const ranges = findCommentRanges(text);
  if (ranges.length === 0) return text.replace(pattern, replacement);
  return text.replace(pattern, (match, ...rest) => {
    const offset = typeof rest[0] === "number" ? rest[0] : 0;
    return isInAnyRange(offset, ranges) ? match : replacement;
  });
}

/** Counts how many of `pattern`'s matches in `text` sit outside a comment (i.e. would actually rewrite). */
function countRuleMatches(text: string, pattern: RegExp): number {
  const ranges = findCommentRanges(text);
  let count = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index !== undefined && !isInAnyRange(match.index, ranges)) count += 1;
  }
  return count;
}

/**
 * Applies every migrating entry's quoted-literal / bare-key rewrite rules to
 * `text`, skipping any match inside a comment. Idempotent: once an oldId
 * literal has been rewritten to its newId, no rule for any entry matches it
 * again (newIds are distinct from oldIds). Comment ranges are recomputed
 * before each rule since earlier replacements shift text offsets.
 */
export function rewriteText(text: string, entries: readonly MigrateEntry[]): string {
  let out = text;
  for (const entry of entries) {
    for (const { pattern, replacement } of entryRules(entry)) {
      out = applyRule(out, pattern, replacement);
    }
  }
  return out;
}

/** Number of times `entry`'s rules would fire against `text` (comment matches excluded), for reporting. */
function countEntryMatches(text: string, entry: MigrateEntry): number {
  let count = 0;
  for (const { pattern } of entryRules(entry)) {
    count += countRuleMatches(text, pattern);
  }
  return count;
}

function listJsonFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => join(dir, name));
}

function walkTsFiles(dir: string, out: string[]): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDED_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkTsFiles(full, out);
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
}

const MIGRATING_DOMAINS = ["ev-charging", "parking", "fuel"] as const;

/** The fixed target-file set from Task 6's global constraints + INVENTORY.md. */
export function collectTargetFiles(): string[] {
  const files: string[] = [];

  for (const domain of MIGRATING_DOMAINS) {
    const integrationDir = join(REPO_ROOT, "integrations", domain);
    const manifest = join(integrationDir, "manifest.json");
    if (existsSync(manifest)) files.push(manifest);
    files.push(...listJsonFiles(join(integrationDir, "strings")));
    const poiSources = join(integrationDir, "poi-sources.ts");
    if (existsSync(poiSources)) files.push(poiSources);
    walkTsFiles(join(integrationDir, "providers"), files);
  }

  const dataSourceSections = join(
    REPO_ROOT,
    "apps",
    "web",
    "src",
    "components",
    "panels",
    "place",
    "DataSourceSections.tsx",
  );
  if (existsSync(dataSourceSections)) files.push(dataSourceSections);

  return files;
}

/** Compact line-level diff — id rewrites never add/remove lines, so a 1:1
 * line comparison is enough (no need for a full LCS diff). */
function printDiff(before: string, after: string): void {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const max = Math.max(beforeLines.length, afterLines.length);
  for (let i = 0; i < max; i++) {
    const b = beforeLines[i];
    const a = afterLines[i];
    if (b === a) continue;
    if (b !== undefined) console.log(`    - ${b.trim()}`);
    if (a !== undefined) console.log(`    + ${a.trim()}`);
  }
}

function loadMigratingEntries(): MigrateEntry[] {
  const raw = JSON.parse(readFileSync(MAP_FILE, "utf8")) as RawMapEntry[];
  const entries = raw
    .filter((entry) => entry.migrate)
    .map((entry) => ({
      oldId: entry.oldId,
      newId: entry.newId as string,
      oldPrefix: entry.oldPrefix ?? undefined,
      newPrefix: entry.newPrefix ?? undefined,
    }));
  assertNewIdsDisjointFromOldIds(entries);
  return entries;
}

/**
 * `rewriteText`'s idempotency and per-entry correctness both rely on no
 * entry's newId colliding with any entry's oldId — otherwise a single pass
 * could rewrite an already-migrated id a second time. Verified once here,
 * in the driver, rather than inside `rewriteText` itself.
 */
function assertNewIdsDisjointFromOldIds(entries: readonly MigrateEntry[]): void {
  const oldIds = new Set(entries.map((entry) => entry.oldId));
  const offenders = entries.map((entry) => entry.newId).filter((newId) => oldIds.has(newId));
  if (offenders.length > 0) {
    throw new Error(
      `feed-id-map.json has newId(s) that collide with an oldId, which would break rewriteText's idempotency: ${offenders.join(", ")}`,
    );
  }
}

function run(write: boolean): void {
  const migrating = loadMigratingEntries();
  const files = collectTargetFiles();
  const notFound = new Set(migrating.map((entry) => entry.oldId));

  let filesChanged = 0;
  let totalReplacements = 0;

  for (const file of files) {
    const original = readFileSync(file, "utf8");
    const hits: { entry: MigrateEntry; count: number }[] = [];
    for (const entry of migrating) {
      const count = countEntryMatches(original, entry);
      if (count > 0) {
        hits.push({ entry, count });
        notFound.delete(entry.oldId);
      }
    }
    if (hits.length === 0) continue;

    const updated = rewriteText(original, migrating);
    if (updated === original) continue;

    filesChanged += 1;
    const fileTotal = hits.reduce((sum, h) => sum + h.count, 0);
    totalReplacements += fileTotal;

    console.log(`\n${relative(REPO_ROOT, file)}`);
    for (const { entry, count } of hits) {
      console.log(`  ${entry.oldId} -> ${entry.newId} (${count}x)`);
    }
    printDiff(original, updated);

    if (write) writeFileSync(file, updated, "utf8");
  }

  console.log(
    `\n${write ? "Applied" : "Would change"} ${filesChanged} file(s), ${totalReplacements} replacement(s) across ${files.length} scanned file(s).`,
  );

  if (notFound.size > 0) {
    console.log(`\nWARNING: no rewrite site found for these migrating oldIds (check manually):`);
    for (const id of notFound) console.log(`  - ${id}`);
  } else {
    console.log("\nEvery migrating oldId was found in at least one target file.");
  }

  if (!write) {
    console.log("\nDry run only — pass --write to apply these changes.");
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isMainModule()) {
  run(process.argv.includes("--write"));
}
