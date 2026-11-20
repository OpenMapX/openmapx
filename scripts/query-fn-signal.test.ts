import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Every TanStack `queryFn` in browser code takes the query's abort signal, so
 * a request whose last observer unmounts, or whose key changes, is cancelled
 * instead of finishing for nobody. A query function passes the signal on by
 * destructuring `{ signal }`, or forwards the whole query context it names.
 */

const ROOT = resolve(import.meta.dirname, "..");
const SCANNED = [
  "apps/web/src",
  "packages/core/src",
  "packages/mangrove-react/src",
  "integrations",
];

/** Query functions that deliberately run without the signal, with the reason. */
const ALLOWED: Record<string, { count: number; reason: string }> = {
  "apps/web/src/components/panels/parking/useSaveParking.ts": {
    count: 1,
    reason:
      "an observerless fetchQuery that fills a saved spot's address after the panel closes, sharing the map's reverse-geocode cache entry",
  },
};

function collectFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "__tests__" || entry.name === "generated")
      continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectFiles(full));
    else if (
      /\.tsx?$/.test(entry.name) &&
      !entry.name.endsWith(".d.ts") &&
      !/\.test\.tsx?$/.test(entry.name)
    )
      out.push(full);
  }
  return out;
}

function usesIdentifier(node: ts.Node, name: string): boolean {
  let found = false;
  const visit = (child: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(child) && child.text === name) found = true;
    else ts.forEachChild(child, visit);
  };
  ts.forEachChild(node, visit);
  return found;
}

/** Whether a query function takes the signal, or forwards the context that carries it. */
function takesSignal(fn: ts.Expression): boolean {
  if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) return false;
  const [first] = fn.parameters;
  if (!first) return false;
  if (ts.isObjectBindingPattern(first.name)) {
    return first.name.elements.some(
      (element) =>
        (element.propertyName ?? element.name).getText() === "signal" ||
        element.dotDotDotToken !== undefined,
    );
  }
  return ts.isIdentifier(first.name) && usesIdentifier(fn.body, first.name.text);
}

function offendersIn(file: string): string[] {
  const source = readFileSync(file, "utf8");
  if (!source.includes("queryFn")) return [];
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const hits: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText(sf) === "queryFn" &&
      !takesSignal(node.initializer)
    ) {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      hits.push(`${relative(ROOT, file)}:${line + 1}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

describe("query functions take the abort signal", () => {
  const files = SCANNED.flatMap((dir) => collectFiles(resolve(ROOT, dir)));
  const offenders = files.flatMap(offendersIn);
  const byFile = new Map<string, number>();
  for (const hit of offenders) {
    const file = hit.slice(0, hit.lastIndexOf(":"));
    byFile.set(file, (byFile.get(file) ?? 0) + 1);
  }

  it("scans the browser sources", () => {
    expect(files.length).toBeGreaterThan(500);
  });

  it("finds no query function that drops the signal outside the allowlist", () => {
    const unexpected = offenders.filter((hit) => !ALLOWED[hit.slice(0, hit.lastIndexOf(":"))]);
    expect(
      unexpected,
      `Destructure { signal } and pass it to the request:\n${unexpected.join("\n")}`,
    ).toEqual([]);
  });

  it("keeps every allowlist entry exact", () => {
    for (const [file, { count }] of Object.entries(ALLOWED)) {
      expect(byFile.get(file) ?? 0, file).toBe(count);
    }
  });
});
