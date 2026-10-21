import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runtimeImportGraph } from "./runtime-import-graph";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "openmapx-import-graph-"));
  roots.push(root);
  const all: Record<string, string> = {
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        module: "ESNext",
        moduleResolution: "Bundler",
        paths: { "@openmapx/lib/*": ["./packages/lib/src/*.ts"] },
      },
    }),
    ...files,
  };
  for (const [path, contents] of Object.entries(all)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  }
  return root;
}

describe("runtime import graph", () => {
  it("follows runtime imports through relative paths, aliases and literal dynamic imports", () => {
    const root = workspace({
      "app/src/index.ts": [
        'import { a } from "./a.js";',
        'export { b } from "@openmapx/lib/b";',
        'const lazy = () => import("../../shared/lazy");',
        'import "./side-effect";',
      ].join("\n"),
      "app/src/a.ts": "export const a = 1;",
      "app/src/side-effect.ts": "globalThis.x = 1;",
      "app/src/index.test.ts": 'import "../../untested";',
      "packages/lib/src/b.ts": "export const b = 2;",
      "shared/lazy.ts": "export default 3;",
    });
    expect(runtimeImportGraph({ root, tsconfig: "tsconfig.json", entries: ["app/src"] })).toEqual({
      files: [
        "app/src/a.ts",
        "app/src/index.ts",
        "app/src/side-effect.ts",
        "packages/lib/src/b.ts",
        "shared/lazy.ts",
      ],
      undeclaredComputedImports: [],
      staleComputedImportDeclarations: [],
      unresolved: [],
    });
  });

  it("does not follow type-only imports and exports, which are erased before running", () => {
    const root = workspace({
      "app/index.ts": [
        'import type { A } from "./types-a";',
        'import { type B } from "./types-b";',
        'export type { C } from "./types-c";',
        'import { type D, value } from "./mixed";',
      ].join("\n"),
      "app/types-a.ts": "export type A = 1;",
      "app/types-b.ts": "export type B = 1;",
      "app/types-c.ts": "export type C = 1;",
      "app/mixed.ts": "export type D = 1; export const value = 1;",
    });
    expect(
      runtimeImportGraph({ root, tsconfig: "tsconfig.json", entries: ["app/index.ts"] }).files,
    ).toEqual(["app/index.ts", "app/mixed.ts"]);
  });

  it("requires computed imports to be declared and follows the declared files", () => {
    const root = workspace({
      "app/index.ts":
        'const url = new URL("../lib/target.ts", import.meta.url).href;\nawait import(url);',
      "lib/target.ts": 'import "./dependency";',
      "lib/dependency.ts": "",
    });
    const undeclared = runtimeImportGraph({ root, tsconfig: "tsconfig.json", entries: ["app"] });
    expect(undeclared.undeclaredComputedImports).toEqual(["app/index.ts"]);
    expect(undeclared.files).toEqual(["app/index.ts"]);

    const declared = runtimeImportGraph({
      root,
      tsconfig: "tsconfig.json",
      entries: ["app"],
      computedImports: { "app/index.ts": ["lib/target.ts"], "app/gone.ts": ["lib/target.ts"] },
    });
    expect(declared.undeclaredComputedImports).toEqual([]);
    expect(declared.files).toEqual(["app/index.ts", "lib/dependency.ts", "lib/target.ts"]);
    expect(declared.staleComputedImportDeclarations).toEqual(["app/gone.ts"]);
  });

  it("reports relative and workspace imports that do not resolve", () => {
    const root = workspace({
      "app/index.ts": 'import "./missing";\nimport "@openmapx/lib/absent";\nimport "node:fs";',
    });
    expect(
      runtimeImportGraph({ root, tsconfig: "tsconfig.json", entries: ["app"] }).unresolved,
    ).toEqual(["app/index.ts -> ./missing", "app/index.ts -> @openmapx/lib/absent"]);
  });
});
