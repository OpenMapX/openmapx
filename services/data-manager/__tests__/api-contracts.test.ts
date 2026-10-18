import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dataManagerOperations } from "@openmapx/core/data-manager-contracts";
import * as sdk from "@openmapx/core/data-manager-sdk";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { registerApi } from "../src/api.js";
import { registerAuth } from "../src/auth.js";
import type { OfflinePackageGenerator } from "../src/offline-packages/generator.js";

const roots: string[] = [];
const apps: FastifyInstance[] = [];
function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "openmapx-dm-contract-"));
  roots.push(dataDir);
  const app = Fastify();
  apps.push(app);
  return { app, dataDir };
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("data-manager producer contracts", () => {
  it("enforces the declared authentication boundary on every actual operation", async () => {
    const { app, dataDir } = fixture();
    registerAuth(app, "fixture-service-token");
    registerApi(app, {
      dataDir,
      offlinePackages: new Proxy(
        {},
        {
          get: () => {
            throw new Error("Unauthenticated request reached generator");
          },
        },
      ) as OfflinePackageGenerator,
    });
    for (const [index, operation] of Object.values(dataManagerOperations).entries()) {
      const url = operation.path.replace(/:handle/, "0".repeat(64)).replace(/:[^/]+/g, "fixture");
      // Each boundary assertion starts with a fresh failed-auth budget.
      const response = await app.inject({
        method: operation.method,
        url,
        remoteAddress: `192.0.2.${index + 1}`,
      });
      if (operation.auth === "service")
        expect(response.statusCode, `${operation.method} ${url}`).toBe(401);
      else expect(response.statusCode, `${operation.method} ${url}`).not.toBe(401);
    }
  });
  it("rejects a malformed download before starting work", async () => {
    const { app, dataDir } = fixture();
    registerApi(app, { dataDir });
    const response = await app.inject({
      method: "POST",
      url: "/download/osm",
      payload: { region: 12 },
    });
    expect(response.statusCode).toBe(400);
  });

  it("rejects malformed producer readiness without exposing its value", async () => {
    const { app, dataDir } = fixture();
    registerApi(app, {
      dataDir,
      readiness: () => ({ status: "SENTINEL_MUST_NOT_LEAK", phase: "complete" }) as never,
    });
    const response = await app.inject("/status");
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("SENTINEL_MUST_NOT_LEAK");
  });

  it("retains dataset checksum and all real inventory fields", async () => {
    const { app, dataDir } = fixture();
    const dataset = {
      type: "osm-pbf",
      id: "fixture",
      region: "europe/germany",
      path: "/data/fixture.osm.pbf",
      url: "https://fixture.invalid/source.pbf",
      sizeBytes: 123,
      downloadedAt: "2026-10-18T12:00:00.000Z",
      sha256: "a".repeat(64),
      md5: "b".repeat(32),
    };
    writeFileSync(
      join(dataDir, ".data-manager-state.json"),
      JSON.stringify({ datasets: [dataset] }),
    );
    registerApi(app, { dataDir });
    const response = await app.inject("/datasets");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ datasets: [dataset] });
    const transport = sdk.createDataManagerTransport({
      baseUrl: "http://data-manager",
      fetch: async (input, init) => {
        const url = new URL(String(input));
        const actual = await app.inject({
          url: `${url.pathname}${url.search}`,
          headers: Object.fromEntries(new Headers(init?.headers)),
        });
        return new Response(actual.body, {
          status: actual.statusCode,
          headers: actual.headers as Record<string, string>,
        });
      },
    });
    expect(sdk.unwrapDataManagerResponse(await sdk.getDatasets({ transport }))).toEqual({
      datasets: [dataset],
    });
  });

  it("attaches unique named contracts to the actual registered routes", async () => {
    const { app, dataDir } = fixture();
    const routes: Array<{ method: string; id: unknown }> = [];
    app.addHook("onRoute", (route) => {
      if (route.method === "HEAD") return;
      routes.push({
        method: String(route.method),
        id: (route.schema as { operationId?: unknown } | undefined)?.operationId,
      });
    });
    registerApi(app, { dataDir });
    await app.ready();
    expect(routes.length).toBeGreaterThan(30);
    expect(routes.every((route) => typeof route.id === "string")).toBe(true);
    expect(new Set(routes.map((route) => route.id)).size).toBe(routes.length);
  });
});
