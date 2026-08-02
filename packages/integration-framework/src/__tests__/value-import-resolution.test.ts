import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC_DIR = fileURLToPath(new URL("../", import.meta.url));

/**
 * A relative `import`/`export ... from` that is NOT type-only. Type-only ones are
 * erased before anything resolves them, so they are allowed to name a file that
 * was never emitted — which is why this package is full of `.js` specifiers that
 * work. `[^;]*?` spans the multi-line brace lists these barrels are written as.
 */
const VALUE_SPECIFIER = /(?:^|\n)\s*(?:import|export)\s+(?!type\b)[^;]*?from\s+"(\.[^"]*)"/g;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "__tests__") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      sourceFiles(full, out);
      continue;
    }
    if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** What the bundler will actually look for. Note there is no `.js` → `.ts` step. */
function resolves(fromFile: string, specifier: string): boolean {
  const base = path.resolve(path.dirname(fromFile), specifier);
  return [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")].some((candidate) =>
    fs.existsSync(candidate),
  );
}

/**
 * This package is source-only (`main: ./src/index.ts`) and reachable from the
 * browser bundle, so every value import it makes is resolved for real by
 * Turbopack — against files that exist, with no extension rewriting. A `.js`
 * specifier names a file this package never emits.
 *
 * `tsc` accepts those happily, which is the trap: `check-types` stays green and
 * the Docker `next build` is the only thing that fails. It has cost a red CI run
 * more than once. A type-only re-export gets away with it and a value one does
 * not, so the two can sit on adjacent lines looking identical.
 */
describe("value imports resolve to files that exist", () => {
  const files = sourceFiles(SRC_DIR);

  it("finds source files to check", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it("has no value import or export naming a file that was never emitted", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = fs.readFileSync(file, "utf8");
      for (const match of text.matchAll(VALUE_SPECIFIER)) {
        const specifier = match[1];
        if (resolves(file, specifier)) continue;
        const line = text.slice(0, match.index).split("\n").length;
        offenders.push(`${path.relative(process.cwd(), file)}:${line} -> ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
