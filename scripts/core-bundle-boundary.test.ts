import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { build, type Metafile } from "esbuild";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { analyzeModule } from "./module-specifiers.mjs";

const root = resolve(import.meta.dirname, "..");
const coreDir = join(root, "packages/core");
const coreManifest = JSON.parse(readFileSync(join(coreDir, "package.json"), "utf8")) as {
  exports: Record<string, string | { default: string }>;
};

/** The source file an export key points at, in either `exports` form. */
function exportTarget(key: string): string {
  const target = coreManifest.exports[key];
  const path = typeof target === "string" ? target : target?.default;
  if (path === undefined) throw new Error(`@openmapx/core has no export ${key}`);
  return join(coreDir, path);
}

/** Exports that browser code (web client components, the mobile app, integration UI) imports. */
const BROWSER = [
  ".",
  "./ambient-places",
  "./api-admin-sdk",
  "./api-contracts",
  "./api-sdk",
  "./attribution",
  "./cache-namespaces",
  "./configuration-values",
  "./coverage",
  "./data-manager-contracts",
  "./garage-sdk",
  "./legal",
  "./map-config",
  "./map-link-params",
  "./navigation",
  "./navigation/api",
  "./navigation/laneMatch",
  "./ops/control-root-key",
  "./place-ids",
  "./privacy",
  "./retry-after",
  "./saved-lists",
  "./saved-place-contributors",
  "./saved-place-description",
  "./saved-place-export",
  "./saved-places-sdk",
  "./sharing-sdk",
  "./storage-keys",
  "./theme",
] as const;

/** Exports only server processes, tooling and server components import. */
const SERVER = [
  "./ambient-places-server",
  "./api-schema",
  "./attention",
  "./build-artifacts",
  "./build-artifacts/motis-destination",
  "./build-artifacts/motis-portable",
  "./build-artifacts/publication",
  "./catalog-pins",
  "./catalog-pins/types",
  "./component-id",
  "./coordinates",
  "./data-manager-sdk",
  "./database-session",
  "./deployment-secret-policy",
  "./erasure-journal",
  "./feed-id",
  "./http/fetch-json-error",
  "./http/safe-download",
  "./http/safe-fetch-error",
  "./ids/uuidv7",
  "./item-at",
  "./jobs",
  "./licenses",
  "./mobility-http-transport",
  "./ops",
  "./places/addressEvidence",
  "./places/brandFilter",
  "./places/osmCategoryFilters",
  "./places/overtureCategoryMap",
  "./places/overtureSource",
  "./places/poiConflation",
  "./published-data",
  "./redis-secret",
  "./release-files",
  "./repo-paths",
  "./scrub-secrets",
  "./server",
  "./server-api",
  "./server-env",
  "./service-secret-files",
  "./services/config-env-names",
  "./services/configuration-schema",
  "./services/secret-key",
  "./services/trusted-integration-schemas",
  "./transitous-runner",
  "./types/address",
  "./types/dataSource",
  "./types/identified",
  "./types/place",
  "./types/roadConditions",
  "./undici-fetch",
  "./utils/errors",
  "./utils/geo-server",
] as const;

/** Test helpers. */
const TEST = ["./test/query"] as const;

const FORBIDDEN_IN_BROWSER =
  /(?:safe-download|undici-fetch|gbfs-|motis-|ris-client|\/server(?:\.ts|\/))/;
const FORBIDDEN_IN_MOBILE_NAVIGATION =
  /node_modules\/(?:react|react-dom|zustand|@tanstack\/[^/]+|@mui\/[^/]+|better-auth)\//;

/** Every module an entry imports, statically or dynamically, directly or through other modules. */
function reachable(metafile: Metafile, entry: string): string[] {
  const seen = new Set<string>();
  const pending = [entry];
  for (let path = pending.pop(); path !== undefined; path = pending.pop()) {
    if (seen.has(path)) continue;
    seen.add(path);
    for (const imported of metafile.inputs[path]?.imports ?? []) {
      if (!imported.external) pending.push(imported.path);
    }
  }
  return [...seen];
}

function productionSources(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!/^(?:__tests__|__fixtures__|test-fixtures|test|node_modules)$/.test(entry.name)) {
        files.push(...productionSources(path));
      }
    } else if (
      /\.(?:mts|tsx?)$/.test(entry.name) &&
      !/\.(?:test|spec|d)\.(?:mts|tsx?)$/.test(entry.name)
    ) {
      files.push(path);
    }
  }
  return files;
}

/**
 * Web modules that end up in the browser: every `"use client"` module and
 * every web or integration module those import, the way Next builds its client
 * graph. Imports through other workspace packages are not followed.
 */
