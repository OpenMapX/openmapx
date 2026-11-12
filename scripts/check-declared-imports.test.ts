import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { declaredImportViolations } from "./check-declared-imports.mjs";

const workspaces: string[] = [];
afterEach(() => {
  for (const dir of workspaces.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A workspace with a public library, a public tool that bundles a private
 * helper, and an app that is no public package's source. The root declares
 * `yaml`; only the app declares `react`, so it is available to the others
 * only through hoisting.
 */
function fixture(files: Record<string, string> = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "openmapx-declared-imports-"));
  workspaces.push(cwd);
  const write = (path: string, contents: string) => {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), contents);
  };
  write(
    "package.json",
    JSON.stringify({ name: "fixture", private: true, devDependencies: { yaml: "^2.0.0" } }),
  );
  write("pnpm-workspace.yaml", 'packages:\n  - "packages/*"\n');
  write(
    "scripts/public-packages.json",
    JSON.stringify({
      schemaVersion: 1,
      packages: [
        { name: "@fixture/lib", directory: "packages/lib", bundleWorkspaceDependencies: false },
        { name: "@fixture/tool", directory: "packages/tool", bundleWorkspaceDependencies: true },
      ],
    }),
  );
  const manifests = {
    lib: {
      name: "@fixture/lib",
      version: "0.1.0",
      dependencies: { zod: "^4.0.0" },
      devDependencies: { tsup: "9.0.0", "@types/geojson": "^7946.0.0" },
    },
    tool: {
      name: "@fixture/tool",
      version: "0.1.0",
      dependencies: { commander: "^15.0.0" },
      devDependencies: { "@fixture/helper": "workspace:*" },
    },
    helper: {
      name: "@fixture/helper",
      version: "1.0.0",
      private: true,
      dependencies: { undici: "^8.0.0" },
      peerDependencies: { peerlib: "^1.0.0" },
      devDependencies: { peerlib: "1.0.0", vitest: "^5.0.0", "@types/geojson": "^7946.0.0" },
    },
    app: { name: "@fixture/app", version: "1.0.0", private: true, dependencies: { react: "19" } },
  };
  for (const [slug, manifest] of Object.entries(manifests)) {
    write(`packages/${slug}/package.json`, JSON.stringify(manifest));
    write(`packages/${slug}/src/index.ts`, "export const value = 0;\n");
  }
  for (const [path, contents] of Object.entries(files)) write(path, contents);
  execFileSync("git", ["init", "-q"], { cwd });
  return cwd;
}
const check = (files: Record<string, string>, allowlist?: { path: string; reason: string }[]) =>
  declaredImportViolations({ cwd: fixture(files), allowlist });

describe("declared imports in public package sources", () => {
  it("accepts declared, builtin, relative and self references", () => {
    expect(
      check({
        "packages/lib/src/a.ts": [
          'import { z } from "zod";',
          'import { readFile } from "fs/promises";',
          'import { join } from "node:path";',
          'import { value } from "./index.js";',
          'export * from "@fixture/lib/extra";',
          'import type { Feature } from "geojson";',
        ].join("\n"),
        "packages/tool/src/cli.ts":
          'import { Command } from "commander";\nimport "@fixture/helper";',
        "packages/helper/src/a.ts": 'import "undici";\nimport "peerlib";',
      }),
    ).toEqual([]);
  });
  it("rejects a package declared only by the root manifest", () => {
    expect(check({ "packages/tool/src/cli.ts": 'import { parse } from "yaml";' })).toEqual([
      'packages/tool/src/cli.ts:1: "yaml" is not declared in packages/tool/package.json',
    ]);
  });
  it("rejects a package available only through hoisting from another workspace", () => {
    expect(check({ "packages/helper/src/view.tsx": 'import React from "react";' })).toEqual([
      'packages/helper/src/view.tsx:1: "react" is not declared in packages/helper/package.json',
    ]);
  });
  it("rejects a bundled workspace's runtime import of a devDependency that is not a peer", () => {
    const violations = check({
      "packages/helper/src/suite.ts": 'import { expect } from "vitest";',
      "packages/helper/src/types.ts":
        'import type { Mock } from "vitest";\nimport type { Feature } from "geojson";',
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain(
      'packages/helper/src/suite.ts:1: "vitest" is only a devDependency',
    );
  });
  it("accepts a public package's own devDependency", () => {
    expect(check({ "packages/lib/src/a.ts": 'import { defineConfig } from "tsup";' })).toEqual([]);
  });
  it("needs the runtime package for a value import, not only its types", () => {
    expect(check({ "packages/lib/src/a.ts": 'import { feature } from "geojson";' })).toEqual([
      'packages/lib/src/a.ts:1: "geojson" is not declared in packages/lib/package.json',
    ]);
  });
  it.each([
    ['export { parse } from "yaml";', "export-from"],
    ['const yaml = await import("yaml");', "dynamic import"],
    ['const yaml = require("yaml");', "require"],
    ['const path = require.resolve("yaml");', "require.resolve"],
    ['import yaml = require("yaml");', "import-equals"],
    ['type Parse = typeof import("yaml").parse;', "import type node"],
  ])("rejects an undeclared package in %s (%s)", (source) => {
    expect(check({ "packages/lib/src/a.ts": source })).toEqual([
      'packages/lib/src/a.ts:1: "yaml" is not declared in packages/lib/package.json',
    ]);
  });
  it("rejects a non-literal dynamic import unless it is allow-listed", () => {
    const files = {
      "packages/lib/src/load.ts": "export const load = (name: string) => import(name);",
    };
    expect(check(files)).toEqual([
      "packages/lib/src/load.ts:1: non-literal dynamic import or require",
    ]);
    expect(
      check(files, [{ path: "packages/lib/src/load.ts", reason: "loads local files only" }]),
    ).toEqual([]);
  });
  it("skips tests, build configuration, scripts and directories no public package bundles", () => {
    expect(
      check({
        "packages/lib/src/a.test.ts": 'import "yaml";',
        "packages/lib/src/__tests__/helper.ts": 'import "yaml";',
        "packages/lib/tsup.config.ts": 'import "yaml";',
        "packages/lib/scripts/generate.mjs": 'import "yaml";',
        "packages/app/src/a.ts": 'import "yaml";',
      }),
    ).toEqual([]);
  });
  it("rejects a peer that nothing installs in the importing workspace", () => {
    expect(
      check({
        "packages/helper/package.json": JSON.stringify({
          name: "@fixture/helper",
          version: "1.0.0",
          private: true,
          peerDependencies: { peerlib: "^1.0.0", react: ">=19" },
          devDependencies: { peerlib: "1.0.0" },
        }),
        "packages/helper/src/a.ts": 'import "peerlib";\nimport "react";',
      }),
    ).toEqual([
      'packages/helper/src/a.ts:2: "react" is only a peerDependency of packages/helper and nothing installs it there; add the providing version to devDependencies',
    ]);
  });
  it("rejects a relative import that leaves the package", () => {
    expect(check({ "packages/lib/src/a.ts": 'import "../../app/src/index.js";' })).toEqual([
      'packages/lib/src/a.ts:1: "../../app/src/index.js" leaves packages/lib; import workspace packages by name',
    ]);
  });
  it("rejects source that imports excluded tooling", () => {
    expect(check({ "packages/lib/src/a.ts": 'import "../scripts/generate.mjs";' })).toEqual([
      'packages/lib/src/a.ts:1: "../scripts/generate.mjs" imports excluded tooling',
    ]);
  });
});
