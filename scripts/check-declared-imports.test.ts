import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { declaredImportViolations } from "./check-declared-imports.mjs";

const workspaces: string[] = [];
afterEach(() => {
  for (const dir of workspaces.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Manifest = Record<string, unknown>;
const baseManifests: Record<string, Manifest> = {
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
    devDependencies: {
      peerlib: "1.0.0",
      vitest: "^5.0.0",
      "@types/geojson": "^7946.0.0",
      "@types/scope__x": "1.0.0",
    },
  },
  app: { name: "@fixture/app", version: "1.0.0", private: true, dependencies: { react: "19" } },
};
const manifest = (slug: string, extra: Manifest) =>
  JSON.stringify({ ...baseManifests[slug], ...extra });
const link = (target: string) => ({ specifier: "workspace:*", version: `link:${target}` });
type Lockfile = {
  lockfileVersion: string;
  importers: Record<string, Record<string, Record<string, unknown>>>;
  packages: Record<string, unknown>;
  snapshots: Record<string, unknown>;
};
/** A minimal pnpm lockfile; JSON is valid YAML. */
function lockfile(change: (model: Lockfile) => void = () => {}) {
  const model: Lockfile = {
    lockfileVersion: "9.0",
    importers: {
      "packages/lib": {},
      "packages/tool": { devDependencies: { "@fixture/helper": link("../helper") } },
      "packages/helper": {},
      "packages/app": {},
    },
    packages: {},
    snapshots: {},
  };
  change(model);
  return JSON.stringify(model);
}
const toolScript = "packages/lib/scripts/index.js";

/**
 * A workspace with a public library, a public tool that bundles a private
 * helper, and an app that is no public package's source. The root declares
 * `yaml`; only the app declares `react`, so it is available to the others
 * only through hoisting. The library's tsup configuration and one listed
 * script are excluded tooling, and both import `yaml`.
 */
function fixture(files: Record<string, string | null> = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "openmapx-declared-imports-"));
  workspaces.push(cwd);
  const write = (path: string, contents: string) => {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), contents);
  };
  const defaults: Record<string, string> = {
    "package.json": JSON.stringify({
      name: "fixture",
      private: true,
      devDependencies: { yaml: "^2.0.0" },
    }),
    "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
    "pnpm-lock.yaml": lockfile(),
    "scripts/public-packages.json": JSON.stringify({
      schemaVersion: 1,
      packages: [
        { name: "@fixture/lib", directory: "packages/lib", bundleWorkspaceDependencies: false },
        { name: "@fixture/tool", directory: "packages/tool", bundleWorkspaceDependencies: true },
      ],
    }),
    "packages/lib/tsup.config.ts": 'import "yaml";\n',
    [toolScript]: 'import "yaml";\n',
  };
  for (const [slug, value] of Object.entries(baseManifests)) {
    defaults[`packages/${slug}/package.json`] = JSON.stringify(value);
    defaults[`packages/${slug}/src/index.ts`] = "export const value = 0;\n";
  }
  for (const [path, contents] of Object.entries({ ...defaults, ...files }))
    if (contents !== null) write(path, contents);
  execFileSync("git", ["init", "-q"], { cwd });
  return cwd;
}
type Options = {
  allowlist?: { path: string; expression: string; reason: string }[];
  tooling?: { path: string; reason: string }[];
};
const check = (files: Record<string, string | null>, options: Options = {}) =>
  declaredImportViolations({
    cwd: fixture(files),
    allowlist: options.allowlist ?? [],
    tooling: options.tooling ?? [{ path: toolScript, reason: "fixture maintenance script" }],
  });

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
        'import type { Mock } from "vitest";\nimport type { Feature } from "geojson";\nexport type { Mock as M } from "vitest";',
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain(
      'packages/helper/src/suite.ts:1: "vitest" is only a devDependency',
    );
  });
  it("accepts a public package's own devDependency", () => {
    expect(check({ "packages/lib/src/a.ts": 'import { defineConfig } from "tsup";' })).toEqual([]);
  });
  it("applies the stricter bundled rule to a public package the CLI also bundles", () => {
    expect(
      check({
        "packages/tool/package.json": manifest("tool", {
          devDependencies: { "@fixture/helper": "workspace:*", "@fixture/lib": "workspace:*" },
        }),
        "packages/lib/src/a.ts": 'import { defineConfig } from "tsup";',
      }),
    ).toEqual([
      'packages/lib/src/a.ts:1: "tsup" is only a devDependency of packages/lib, which a public package bundles; declare it in dependencies, optionalDependencies, or as a peer with that devDependency providing it',
    ]);
  });
  it("checks a workspace package reached only through another bundled workspace", () => {
    expect(
      check({
        "packages/helper/package.json": manifest("helper", {
          dependencies: { undici: "^8.0.0", "@fixture/deep": "workspace:*" },
        }),
        "packages/deep/package.json": JSON.stringify({ name: "@fixture/deep", private: true }),
        "packages/deep/src/index.ts": 'import "yaml";',
      }),
    ).toEqual([
      'packages/deep/src/index.ts:1: "yaml" is not declared in packages/deep/package.json',
    ]);
  });
  it("needs the runtime package for a value import, not only its types", () => {
    expect(check({ "packages/lib/src/a.ts": 'import { feature } from "geojson";' })).toEqual([
      'packages/lib/src/a.ts:1: "geojson" is not declared in packages/lib/package.json',
    ]);
  });
  it("maps a scoped package's types to its DefinitelyTyped name", () => {
    expect(
      check({
        "packages/helper/src/a.ts":
          'import type { A } from "@scope/x";\nimport { b } from "@scope/x";',
      }),
    ).toEqual([
      'packages/helper/src/a.ts:2: "@scope/x" is not declared in packages/helper/package.json',
    ]);
  });
  it.each([
    ['export { parse } from "yaml";', "export-from"],
    ['export type { Document } from "yaml";', "export type from"],
    ['const yaml = await import("yaml");', "dynamic import"],
    ['const yaml = require("yaml");', "require"],
    ['const path = require.resolve("yaml");', "require.resolve"],
    ['import yaml = require("yaml");', "import-equals"],
    ['type Parse = typeof import("yaml").parse;', "import type node"],
    ['declare module "yaml" { export const extra: number; }', "module augmentation"],
  ])("rejects an undeclared package in %s (%s)", (source) => {
    expect(check({ "packages/lib/src/a.ts": source })).toEqual([
      'packages/lib/src/a.ts:1: "yaml" is not declared in packages/lib/package.json',
    ]);
  });
  it("allow-lists a non-literal dynamic import by file and exact expression", () => {
    const files = {
      "packages/lib/src/load.ts":
        "export const load = (name: string) => import(name);\nexport const other = (id: string) => import(id);",
    };
    expect(check(files)).toEqual([
      "packages/lib/src/load.ts:1: non-literal dynamic import or require (name)",
      "packages/lib/src/load.ts:2: non-literal dynamic import or require (id)",
    ]);
    expect(
      check(files, {
        allowlist: [{ path: "packages/lib/src/load.ts", expression: "name", reason: "local only" }],
      }),
    ).toEqual(["packages/lib/src/load.ts:2: non-literal dynamic import or require (id)"]);
  });
  it("skips tests, the public package's build configuration, listed tooling and unbundled directories", () => {
    expect(
      check({
        "packages/lib/src/a.test.ts": 'import "yaml";',
        "packages/lib/src/__tests__/helper.ts": 'import "yaml";',
        "packages/app/src/a.ts": 'import "yaml";',
      }),
    ).toEqual([]);
  });
  it("checks tooling-looking files that are not listed exclusions", () => {
    expect(
      check({
        "packages/helper/tsup.config.ts": 'import "yaml";',
        "packages/lib/scripts/other.mjs": 'import "yaml";',
      }),
    ).toEqual([
      'packages/helper/tsup.config.ts:1: "yaml" is not declared in packages/helper/package.json',
      'packages/lib/scripts/other.mjs:1: "yaml" is not declared in packages/lib/package.json',
    ]);
  });
  it("refuses a symbolic link among checked sources", () => {
    const cwd = fixture({ "packages/other/x.ts": 'import "./y";\n' });
    symlinkSync("../../other/x.ts", join(cwd, "packages/tool/src/x.ts"));
    expect(() =>
      declaredImportViolations({
        cwd,
        allowlist: [],
        tooling: [{ path: toolScript, reason: "fixture maintenance script" }],
      }),
    ).toThrow("packages/tool/src/x.ts: symbolic links are not allowed in checked sources");
  });
  it("rejects a listed exclusion that no longer exists", () => {
    expect(check({ [toolScript]: null })).toEqual([
      `${toolScript}: excluded tooling file does not exist`,
    ]);
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
});

