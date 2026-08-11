import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertNoUnlistedFrameworkRouteSources,
  collectIntegrationRoutes,
  ROUTE_METHODS,
} from "../collect-integration-routes.js";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..", "..", "..");

/**
 * Fixture repos are written to a temp directory rather than committed so the
 * synthetic `.ts` files never reach Biome or `tsc`.
 */
function writeFixture(root: string, relativePath: string, contents: string): void {
  const file = join(root, relativePath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, contents);
}

let fixtureRoot: string;

beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), "openmapx-openapi-"));

  writeFixture(fixtureRoot, "integrations/sample/manifest.json", '{ "id": "sample" }');
  writeFixture(
    fixtureRoot,
    "integrations/sample/index.ts",
    `export function setup(ctx: any): void {
       ctx.registerRoute("GET", "/x", async () => {});
       ctx.registerRoute("POST", "/y", async () => {}, { requireAuth: true });
       ctx.registerRoute("get", "nested/:id", async () => {});
     }`,
  );
  writeFixture(
    fixtureRoot,
    "integrations/sample/helper.ts",
    `export function wire(ctx: any): void {
       ctx.registerRoute("DELETE", "/from-helper", async () => {});
     }`,
  );
  writeFixture(
    fixtureRoot,
    "integrations/sample/__tests__/ignored.ts",
    `export function ignored(ctx: any): void {
       ctx.registerRoute("GET", "/must-not-appear", async () => {});
     }`,
  );
  writeFixture(
    fixtureRoot,
    "integrations/sample/thing.test.ts",
    `it("x", () => { ctx.registerRoute("GET", "/also-must-not-appear", async () => {}); });`,
  );

  // Skipped entirely: the scaffold template is not a real integration.
  writeFixture(fixtureRoot, "integrations/_template/manifest.json", '{ "id": "__ID__" }');
  writeFixture(
    fixtureRoot,
    "integrations/_template/index.ts",
    `export function setup(ctx: any): void {
       ctx.registerRoute("GET", "/template-only", async () => {});
     }`,
  );

  // The manifest id, not the directory name, is the URL segment.
  writeFixture(fixtureRoot, "integrations/renamed-dir/manifest.json", '{ "id": "real-id" }');
  writeFixture(
    fixtureRoot,
    "integrations/renamed-dir/index.ts",
    `export function setup(ctx: any): void {
       ctx.registerRoute("GET", "/z", async () => {});
     }`,
  );

  // Routes contributed by a shared framework factory.
  writeFixture(fixtureRoot, "integrations/factory-user/manifest.json", '{ "id": "factory-user" }');
  writeFixture(
    fixtureRoot,
    "integrations/factory-user/index.ts",
    `import { createTidesIntegration } from "@openmapx/integration-framework";
     export function setup(ctx: any): void {
       createTidesIntegration(ctx, {});
     }`,
  );
  writeFixture(fixtureRoot, "integrations/no-factory/manifest.json", '{ "id": "no-factory" }');
  writeFixture(fixtureRoot, "integrations/no-factory/index.ts", "export const nothing = 1;");
  writeFixture(
    fixtureRoot,
    "packages/integration-framework/src/tides-integration-factory.ts",
    `export function createTidesIntegration(ctx: any, _config: unknown): void {
       ctx.registerRoute("GET", "/tides", async () => {});
     }`,
  );
});

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe("collectIntegrationRoutes", () => {
  it("reads literal method, path and requireAuth from registerRoute calls", () => {
    const routes = collectIntegrationRoutes(fixtureRoot).filter(
      (route) => route.integrationId === "sample",
    );

    expect(routes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: "GET", routePath: "/x", requireAuth: false }),
        expect.objectContaining({ method: "POST", routePath: "/y", requireAuth: true }),
      ]),
    );
  });

  it("normalizes a lowercase method and a path missing its leading slash", () => {
    const routes = collectIntegrationRoutes(fixtureRoot);
    expect(routes).toContainEqual(
      expect.objectContaining({
        integrationId: "sample",
        method: "GET",
        routePath: "/nested/:id",
      }),
    );
  });

  it("scans every source file of an integration, not just its entry point", () => {
    const routes = collectIntegrationRoutes(fixtureRoot);
    expect(routes).toContainEqual(
      expect.objectContaining({ integrationId: "sample", routePath: "/from-helper" }),
    );
  });

  it("ignores test files and the scaffold template", () => {
    const paths = collectIntegrationRoutes(fixtureRoot).map((route) => route.routePath);
    expect(paths).not.toContain("/must-not-appear");
    expect(paths).not.toContain("/also-must-not-appear");
    expect(paths).not.toContain("/template-only");
  });

  it("uses the manifest id rather than the directory name", () => {
    const routes = collectIntegrationRoutes(fixtureRoot);
    expect(routes).toContainEqual(expect.objectContaining({ integrationId: "real-id" }));
    expect(routes.map((route) => route.integrationId)).not.toContain("renamed-dir");
  });

  it("attributes shared-factory routes to the integrations that call the factory", () => {
    const routes = collectIntegrationRoutes(fixtureRoot);

    expect(routes).toContainEqual({
      integrationId: "factory-user",
      method: "GET",
      routePath: "/tides",
      requireAuth: false,
      sourceFile: "packages/integration-framework/src/tides-integration-factory.ts",
    });
    expect(routes.filter((route) => route.integrationId === "no-factory")).toHaveLength(0);
  });

  it("records a repo-relative source file for every descriptor", () => {
    for (const route of collectIntegrationRoutes(fixtureRoot)) {
      expect(route.sourceFile.startsWith("/")).toBe(false);
      expect(route.sourceFile).toMatch(/\.ts$/);
    }
  });

  it("throws when a registerRoute call cannot be read statically", () => {
    const badRoot = mkdtempSync(join(tmpdir(), "openmapx-openapi-bad-"));
    writeFixture(badRoot, "integrations/dynamic/manifest.json", '{ "id": "dynamic" }');
    writeFixture(
      badRoot,
      "integrations/dynamic/index.ts",
      `export function setup(ctx: any, path: string): void {
         ctx.registerRoute("GET", path, async () => {});
       }`,
    );

    expect(() => collectIntegrationRoutes(badRoot)).toThrow(/literal method and path/);
    rmSync(badRoot, { recursive: true, force: true });
  });
});

