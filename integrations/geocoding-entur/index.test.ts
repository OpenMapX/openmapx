import type { Place } from "@openmapx/core";
import {
  createMockIntegrationContext,
  fakeHttpClient,
} from "@openmapx/integration-framework/testing";
import {
  beginPlaceResolverStaging,
  commitPlaceResolverStaging,
  getPlaceResolver,
  rollbackPlaceResolverStaging,
} from "@openmapx/place-ids";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setup } from "./index.js";
import manifest from "./manifest.json";
import { collection } from "./test-support.js";

const CALL = { signal: new AbortController().signal, deadlineAt: Infinity };
function activate(
  config: Record<string, unknown> = {},
  responder = async () => JSON.stringify(collection()),
) {
  const http = fakeHttpClient(responder);
  const ctx = createMockIntegrationContext({
    id: "geocoding-entur",
    manifest: manifest as never,
    config,
    http,
  });
  const shutdown: Array<() => unknown> = [];
  ctx.onShutdown = (fn) => {
    shutdown.push(fn);
  };
  setup(ctx);
  return { ctx, http, shutdown };
}
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Setup tests must use ctx.http");
    }),
  );
});
afterEach(() => {
  rollbackPlaceResolverStaging();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe("actual setup generations", () => {
  it("registers geocoding, suggestions and one primary SDK health probe", async () => {
    const f = activate();
    expect(f.ctx.registered.geocoding).toHaveLength(1);
    expect(f.ctx.registered.searchSuggestions).toHaveLength(1);
    expect(f.ctx.registered.healthChecks).toHaveLength(1);
    expect(await f.ctx.registered.healthChecks[0]()).toMatchObject({ status: "up" });
    const url = new URL(f.http.calls[0].url);
    expect(url.pathname).toBe("/geocoder/v3/place");
    expect(url.searchParams.get("ids")).toBe("NSR:StopPlace:337");
  });
  it("retains A endpoint, country, coverage and receipts after B and failed B", async () => {
    let release!: (body: string) => void;
    const started = Promise.withResolvers<void>();
    const a = activate({ endpoint: "https://a.example/geocoder", boundaryCountry: "no" }, () => {
      started.resolve();
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    const pending = a.ctx.registered.searchSuggestions[0].searchSuggestions(
      { query: "Oslo", lang: "en", limit: 8 },
      CALL,
    );
    await started.promise;
    activate({ endpoint: "https://b.example/geocoder", boundaryCountry: "se" });
    expect(() => activate({ boundaryCountry: "NOR" })).toThrow();
    // Captured manifest receipts survive later catalogue mutation.
    Object.assign(a.ctx, { manifest: { ...a.ctx.manifest, dataSources: [] } });
    release(JSON.stringify(collection()));
    const result = await pending;
    expect(result.suggestions[0].id).toBe("nsr:StopPlace:337");
    expect(result.attributions.map((x) => x.sourceId)).toEqual([
      "entur-geocoder",
      "entur-geocoder-nsr",
    ]);
    expect(a.http.calls[0].url).toContain("https://a.example/geocoder/v3/autocomplete");
    expect(new URL(a.http.calls[0].url).searchParams.get("countries")).toBe("no");
    const skipped = await a.ctx.registered.searchSuggestions[0].searchSuggestions(
      { query: "x", lang: "en", limit: 8, proximity: [13, 52] },
      CALL,
    );
    expect(skipped.suggestions).toEqual([]);
    expect(a.http.calls).toHaveLength(1);
  });
  it("uses existing resolver staging and exact entur/nsr identity with field receipts", async () => {
    const a = activate();
    const resolver = getPlaceResolver<Place>("nsr");
    if (!resolver) throw new Error("Missing NSR resolver");
    beginPlaceResolverStaging();
    activate({ endpoint: "https://b.example/geocoder" });
    rollbackPlaceResolverStaging();
    expect(getPlaceResolver("nsr")).toBe(resolver);
    const nsr = await resolver("StopPlace:337", { lang: "en" });
    const enturResolver = getPlaceResolver<Place>("entur");
    if (!enturResolver) throw new Error("Missing Entur resolver");
    const entur = await enturResolver("NSR:StopPlace:337", { lang: "en" });
    expect(nsr).toEqual(entur);
    expect(nsr?.fieldContributors?.["ids.nsr"]).toEqual(nsr?.contributors);
    expect(nsr?.fieldContributors?.name).toEqual(nsr?.contributors);
    beginPlaceResolverStaging();
    activate();
    commitPlaceResolverStaging();
    expect(getPlaceResolver("nsr")).not.toBe(resolver);
    expect((await resolver("StopPlace:337", {}))?.id).toBe("nsr:StopPlace:337");
    expect(a.http.calls).toHaveLength(3);
  });
  it.each(["shutdown", "caller"] as const)("aborts held transport on %s", async (mode) => {
    const started = Promise.withResolvers<void>();
    let signal: AbortSignal | undefined;
    const http = fakeHttpClient((request) => {
      signal = request.options?.signal;
      started.resolve();
      return new Promise(() => {});
    });
    const ctx = createMockIntegrationContext({
      id: "geocoding-entur",
      manifest: manifest as never,
      http,
    });
    let shutdown!: () => unknown;
    ctx.onShutdown = (fn) => {
      shutdown = fn;
    };
    setup(ctx);
    const caller = new AbortController();
    const pending = ctx.registered.geocoding[0].autocomplete("Oslo", "en", undefined, {
      signal: caller.signal,
    });
    const assertion = expect(pending).rejects.toMatchObject({ name: "ProviderCancelledError" });
    await started.promise;
    if (mode === "shutdown") await shutdown();
    else caller.abort();
    await assertion;
    expect(signal?.aborted).toBe(true);
  });
  it.each(["before-api", "before-data", "after-api", "after-data"] as const)(
    "rejects live %s policy denial",
    async (mode) => {
      let denied = new Set<string>();
      const http = fakeHttpClient(() => {
        if (mode.startsWith("after"))
          denied = new Set([mode.endsWith("api") ? "entur-geocoder" : "entur-geocoder-nsr"]);
        return JSON.stringify(collection());
      });
      const ctx = createMockIntegrationContext({
        id: "geocoding-entur",
        manifest: manifest as never,
        http,
      });
      ctx.getDisallowedSourceIds = async () => denied;
      setup(ctx);
      if (mode.startsWith("before"))
        denied = new Set([mode.endsWith("api") ? "entur-geocoder" : "entur-geocoder-nsr"]);
      await expect(ctx.registered.geocoding[0].geocode("Oslo")).rejects.toThrow();
      if (mode === "before-api") expect(http.calls).toHaveLength(0);
      if (mode === "before-data")
        expect(new URL(http.calls[0].url).searchParams.get("sources")).not.toContain("nsr");
      expect(await ctx.registered.healthChecks[0]()).toMatchObject({ status: "down" });
    },
  );
  it.each(["policy", "body"] as const)(
    "bounds actual setup %s waits and the primary health probe at four seconds",
    async (mode) => {
      vi.useFakeTimers();
      const http = fakeHttpClient(() => new Promise(() => {}));
      const ctx = createMockIntegrationContext({
        id: "geocoding-entur",
        manifest: manifest as never,
        http,
      });
      if (mode === "policy") ctx.getDisallowedSourceIds = () => new Promise(() => {});
      setup(ctx);
      const search = ctx.registered.geocoding[0].autocomplete("Oslo");
      const assertion = expect(search).rejects.toMatchObject({ name: "ProviderTimeoutError" });
      const health = ctx.registered.healthChecks[0]();
      await vi.advanceTimersByTimeAsync(4000);
      await assertion;
      expect(await health).toMatchObject({ status: "down" });
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it.each(["malformed", "wrong-id", "missing"] as const)(
    "reports %s primary health responses down",
    async (mode) => {
      const body =
        mode === "malformed"
          ? "{}"
          : JSON.stringify(
              collection(
                mode === "missing"
                  ? []
                  : [
                      {
                        ...collection().features[0],
                        properties: {
                          ...collection().features[0].properties,
                          id: "NSR:StopPlace:999",
                        },
                      },
                    ],
              ),
            );
      const f = activate({}, async () => body);
      expect(await f.ctx.registered.healthChecks[0]()).toMatchObject({ status: "down" });
      expect(f.http.calls).toHaveLength(1);
    },
  );
  it("clears coverage only for explicit empty country and rejects alpha3", async () => {
    const f = activate({ boundaryCountry: "" });
    await f.ctx.registered.searchSuggestions[0].searchSuggestions(
      { query: "Oslo", lang: "en", limit: 8, proximity: [13, 52] },
      CALL,
    );
    expect(f.http.calls).toHaveLength(1);
    expect(new URL(f.http.calls[0].url).searchParams.has("countries")).toBe(false);
  });
});
