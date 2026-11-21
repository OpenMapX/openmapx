import type { RouteHandler } from "@openmapx/integration-framework";
import { createRecordingReply } from "@openmapx/integration-framework/testing";
import { describe, expect, it } from "vitest";
import { createLandmarkIndexSource, createRoutes } from "../routes";
import type { CellResponse, CoverageResponse } from "../wire";
import { BARRELMAN, contextWith, fakeProvider, OPEN, testAsset } from "./provider-fixtures";

const EIFFEL_CELL = { x: "2074", y: "1409" };

async function call(
  handler: RouteHandler,
  params: Record<string, string> = {},
  query: Record<string, string> = {},
) {
  const { reply, result } = createRecordingReply();
  await handler(
    { query, params, body: undefined, clientKey: "k", headers: {} } as Parameters<RouteHandler>[0],
    reply,
  );
  return result;
}

function routesFor(...args: Parameters<typeof contextWith>) {
  return createRoutes(createLandmarkIndexSource(contextWith(...args)));
}

describe("landmark-models routes", () => {
  it("coverage lists occupied cells and providers with public caching when complete", async () => {
    const routes = routesFor([fakeProvider(BARRELMAN, [testAsset()])]);
    const result = await call(routes.coverage);
    const body = result.body as CoverageResponse;
    expect(result.status).toBe(200);
    expect(body.complete).toBe(true);
    expect(body.cellZoom).toBe(12);
    expect(body.occupied).toEqual(["2074/1409"]);
    expect(body.providers[0]).toMatchObject({ id: BARRELMAN, release: "r1", count: 1 });
    expect(body.licence.name).toBe("ODbL-1.0");
    expect(body.licence.notice).toContain("OpenStreetMap contributors");
    expect(result.headers["cache-control"]).toBe("public, max-age=300");
  });

  it("coverage is no-store and incomplete while a provider is loading", async () => {
    const routes = routesFor([fakeProvider(BARRELMAN, [testAsset()]), fakeProvider(OPEN, null)]);
    const result = await call(routes.coverage);
    expect((result.body as CoverageResponse).complete).toBe(false);
    expect(result.headers["cache-control"]).toBe("no-store");
  });

  it("cell answers with public max-age 86400 when r matches", async () => {
    const routes = routesFor([fakeProvider(BARRELMAN, [testAsset()])]);
    const revision = ((await call(routes.coverage)).body as CoverageResponse).revision;
    const result = await call(routes.cell, EIFFEL_CELL, { r: revision });
    expect(result.status).toBe(200);
    expect((result.body as CellResponse).assets).toHaveLength(1);
    expect(result.headers["cache-control"]).toBe("public, max-age=86400");
  });

  it("mismatched revision serves current data with no-store", async () => {
    const routes = routesFor([fakeProvider(BARRELMAN, [testAsset()])]);
    const result = await call(routes.cell, EIFFEL_CELL, { r: "0000000000000000" });
    const body = result.body as CellResponse;
    expect(result.status).toBe(200);
    expect(body.revision).not.toBe("0000000000000000");
    expect(body.assets).toHaveLength(1);
    expect(result.headers["cache-control"]).toBe("no-store");
  });

  it("rejects non-integer and out-of-range cells with 400 INVALID_CELL and no-store", async () => {
    const routes = routesFor([fakeProvider(BARRELMAN, [testAsset()])]);
    for (const params of [
      { x: "a", y: "1" },
      { x: "1.5", y: "1" },
      { x: "4096", y: "1" },
      { x: "-1", y: "1" },
    ]) {
      const result = await call(routes.cell, params);
      expect(result.status).toBe(400);
      expect(result.body).toMatchObject({ code: "INVALID_CELL" });
      expect(result.headers["cache-control"]).toBe("no-store");
    }
  });

  it("a disabled provider contributes nothing", async () => {
    const routes = routesFor([]);
    const body = (await call(routes.coverage)).body as CoverageResponse;
    expect(body.occupied).toEqual([]);
    expect(body.providers).toEqual([]);
  });

  it("hidden assets from config are absent", async () => {
    const hidden = testAsset();
    const routes = routesFor([fakeProvider(BARRELMAN, [hidden])], {
      config: { hiddenAssets: `${BARRELMAN}:${hidden.providerAssetId}` },
    });
    expect(((await call(routes.coverage)).body as CoverageResponse).occupied).toEqual([]);
  });

  it("assets of a disallowed source are absent", async () => {
    const routes = routesFor([fakeProvider(BARRELMAN, [testAsset()])], { disallowed: ["src"] });
    expect(((await call(routes.coverage)).body as CoverageResponse).occupied).toEqual([]);
  });

  it("reuses the merged index while nothing changed", async () => {
    const provider = fakeProvider(BARRELMAN, [testAsset()]);
    const source = createLandmarkIndexSource(contextWith([provider]));
    const first = await source.current();
    expect(await source.current()).toBe(first);
    provider.current = {
      ...(provider.current as NonNullable<typeof provider.current>),
      release: "r2",
    };
    expect(await source.current()).not.toBe(first);
  });
});