describe("assertNoUnlistedFrameworkRouteSources", () => {
  it("throws when a framework module registers routes without being declared", () => {
    const badRoot = mkdtempSync(join(tmpdir(), "openmapx-openapi-rogue-"));
    writeFixture(
      badRoot,
      "packages/integration-framework/src/rogue-factory.ts",
      `export function createRogueIntegration(ctx: any): void {
         ctx.registerRoute("GET", "/rogue", async () => {});
       }`,
    );

    expect(() => assertNoUnlistedFrameworkRouteSources(badRoot)).toThrow(
      /rogue-factory\.ts registers integration routes but is not listed in SHARED_ROUTE_FACTORIES/,
    );
    rmSync(badRoot, { recursive: true, force: true });
  });

  it("passes against the real tree", () => {
    expect(() => assertNoUnlistedFrameworkRouteSources(REPO_ROOT)).not.toThrow();
  });
});

describe("against the real repository", () => {
  it("finds the integration route surface", () => {
    const routes = collectIntegrationRoutes(REPO_ROOT);
    const integrationIds = new Set(routes.map((route) => route.integrationId));

    // Floor, not an exact count: it guards against the scanner silently
    // breaking without churning every time a route is added. 135 was
    // independently confirmed by running every integration's setup() against a
    // stub context, which found the same number.
    expect(routes.length).toBeGreaterThanOrEqual(135);
    expect(integrationIds.size).toBeGreaterThanOrEqual(37);
    expect(integrationIds.has("geocoding")).toBe(true);
    expect(integrationIds.has("routing")).toBe(true);
  });

  it("gives all four tide integrations their shared /tides route", () => {
    // knowledge-noaa-tides registers its own /tides directly, so filter on the
    // factory as the source rather than on the path.
    const fromFactory = collectIntegrationRoutes(REPO_ROOT).filter((route) =>
      route.sourceFile.endsWith("tides-integration-factory.ts"),
    );

    expect(fromFactory.map((route) => route.integrationId).sort()).toEqual([
      "knowledge-tides-canada",
      "knowledge-tides-ioc",
      "knowledge-tides-norway",
      "knowledge-tides-pegelonline",
    ]);
    expect(fromFactory.every((route) => route.routePath === "/tides")).toBe(true);
  });

  it("only emits supported HTTP methods", () => {
    for (const route of collectIntegrationRoutes(REPO_ROOT)) {
      expect(ROUTE_METHODS).toContain(route.method);
    }
  });

  it("reads requireAuth off the options argument", () => {
    const authed = collectIntegrationRoutes(REPO_ROOT).filter((route) => route.requireAuth);
    expect(authed.length).toBeGreaterThan(0);
  });
});
