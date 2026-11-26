import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const sdkDirectory = join(import.meta.dirname, "../..");
const sourceDirectory = join(sdkDirectory, "src");
const pkg = JSON.parse(readFileSync(join(sdkDirectory, "package.json"), "utf8")) as {
  exports: Record<string, unknown>;
  publishConfig: { exports: Record<string, unknown> };
  dependencies: Record<string, string>;
};

const entryFiles = readdirSync(sourceDirectory)
  .filter((file) => file.endsWith(".ts"))
  .map((file) => ({ file, text: readFileSync(join(sourceDirectory, file), "utf8") }));

const ENTRY_POINTS = [
  ".",
  "./air-quality",
  "./attribution",
  "./data-source",
  "./errors",
  "./geo",
  "./geocoding",
  "./hazards",
  "./http",
  "./knowledge",
  "./media",
  "./package.json",
  "./places",
  "./poi",
  "./query",
  "./reviews",
  "./rides",
  "./road",
  "./routing",
  "./sites",
  "./strings",
  "./testing",
  "./tiles",
  "./transit",
  "./weather",
];

describe("integration SDK surface", () => {
  it("re-exports host instances, never copies", async () => {
    const sdk = await import("@openmapx/integration-sdk/errors");
    const host = await import("@openmapx/integration-framework");
    expect(sdk.ProviderTimeoutError).toBe(host.ProviderTimeoutError);
    expect(sdk.ProviderDeclinedError).toBeTypeOf("function");
    expect(sdk.ProviderDeclinedError).toBe(host.ProviderDeclinedError);
    expect((await import("@openmapx/integration-sdk/places")).registerPlaceResolver).toBe(
      (await import("@openmapx/place-ids")).registerPlaceResolver,
    );
    const http = await import("@openmapx/integration-sdk/http");
    const server = await import("@openmapx/core/server");
    for (const name of ["safeFetchJson", "safeFetchText", "safeFetchTextResponse"] as const) {
      expect(http[name], name).toBeTypeOf("function");
      expect(http[name], name).toBe(server[name]);
    }
  });

  it("has exactly the reviewed entry points", () => {
    expect(Object.keys(pkg.exports).sort()).toEqual(ENTRY_POINTS);
    expect(Object.keys(pkg.publishConfig.exports).sort()).toEqual(ENTRY_POINTS);
  });

  it("has one source file for every entry point", () => {
    const fromExports = ENTRY_POINTS.filter((key) => key !== "./package.json").map((key) =>
      key === "." ? "index.ts" : `${key.slice(2)}.ts`,
    );
    expect(entryFiles.map(({ file }) => file).sort()).toEqual(fromExports.sort());
  });

  it("keeps host internals out", async () => {
    const root = await import("@openmapx/integration-sdk");
    for (const name of [
      "IntegrationRegistry",
      "IntegrationEventBus",
      "createActivationTransactionScope",
      "createSiteOrchestrator",
      "validateDataSource",
    ])
      expect(name in root).toBe(false);
  });

  it("uses named re-exports only", () => {
    const starred = entryFiles
      .filter(({ file, text }) => file !== "testing.ts" && /^export \* from/m.test(text))
      .map(({ file }) => file);
    expect(starred).toEqual([]);
  });

  it("imports no AGPL integration package", () => {
    const offending = entryFiles
      .filter(({ text }) =>
        [...text.matchAll(/@openmapx\/integration-[a-z-]+/g)].some(
          ([specifier]) => specifier !== "@openmapx/integration-framework",
        ),
      )
      .map(({ file }) => file);
    expect(offending).toEqual([]);
  });

  it("lists every exported type in the file the external consumer check imports them from", () => {
    const listed = JSON.parse(
      readFileSync(join(sdkDirectory, "scripts/surface-types.json"), "utf8"),
    ) as Record<string, string[]>;
    const exported: Record<string, string[]> = {};
    for (const { file, text } of entryFiles) {
      if (file === "testing.ts") continue;
      const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest);
      const names: string[] = [];
      for (const statement of source.statements) {
        if (!ts.isExportDeclaration(statement) || !statement.exportClause) continue;
        if (!ts.isNamedExports(statement.exportClause)) continue;
        for (const element of statement.exportClause.elements) {
          if (statement.isTypeOnly || element.isTypeOnly) names.push(element.name.text);
        }
      }
      if (names.length > 0) {
        exported[file === "index.ts" ? "." : `./${file.slice(0, -".ts".length)}`] = names.sort();
      }
    }
    const { "./testing": testingTypes, ...rest } = listed;
    expect(rest).toEqual(exported);
    expect(testingTypes).toEqual(
      expect.arrayContaining(["FakeHttpClient", "FakeHttpRequest", "MockContextOverrides"]),
    );
  });

  it("keeps zod and the contracts package as dependencies an author installs", () => {
    expect(pkg.dependencies).toHaveProperty("zod");
    expect(pkg.dependencies).toHaveProperty("@openmapx/extension-contracts");
  });

  it("exports the values the OpenConditions adapters import", async () => {
    const expected = {
      "@openmapx/integration-sdk/http": ["captureCacheWriter", "DEFAULT_FETCH_JSON_MAX_BYTES"],
      "@openmapx/integration-sdk/road": ["ROAD_CONDITION_SEVERITY_LABELS"],
      "@openmapx/integration-sdk/geo": ["isValidWgs84Bounds"],
      "@openmapx/integration-sdk/media": ["matchesMediaHost", "parseMediaHostEntry"],
      "@openmapx/integration-sdk/attribution": [
        "dataSourceToAttribution",
        "contributorsForRecords",
        "parseContributors",
        "snapshotContributors",
        "readCapturedContributors",
        "readCapturedFieldContributors",
        "licensingFromDeclaration",
        "parseLicensing",
        "canonicalLicenseExpression",
        "formatLicensing",
        "isSafeAttributionUrl",
        "licensingLinks",
        "buildAttributionPresentation",
      ],
      "@openmapx/integration-sdk/testing": [
        "createMockIntegrationContext",
        "fakeHttpClient",
        "nth",
        "routeRequest",
        "httpStatus",
      ],
    };
    for (const [specifier, names] of Object.entries(expected)) {
      const entry = await import(specifier);
      for (const name of names) expect(name in entry, `${specifier} ${name}`).toBe(true);
    }
  });
});
