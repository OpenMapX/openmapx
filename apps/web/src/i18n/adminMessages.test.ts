import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import en from "@openmapx/i18n/locales/en.json";
import { describe, expect, it } from "vitest";
import { ADMIN_NAMESPACES, withoutAdminMessages } from "./adminMessages";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APP = join(SRC, "app");
const ADMIN_APP = join(APP, "admin");
const EXTENSIONS = [".tsx", ".ts", "/index.tsx", "/index.ts"];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [path] : [];
  });
}

function resolveImport(from: string, specifier: string): string | null {
  const base = specifier.startsWith("@/")
    ? join(SRC, specifier.slice(2))
    : specifier.startsWith(".")
      ? resolve(dirname(from), specifier)
      : null;
  if (!base) return null;
  if (existsSync(base) && statSync(base).isFile()) return base;
  for (const extension of EXTENSIONS) if (existsSync(base + extension)) return base + extension;
  return null;
}

/** A match's one capture group, which both patterns below always fill. */
function captured(match: RegExpMatchArray): string {
  const [, group] = match;
  if (group === undefined) throw new Error(`No capture in ${match[0]}`);
  return group;
}

const IMPORT = /(?:from\s+|import\s*\(\s*|import\s+)["']([^"']+)["']/g;
const NAMESPACE = /(?:useTranslations|getTranslations)\(\s*(?:\{[^}]*namespace:\s*)?["'](\w+)/g;

/** Every web source file a non-admin route can load, with the namespaces each one reads. */
function publicReach() {
  const entries = sourceFiles(APP).filter((file) => !file.startsWith(ADMIN_APP));
  const seen = new Set<string>();
  const queue = [...entries];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    for (const match of readFileSync(file, "utf8").matchAll(IMPORT)) {
      const target = resolveImport(file, captured(match));
      if (target && !seen.has(target)) queue.push(target);
    }
  }
  return [...seen].flatMap((file) =>
    [...readFileSync(file, "utf8").matchAll(NAMESPACE)].map((match) => ({
      file: relative(SRC, file),
      namespace: captured(match),
    })),
  );
}

describe("admin messages", () => {
  it("keeps every namespace a public page can read in the public payload", () => {
    const leaks = publicReach().filter(({ namespace }) => ADMIN_NAMESPACES.has(namespace));
    expect(leaks).toEqual([]);
  });

  it("names only namespaces the catalogue defines", () => {
    expect([...ADMIN_NAMESPACES].filter((namespace) => !(namespace in en))).toEqual([]);
  });

  it("drops only the admin namespaces from the public payload", () => {
    const publicMessages = withoutAdminMessages(en);
    expect(Object.keys(publicMessages)).toEqual(
      Object.keys(en).filter((namespace) => !ADMIN_NAMESPACES.has(namespace)),
    );
    expect(publicMessages).toHaveProperty("adminDrafts");
  });
});