describe("files reachable from checked sources", () => {
  it.each([
    ["./__tests__/fixture", "packages/lib/src/__tests__/fixture.ts"],
    ["./value.test", "packages/lib/src/value.test.ts"],
    ["../tsup.config", "packages/lib/tsup.config.ts"],
    ["../tsup.config.js", "packages/lib/tsup.config.ts"],
    ["../scripts", toolScript],
    ["../scripts/index", toolScript],
  ])("rejects a relative import of skipped code: %s", (specifier, target) => {
    expect(
      check({
        "packages/lib/src/a.ts": `import "${specifier}";`,
        "packages/lib/src/__tests__/fixture.ts": "export {};",
        "packages/lib/src/value.test.ts": "export {};",
      }),
    ).toEqual([
      `packages/lib/src/a.ts:1: "${specifier}" resolves to ${target}, which this check skips`,
    ]);
  });
  it("follows a nested directory manifest's entry point", () => {
    expect(
      check({
        "packages/lib/src/a.ts": 'import "./nested";',
        "packages/lib/src/nested/package.json": '{"main":"./__tests__/entry.js"}',
        "packages/lib/src/nested/__tests__/entry.ts": "export {};",
      }),
    ).toEqual([
      'packages/lib/src/a.ts:1: "./nested" resolves to packages/lib/src/nested/__tests__/entry.ts, which this check skips',
    ]);
  });
  it.each([
    [
      'import "../../app/src/index.js";',
      '"../../app/src/index.js" leaves packages/lib; import workspace packages by name',
    ],
    [
      'import "./node_modules/zod/index.js";',
      '"./node_modules/zod/index.js" reaches into node_modules',
    ],
    ['import "./missing";', '"./missing" does not resolve to a tracked file'],
  ])("rejects %s", (source, message) => {
    expect(check({ "packages/lib/src/a.ts": source })).toEqual([
      `packages/lib/src/a.ts:1: ${message}`,
    ]);
  });
  it.each([
    [
      "a conditional export of a test file",
      { exports: { ".": "./src/index.ts", "./fixture": { import: "./src/__tests__/f.ts" } } },
      'packages/helper/package.json exports: "./src/__tests__/f.ts" resolves to packages/helper/src/__tests__/f.ts, which this check skips',
    ],
    [
      "a pattern export matching test files",
      { exports: { "./internal/*": "./src/__tests__/*.ts" } },
      'packages/helper/package.json exports: "./src/__tests__/*.ts" matches packages/helper/src/__tests__/f.ts, which this check skips',
    ],
    [
      "a main entry pointing at excluded tooling",
      { main: "./tsup.config.ts" },
      'packages/helper/package.json main: "./tsup.config.ts" does not resolve to a tracked file',
    ],
    [
      "a module entry pointing at a test file",
      { module: "src/__tests__/f.ts" },
      'packages/helper/package.json module: "src/__tests__/f.ts" resolves to packages/helper/src/__tests__/f.ts, which this check skips',
    ],
    [
      "an export target outside the package",
      { exports: "./../app/src/index.ts" },
      'packages/helper/package.json exports: "./../app/src/index.ts" leaves packages/helper; import workspace packages by name',
    ],
    [
      "an export target that is not a ./ path",
      { exports: { ".": "src/index.ts" } },
      'packages/helper/package.json exports: "src/index.ts" must start with ./',
    ],
  ])("rejects %s", (_name, entries, message) => {
    expect(
      check({
        "packages/helper/package.json": manifest("helper", entries),
        "packages/helper/src/__tests__/f.ts": "export {};",
      }),
    ).toEqual([message]);
  });
  it("rejects a public package entry point that resolves to its excluded build configuration", () => {
    expect(
      check({ "packages/lib/package.json": manifest("lib", { main: "./tsup.config.ts" }) }),
    ).toEqual([
      'packages/lib/package.json main: "./tsup.config.ts" resolves to packages/lib/tsup.config.ts, which this check skips',
    ]);
  });
});

