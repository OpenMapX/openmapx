import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ALL_BROWSER_STORAGE_KEYS,
  CACHE_STORAGE_NAMES,
  HISTORY_STATE_KEY,
  INDEXED_DB_DATABASES,
  PREFERENCE_KEYS,
  STORAGE_KEY_PREFIXES,
  STORAGE_KEYS,
} from "./storageKeys";

const REPO_ROOT = resolve(__dirname, "../../../..");
const SEGMENT = "[a-z0-9]+(?:-[a-z0-9]+)*";
const KEY = new RegExp(`^openmapx(?::${SEGMENT}){2}$`);
const PREFIX = new RegExp(`^openmapx(?::${SEGMENT}){2}:$`);
const NAME = new RegExp(`^openmapx:${SEGMENT}-?$`);

const SCANNED = [
  "apps/web/src",
  "apps/mobile/src",
  "integrations",
  ...readdirSync(join(REPO_ROOT, "packages")).map((name) => `packages/${name}/src`),
];
const SKIPPED_DIRECTORIES = new Set(["node_modules", ".next", "dist", "build", "coverage"]);
const THIS_MODULE = "packages/core/src/platform/storageKeys.ts";

/** A storage accessor whose key argument is spelled as a string literal. */
const LITERAL_KEY_CALL =
  /\b(?:getItem|setItem|removeItem|getString|setString|idbGet|idbSet|idbDelete)\s*(?:<[^>()]*>)?\(\s*["'`]|\.remove\(\s*["'`]openmapx/;
/** A database or Cache Storage name spelled as a string literal. */
const LITERAL_STORE_NAME_CALL =
  /\b(?:indexedDB|caches)\.(?:open|delete)\s*\(\s*["'`]|\.deleteDatabase\s*\(\s*["'`]/;
/**
 * A constant named like a storage key, database or cache that holds an
 * OpenMapX-looking name instead of reading the registry.
 */
const LITERAL_KEY_CONSTANT =
  /\b\w*(?:KEY|KEY_PREFIX|STORAGE\w*|DB_NAME|DATABASE_NAME|CACHE_NAME|CACHE_PREFIX)\s*(?::[^=]+)?=\s*["'`](?:openmapx|omx)[:-]/i;
/** Files whose matching constant names something other than browser storage. */
const NOT_BROWSER_STORAGE = new Map([
  ["apps/mobile/src/storage/database.ts", "the native SQLite file"],
  ["packages/core/src/services/external-proxy.ts", "a Docker network name"],
]);

function sourceFiles(directory: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      return SKIPPED_DIRECTORIES.has(entry) || entry === "__tests__" ? [] : sourceFiles(path);
    }
    if (!/\.(?:ts|tsx)$/.test(entry) || /\.test\.tsx?$/.test(entry) || entry.endsWith(".d.ts"))
      return [];
    return [path];
  });
}

describe("browser storage keys", () => {
  it("follows openmapx:<area>:<name> with kebab-case segments", () => {
    for (const entry of Object.values(STORAGE_KEYS)) expect(entry.key).toMatch(KEY);
    for (const entry of Object.values(STORAGE_KEY_PREFIXES)) expect(entry.key).toMatch(PREFIX);
    expect(HISTORY_STATE_KEY).toMatch(KEY);
  });

  it("names databases and caches openmapx:<name>", () => {
    for (const name of Object.values(INDEXED_DB_DATABASES)) expect(name).toMatch(NAME);
    for (const name of Object.values(CACHE_STORAGE_NAMES)) expect(name).toMatch(NAME);
  });

  it("declares each key once", () => {
    const keys = ALL_BROWSER_STORAGE_KEYS.map((entry) => entry.key);
    expect(new Set(keys).size).toBe(keys.length);
    const names = [...Object.values(INDEXED_DB_DATABASES), ...Object.values(CACHE_STORAGE_NAMES)];
    expect(new Set(names).size).toBe(names.length);
  });

  it("exports only scalar localStorage preferences", () => {
    for (const entry of ALL_BROWSER_STORAGE_KEYS.filter((candidate) => candidate.deviceExport))
      expect(entry.storage).toBe("localStorage");
    expect(PREFERENCE_KEYS).toContain(STORAGE_KEYS.navigation3d.key);
    expect(PREFERENCE_KEYS).toContain(STORAGE_KEYS.globeLighting.key);
    expect(PREFERENCE_KEYS).toContain(STORAGE_KEYS.searchHistoryEnabled.key);
  });

  it("gives every IndexedDB record a database", () => {
    for (const entry of ALL_BROWSER_STORAGE_KEYS)
      expect(entry.database !== undefined).toBe(entry.storage === "indexedDb");
  });

  it("is the only place that spells a storage key as a string literal", () => {
    const offenders: string[] = [];
    for (const root of SCANNED) {
      for (const file of sourceFiles(join(REPO_ROOT, root))) {
        const path = relative(REPO_ROOT, file);
        if (path === THIS_MODULE) continue;
        readFileSync(file, "utf8")
          .split("\n")
          .forEach((line, index) => {
            if (
              LITERAL_KEY_CALL.test(line) ||
              LITERAL_STORE_NAME_CALL.test(line) ||
              (LITERAL_KEY_CONSTANT.test(line) && !NOT_BROWSER_STORAGE.has(path))
            )
              offenders.push(`${path}:${index + 1}: ${line.trim()}`);
          });
      }
    }
    expect(offenders).toEqual([]);
  });
});