function webClientModules(): string[] {
  const webSrc = join(root, "apps/web/src");
  const known = new Set([
    ...productionSources(webSrc),
    ...productionSources(join(root, "integrations")),
  ]);
  const resolveLocal = (from: string, specifier: string): string | undefined => {
    const base = specifier.startsWith("@/")
      ? join(webSrc, specifier.slice(2))
      : specifier.startsWith("@integrations/")
        ? join(root, "integrations", specifier.slice("@integrations/".length))
        : specifier.startsWith(".")
          ? resolve(dirname(from), specifier)
          : undefined;
    if (base === undefined) return undefined;
    return [
      base,
      ...[".ts", ".tsx", ".mts", "/index.ts", "/index.tsx"].map((ext) => base + ext),
    ].find((candidate) => known.has(candidate));
  };
  const pending = [...known].filter(
    (file) => file.startsWith(webSrc) && /^\s*["']use client["']/.test(readFileSync(file, "utf8")),
  );
  const seen = new Set<string>();
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    for (const specifier of analyzeModule(file, readFileSync(file, "utf8")).specifiers) {
      const target = resolveLocal(file, specifier);
      if (target !== undefined) pending.push(target);
    }
  }
  return [...seen];
}

/**
 * Modules whose top-level variable initializers register an overlay store in
 * the shared overlay registry. Lookups by overlay id rely on that registration
 * whether or not anything imports the store binding.
 */
function registersOverlayStore(file: string, text: string): boolean {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  return source.statements.some(
    (statement) =>
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.some(
        (declaration) =>
          declaration.initializer !== undefined &&
          ts.isCallExpression(declaration.initializer) &&
          ts.isIdentifier(declaration.initializer.expression) &&
          declaration.initializer.expression.text === "createOverlayStore",
      ),
  );
}

function declaredSideEffects(packageDir: string): string[] {
  const { sideEffects } = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
    sideEffects?: boolean | string[];
  };
  if (sideEffects === false) return [];
  if (!Array.isArray(sideEffects)) {
    throw new Error(`${relative(root, packageDir)} must declare sideEffects as false or a list`);
  }
  return sideEffects.map((path) => join(packageDir, path));
}

describe("core export classification", () => {
  it("classifies every export as browser, server or test exactly once", () => {
    const classified = [...BROWSER, ...SERVER, ...TEST];
    expect(new Set(classified).size).toBe(classified.length);
    expect([...classified].sort()).toEqual(Object.keys(coreManifest.exports).sort());
  });
});

describe("browser-facing core exports", () => {
  it("bundle for the browser without server-only modules", async () => {
    const entryPoints = Object.fromEntries(BROWSER.map((key) => [key, exportTarget(key)]));
    const result = await build({
      absWorkingDir: root,
      bundle: true,
      entryPoints,
      format: "esm",
      logLevel: "silent",
      metafile: true,
      outdir: "out",
      platform: "browser",
      write: false,
    });
    expect(result.errors).toEqual([]);

    const leaks: Record<string, string[]> = {};
    for (const key of BROWSER) {
      const entry = relative(root, entryPoints[key] ?? "");
      expect(result.metafile.inputs[entry], key).toBeDefined();
      const modules = reachable(result.metafile, entry);
      const forbidden = modules.filter(
        (path) =>
          FORBIDDEN_IN_BROWSER.test(path) ||
          (key.startsWith("./navigation") && FORBIDDEN_IN_MOBILE_NAVIGATION.test(path)),
      );
      if (forbidden.length > 0) leaks[key] = forbidden;
    }
    expect(leaks).toEqual({});
  });

  it("are imported by mobile and web client modules instead of server exports", () => {
    const browser = new Set<string>(BROWSER);
    const violations: string[] = [];
    for (const file of [
      ...productionSources(join(root, "apps/mobile/src")),
      ...webClientModules(),
    ]) {
      for (const specifier of analyzeModule(file, readFileSync(file, "utf8")).specifiers) {
        const match = /^@openmapx\/core(\/.*)?$/.exec(specifier);
        if (match && !browser.has(`.${match[1] ?? ""}`)) {
          violations.push(`${relative(root, file)} imports ${specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("let a bundler drop the rest of core when one function is imported", async () => {
    const result = await build({
      absWorkingDir: root,
      bundle: true,
      format: "esm",
      logLevel: "silent",
      minify: true,
      platform: "browser",
      stdin: {
        contents: `export { formatMeasurementDistance } from "./packages/core/src/index.ts";`,
        resolveDir: root,
        sourcefile: "one-function.ts",
      },
      write: false,
    });
    // Without the package's sideEffects declaration this bundle is the whole
    // barrel, close to a megabyte.
    expect(result.outputFiles[0]?.contents.byteLength).toBeLessThan(4096);
  });
});

describe("module side effects in core and mobility-core", () => {
  for (const pkg of ["packages/core", "packages/mobility-core"]) {
    it(`${pkg} lists every module whose import-time code must run`, () => {
      const packageDir = join(root, pkg);
      const listed = declaredSideEffects(packageDir);
      expect(
        listed.filter((path) => !existsSync(path)).map((path) => relative(root, path)),
      ).toEqual([]);
      // `analyzeModule` reports statements, not calls inside initializers, so
      // registrations through `createOverlayStore(...)` are found separately.
      const unlisted: string[] = [];
      for (const file of productionSources(join(packageDir, "src"))) {
        if (listed.includes(file)) continue;
        const text = readFileSync(file, "utf8");
        const { topLevelStatements } = analyzeModule(file, text);
        if (topLevelStatements.length > 0 || registersOverlayStore(file, text)) {
          unlisted.push(relative(root, file));
        }
      }
      expect(unlisted).toEqual([]);
    });
  }
});
