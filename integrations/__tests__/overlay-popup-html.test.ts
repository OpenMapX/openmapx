import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  findUnsafeInterpolations,
  type GuardOptions,
  hasHtmlSink,
  type ModuleHost,
} from "./popup-html-guard";

const INTEGRATIONS_DIR = fileURLToPath(new URL("..", import.meta.url));

/**
 * MapLibre's Popup.setHTML assigns to innerHTML. Every value interpolated into
 * popup markup therefore has to be escaped, numeric or drawn from a fixed
 * table, and an interpolated anchor URL needs scheme validation before it is
 * emitted. This static guard checks the interpolations themselves, in each
 * file that writes HTML and in the local modules those files import, so a
 * helper import cannot vouch for a value it never touched.
 */

const EXEMPT = new Set<string>();

/**
 * The wildfire popup model carries strings that were escaped when the model was
 * built, so its renderer emits them as they are. Its tests cover the escaping.
 */
const PRE_ESCAPED_MODEL: Record<string, GuardOptions> = {
  "overlay-wildfires/presentation.ts": {
    trustedFunctions: ["renderPopupValue"],
    trustedExpressions: ["model.title.value"],
  },
};

const RESOLVABLE_EXTENSIONS = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];

function resolveModule(fromFile: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const base = path.resolve(path.dirname(fromFile), specifier.replace(/\.js$/, ""));
  for (const extension of RESOLVABLE_EXTENSIONS) {
    const candidate = `${base}${extension}`;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return undefined;
}

const moduleHost: ModuleHost = {
  read(fromFile, specifier) {
    const fileName = resolveModule(fromFile, specifier);
    return fileName ? { fileName, source: fs.readFileSync(fileName, "utf8") } : undefined;
  },
};

function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "__tests__") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...collectSourceFiles(full));
    else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec|d)\.tsx?$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

function relativeImports(fileName: string, source: string): string[] {
  const resolved: string[] = [];
  for (const match of source.matchAll(/(?:from|import)\s*["'](\.[^"']*)["']/g)) {
    const target = resolveModule(fileName, match[1]);
    if (target) resolved.push(target);
  }
  return resolved;
}

/** Files that write HTML, plus the local modules they import, which may build the markup. */
function collectMarkupFiles(files: string[]): string[] {
  const included = new Set<string>();
  const pending = files.filter((file) => hasHtmlSink(fs.readFileSync(file, "utf8")));
  while (pending.length > 0) {
    const file = pending.pop() as string;
    if (included.has(file) || !file.startsWith(INTEGRATIONS_DIR)) continue;
    included.add(file);
    pending.push(...relativeImports(file, fs.readFileSync(file, "utf8")));
  }
  return [...included].sort();
}

function lineNumber(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

function hasSanitizedBinding(source: string, expression: string): boolean {
  if (!/^[A-Za-z_$][\w$]*$/.test(expression)) return false;
  return new RegExp(
    `\\b(?:const|let|var)\\s+${expression}\\s*=.{0,240}?sanitizeUrl\\s*\\(`,
    "s",
  ).test(source);
}

function findUnsafeInterpolationOffenders(files: string[]): string[] {
  return files.flatMap((file) => {
    const relative = path.relative(INTEGRATIONS_DIR, file);
    if (EXEMPT.has(relative)) return [];
    const offenders = findUnsafeInterpolations(fs.readFileSync(file, "utf8"), file, {
      host: moduleHost,
      ...PRE_ESCAPED_MODEL[relative],
    });
    return offenders.map(
      (offender) => `${relative}:${offender.line} ${offender.text.slice(0, 80)}`,
    );
  });
}

function findUnsafeAnchorOffenders(files: string[]): string[] {
  return files.flatMap((file) => {
    const source = fs.readFileSync(file, "utf8");
    if (EXEMPT.has(path.relative(INTEGRATIONS_DIR, file))) return [];
    const offenders: string[] = [];
    for (const match of source.matchAll(/href\s*=\s*["']\$\{([^}]*)\}/g)) {
      const expression = match[1].trim();
      if (expression.startsWith("sanitizeUrl(") || hasSanitizedBinding(source, expression))
        continue;
      offenders.push(
        `${path.relative(INTEGRATIONS_DIR, file)}:${lineNumber(source, match.index ?? 0)}`,
      );
    }
    return offenders;
  });
}

describe("integration popup HTML safety", () => {
  const files = collectSourceFiles(INTEGRATIONS_DIR);
  const markupFiles = collectMarkupFiles(files);

  it("scans the integration source tree", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it("finds the files that write popup HTML and the modules that build it", () => {
    const relative = markupFiles.map((file) => path.relative(INTEGRATIONS_DIR, file));
    expect(relative).toContain("overlay-winter-sports/map-layer.tsx");
    expect(relative).toContain("road-conditions/popup.tsx");
    expect(relative).toContain("overlay-wildfires/presentation.ts");
    expect(relative).not.toContain("overlay-nautical/map-layer.tsx");
  });

  it("every value reaching popup markup is escaped, numeric or fixed", () => {
    const offenders = findUnsafeInterpolationOffenders(markupFiles);
    expect(
      offenders,
      `Interpolations into popup HTML must be escaped with escapeHtml (MapLibre assigns the value to innerHTML):\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("every interpolated popup href is scheme-checked", () => {
    const offenders = findUnsafeAnchorOffenders(files);
    expect(
      offenders,
      `Interpolated popup href values must use sanitizeUrl or a binding initialized by sanitizeUrl:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
