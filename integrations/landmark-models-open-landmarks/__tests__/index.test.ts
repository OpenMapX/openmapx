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

const BASE = "https://open-landmarks.benmaps.fr";

function fixtureHttp(): { http: HttpClient; urls: string[] } {
  const pointer = fixture<{ catalogue: string }>("open-landmarks-pointer.json");
  const catalogue = fixture<{ assets: string }>("open-landmarks-catalogue.json");
  const routes = new Map<string, unknown>([
    [`${BASE}/api/v1/preview.json`, pointer],
    [`${BASE}${pointer.catalogue}`, catalogue],
    [`${BASE}${catalogue.assets}`, fixture("open-landmarks-assets.json")],
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

describe("landmark-models-open-landmarks", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads preview.json and keeps only rights-approved models", async () => {
    const { http, urls } = fixtureHttp();
    const ctx = createMockIntegrationContext({
      id: "landmark-models-open-landmarks",
      http,
      manifest: manifest as unknown as IntegrationContext["manifest"],
    });
    let shutdown: (() => Promise<void>) | undefined;
    ctx.onShutdown = (fn) => {
      shutdown = fn;
    };
    const { setup } = await import("../index");
    await setup(ctx);
    await vi.advanceTimersByTimeAsync(0);
    expect(urls[0]).toBe(`${BASE}/api/v1/preview.json`);
    const provider = ctx.registered.landmarkModels[0];
    expect(provider?.id).toBe("landmark-models-open-landmarks");
    expect(provider?.sourceIds).toEqual(["open-landmarks", "openstreetmap"]);
    const ids = provider?.snapshot()?.assets.map((a) => a.providerAssetId);
    expect(ids?.sort()).toEqual(["arc-de-triomphe", "eiffel-tower"]);
    await shutdown?.();
  });
});