describe("subpath imports", () => {
  const imports = {
    "#dep": "zod",
    "#internal/*": "./src/internal/*.ts",
    "#env": { node: "yaml", default: "./src/env.ts" },
    "#fixture": "./src/__tests__/f.ts",
    "#parent": "../app/src/index.ts",
  };
  const run = (source: string) =>
    check({
      "packages/lib/package.json": manifest("lib", { imports }),
      "packages/lib/src/internal/x.ts": "export {};",
      "packages/lib/src/env.ts": "export {};",
      "packages/lib/src/__tests__/f.ts": "export {};",
      "packages/lib/src/a.ts": source,
    });
  it("accepts declared package targets and checked local targets", () => {
    expect(run('import "#dep";\nimport "#internal/x";')).toEqual([]);
  });
  it.each([
    [
      'import "#env";',
      'packages/lib/src/a.ts:1: "yaml" is not declared in packages/lib/package.json',
    ],
    [
      'import "#fixture";',
      'packages/lib/src/a.ts:1: "#fixture" (imports target "./src/__tests__/f.ts") resolves to packages/lib/src/__tests__/f.ts, which this check skips',
    ],
    [
      'import "#internal/missing";',
      'packages/lib/src/a.ts:1: "#internal/missing" (imports target "./src/internal/missing.ts") does not resolve to a tracked file',
    ],
    [
      'import "#parent";',
      'packages/lib/src/a.ts:1: "#parent" (imports target "../app/src/index.ts") is not a package or ./ path',
    ],
    [
      'import "#missing";',
      'packages/lib/src/a.ts:1: "#missing" has no imports entry in its manifest',
    ],
  ])("rejects %s", (source, message) => {
    expect(run(source)).toEqual([message]);
  });
});

