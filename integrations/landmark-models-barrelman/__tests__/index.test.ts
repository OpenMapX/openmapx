import type {
  BinaryHttpResponse,
  HttpClient,
  HttpResponse,
  IntegrationContext,
} from "@openmapx/integration-framework";
import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fixture } from "../../../packages/open-landmarks-client/__tests__/fixtures";
import manifest from "../manifest.json";

const BASE = "https://landmarks.barrelman.dev";

function fixtureHttp(): { http: HttpClient; urls: string[] } {
  const pointer = fixture<{ catalogue: string }>("barrelman-pointer.json");
  const catalogue = fixture<{ assets: string }>("barrelman-catalogue.json");
  const routes = new Map<string, unknown>([
    [`${BASE}/api/v1/latest.json`, pointer],
    [`${BASE}${pointer.catalogue}`, catalogue],
    [`${BASE}${catalogue.assets}`, fixture("barrelman-assets.json")],
  ]);
  const urls: string[] = [];
  const http = {
    async getText(url: string): Promise<HttpResponse<string>> {
      urls.push(url);
      const body = routes.get(url);
      return body === undefined
        ? { status: 404, headers: {}, body: "" }
        : { status: 200, headers: {}, body: JSON.stringify(body) };
    },
    async getBytes(): Promise<BinaryHttpResponse> {
      return { status: 404, headers: {}, bytes: new Uint8Array() };
    },
  } as unknown as HttpClient;
  return { http, urls };
}

async function setUp() {
  const { http, urls } = fixtureHttp();
  const ctx = createMockIntegrationContext({
    id: "landmark-models-barrelman",
    http,
    manifest: manifest as unknown as IntegrationContext["manifest"],
  });
  let shutdown: (() => Promise<void>) | undefined;
  ctx.onShutdown = (fn) => {
    shutdown = fn;
  };
  const { setup } = await import("../index");
  await setup(ctx);
  return { ctx, urls, shutdown: () => shutdown?.() };
}

describe("landmark-models-barrelman", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("registers one landmark-models provider with the declared source ids", async () => {
    const { ctx, shutdown } = await setUp();
    expect(ctx.registered.landmarkModels).toHaveLength(1);
    expect(ctx.registered.landmarkModels[0]?.id).toBe("landmark-models-barrelman");
    expect(ctx.registered.landmarkModels[0]?.sourceIds).toEqual([
      "barrelman-landmarks",
      "openstreetmap",
    ]);
    await shutdown();
  });

  it("serves a snapshot after the first load", async () => {
    const { ctx, shutdown } = await setUp();
    await vi.advanceTimersByTimeAsync(0);
    const snapshot = ctx.registered.landmarkModels[0]?.snapshot();
    expect(snapshot?.assets.length).toBeGreaterThan(0);
    expect(snapshot?.assets[0]?.contributors.map((c) => c.sourceId)).toEqual([
      "barrelman-landmarks",
      "openstreetmap",
    ]);
    expect(ctx.registered.healthChecks).toHaveLength(1);
    expect(await ctx.registered.healthChecks[0]?.()).toMatchObject({ status: "up" });
    await shutdown();
  });

  it("stops its timer on shutdown", async () => {
    const { urls, shutdown } = await setUp();
    await vi.advanceTimersByTimeAsync(0);
    await shutdown();
    const before = urls.length;
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(urls.length).toBe(before);
  });
});