describe("implicit JSX runtime", () => {
  it("requires the JSX runtime package for a file with JSX", () => {
    expect(check({ "packages/helper/src/view.tsx": "export const View = () => <div />;" })).toEqual(
      ['packages/helper/src/view.tsx:1: "react" is not declared in packages/helper/package.json'],
    );
  });
  it("uses the package a leading @jsxImportSource pragma names", () => {
    expect(
      check({
        "packages/helper/src/view.tsx":
          "/** @jsxImportSource preact */\nexport const View = () => <div />;",
      }),
    ).toEqual([
      'packages/helper/src/view.tsx:2: "preact" is not declared in packages/helper/package.json',
    ]);
  });
  it("accepts JSX with the runtime declared, and a .tsx file without JSX", () => {
    expect(
      check({
        "packages/helper/package.json": manifest("helper", {
          dependencies: { undici: "^8.0.0", react: "19" },
        }),
        "packages/helper/src/view.tsx": "export const View = () => <></>;",
        "packages/lib/src/plain.tsx": "export const value = 1;",
      }),
    ).toEqual([]);
  });
  it("rejects a tsconfig jsxImportSource in a checked directory", () => {
    expect(
      check({
        "packages/helper/tsconfig.json":
          '{ "compilerOptions": { "jsx": "react-jsx", "jsxImportSource": "preact" } }',
      }),
    ).toEqual([
      "packages/helper/tsconfig.json: jsxImportSource is not supported by the declared-imports check",
    ]);
  });
});

describe("dependency tree coverage", () => {
  it("rejects a lockfile link into a workspace package outside the source directories", () => {
    expect(
      check({
        "pnpm-lock.yaml": lockfile((model) => {
          model.importers["packages/helper"] = {
            dependencies: { client: { specifier: "1.0.0", version: "1.0.0" } },
          };
          model.packages["client@1.0.0"] = { resolution: { integrity: "sha512-client" } };
          model.snapshots["client@1.0.0"] = {
            dependencies: { "@fixture/app": "link:packages/app" },
          };
        }),
      }),
    ).toEqual([
      "@fixture/tool: the lockfile links packages/app into its dependency tree, but no manifest in its source directories declares it",
    ]);
  });
  it("rejects a lockfile it cannot resolve", () => {
    const violations = check({ "pnpm-lock.yaml": "importers: [\n" });
    expect(violations).toHaveLength(2);
    expect(violations[0]).toMatch(/^@fixture\/lib: dependency tree cannot be resolved/);
  });
});
