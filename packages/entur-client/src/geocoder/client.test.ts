import type { HttpClient, ResponseOptions } from "@openmapx/integration-framework";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { createEnturClient } from "../client";
import { createEnturGeocoder, type EnturGeocoder, type EnturGeocoderPolicy } from "./client";
import { autocomplete as rawAutocomplete } from "./generated/client";
import { enturGeocoderRequest } from "./transport";

const signal = () => new AbortController().signal;
const body = () => ({
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      geometry: { type: "Point", coordinates: [10.7322, 59.914994] },
      properties: {
        id: "NSR:StopPlace:58404",
        names: { default: "Nationaltheatret", display: "Nationaltheatret, Oslo" },
        layer: "stopPlace",
        source: "nsr",
        stopPlaceRole: "parent",
      },
    },
  ],
  metadata: {
    query: { text: "Nationaltheatret", limit: 2, lang: "en" },
    resultCount: 1,
    timestamp: "2026-10-19T09:50:00Z",
  },
});
function fixture() {
  const calls: { url: string; options: ResponseOptions }[] = [];
  let value: unknown = body();
  let status = 200;
  let acquire = async () => undefined;
  const client = createEnturClient({
    http: {
      getText: async (url: string, options: ResponseOptions) => {
        calls.push({ url, options });
        await acquire();
        return {
          status,
          headers: {},
          body: typeof value === "string" ? value : JSON.stringify(value),
        };
      },
    } as HttpClient,
    config: { geocoderEndpoint: "https://api.entur.io/geocoder" },
    sourceIds: { geocoder: "entur-geocoder" },
    contributors: {},
    isSourceAllowed: async () => true,
  });
  return {
    client,
    calls,
    setBody: (input: unknown) => {
      value = input;
    },
    setStatus: (input: number) => {
      status = input;
    },
    setAcquire: (input: typeof acquire) => {
      acquire = input;
    },
  };
}
afterEach(() => vi.useRealTimers());
describe("bounded generated Entur Geocoder", () => {
  it("binds all operation paths to the host and validates real-shape bodies", async () => {
    const f = fixture();
    const sdk = createEnturGeocoder(f.client);
    expect(
      (await sdk.autocomplete({ q: "Oslo S", layers: ["address", "stopPlace"] }, signal()))
        .features[0]?.properties.id,
    ).toBe("NSR:StopPlace:58404");
    await sdk.reverse({ lat: 0, lon: 0, distanceSort: false }, signal());
    await sdk.place({ ids: ["NSR:StopPlace:1", "NSR:StopPlace:2"] }, signal());
    expect(f.calls.map((call) => call.url)).toEqual([
      "https://api.entur.io/geocoder/v3/autocomplete?q=Oslo+S&layers=address%2CstopPlace",
      "https://api.entur.io/geocoder/v3/reverse?lat=0&lon=0&distanceSort=false",
      "https://api.entur.io/geocoder/v3/place?ids=NSR%3AStopPlace%3A1%2CNSR%3AStopPlace%3A2",
    ]);
    expect(f.calls[0]?.options).toMatchObject({
      redirect: "error",
      maxBytes: 8388608,
      headers: { "ET-Client-Name": "openmapx-server" },
    });
  });
  it("preserves no-focus omission and complete zero focus without injecting defaults", async () => {
    const f = fixture();
    const sdk = createEnturGeocoder(f.client);
    await sdk.autocomplete({ q: "Oslo", lang: undefined }, signal());
    await sdk.autocomplete({ q: "Oslo", lat: 0, lon: 0, radius: 0, weight: 0 }, signal());
    expect(f.calls.map((call) => call.url)).toEqual([
      "https://api.entur.io/geocoder/v3/autocomplete?q=Oslo",
      "https://api.entur.io/geocoder/v3/autocomplete?q=Oslo&lat=0&lon=0&radius=0&weight=0",
    ]);
  });
  it.each([
    {},
    { q: " " },
    { layers: [] },
    { q: "Oslo", text: "legacy" },
    { q: "Oslo", ids: ["x"] },
    { q: "Oslo", lat: 0 },
    { q: "Oslo", lon: 0 },
    { q: "Oslo", radius: 25 },
    { q: "Oslo", weight: 0 },
    { q: "Oslo", limit: 101 },
    { q: "Oslo", bbox: "20,1,10,2" },
    { q: "Oslo", sources: ["unknown"] },
  ])("rejects invalid autocomplete before acquisition: %j", async (params) => {
    const f = fixture();
    await expect(
      createEnturGeocoder(f.client).autocomplete(params as never, signal()),
    ).rejects.toMatchObject({ kind: "config" });
    expect(f.calls).toHaveLength(0);
  });
  it("accepts meaningful filter-only autocomplete", async () => {
    const f = fixture();
    await createEnturGeocoder(f.client).autocomplete({ layers: ["stopPlace"] }, signal());
    expect(f.calls[0]?.url).toContain("layers=stopPlace");
  });
  it.each([
    { ids: [] },
    { ids: [""] },
    { ids: [" "] },
    { ids: Array(101).fill("x") },
    { ids: ["x"], q: "Oslo" },
  ])("rejects invalid lookup before acquisition: %j", async (params) => {
    const f = fixture();
    await expect(
      createEnturGeocoder(f.client).place(params as never, signal()),
    ).rejects.toMatchObject({ kind: "config" });
    expect(f.calls).toHaveLength(0);
  });
  it.each([
    { label: "two IDs in one element", ids: ["NSR:StopPlace:1,NSR:StopPlace:2"] },
    {
      label: "delimiter in a later element",
      ids: ["NSR:StopPlace:1", "NSR:StopPlace:2,NSR:StopPlace:3"],
    },
    {
      label: "101 wire IDs in one element",
      ids: [Array.from({ length: 101 }, (_, index) => `NSR:StopPlace:${index + 1}`).join(",")],
    },
  ])("rejects comma-bearing place IDs before policy and HTTP: $label", async ({ ids }) => {
    const f = fixture();
    const policyChecks: string[] = [];
    const policy: EnturGeocoderPolicy = {
      allowedSources: async () => {
        policyChecks.push("sources");
        return ["nsr"];
      },
      assertLookupAllowed: async () => {
        policyChecks.push("lookup");
      },
    };
    await expect(
      createEnturGeocoder(f.client, { policy }).place({ ids }, signal()),
    ).rejects.toMatchObject({ kind: "config" });
    expect(policyChecks).toEqual([]);
    expect(f.calls).toHaveLength(0);
  });
  it.each([{ lat: 0 }, { lat: 91, lon: 0 }, { lat: 0, lon: 0, q: "Oslo" }])(
    "rejects invalid reverse before acquisition: %j",
    async (params) => {
      const f = fixture();
      await expect(
        createEnturGeocoder(f.client).reverse(params as never, signal()),
      ).rejects.toMatchObject({ kind: "config" });
      expect(f.calls).toHaveLength(0);
    },
  );
  it.each(["autocomplete", "reverse", "place"] as const)(
    "validates the generated response binding for %s",
    async (operation) => {
      const f = fixture();
      f.setBody({ features: [] });
      const sdk = createEnturGeocoder(f.client);
      const result =
        operation === "autocomplete"
          ? sdk.autocomplete({ q: "x" }, signal())
          : operation === "reverse"
            ? sdk.reverse({ lat: 0, lon: 0 }, signal())
            : sdk.place({ ids: ["x"] }, signal());
      await expect(result).rejects.toMatchObject({ kind: "response" });
    },
  );
  it("strips additions and normalizes only unknown string stop roles", async () => {
    const f = fixture();
    const value = body();
    Object.assign(value, { future: true });
    value.features[0].properties.stopPlaceRole = "future-role";
    f.setBody(value);
    const result = await createEnturGeocoder(f.client).autocomplete({ q: "x" }, signal());
    expect(result).not.toHaveProperty("future");
    expect(result.features[0]?.properties).not.toHaveProperty("stopPlaceRole");
  });
  it.each(["names", "source", "role", "coordinates"])(
    "rejects response contract drift in %s",
    async (field) => {
      const f = fixture();
      const value = body();
      if (field === "names") delete (value.features[0].properties as { names?: unknown }).names;
      if (field === "source") value.features[0].properties.source = "unknown";
      if (field === "role") Object.assign(value.features[0].properties, { stopPlaceRole: 42 });
      if (field === "coordinates") value.features[0].geometry.coordinates = [200, 100];
      f.setBody(value);
      await expect(
        createEnturGeocoder(f.client).autocomplete({ q: "x" }, signal()),
      ).rejects.toMatchObject({ kind: "response" });
    },
  );
  it.each([201, 204, 400, 429])("preserves status-first HTTP %s errors", async (status) => {
    const f = fixture();
    f.setStatus(status);
    f.setBody(status === 400 ? '{"detail":"private problem"}' : "not JSON");
    await expect(
      createEnturGeocoder(f.client).autocomplete({ q: "x" }, signal()),
    ).rejects.toMatchObject({ kind: "http", status });
  });
  it("intersects filters before HTTP and refuses denied returned suppliers", async () => {
    const f = fixture();
    const policy: EnturGeocoderPolicy = {
      allowedSources: async () => ["nsr"],
      assertLookupAllowed: async () => undefined,
    };
    const sdk = createEnturGeocoder(f.client, { policy });
    await sdk.autocomplete({ q: "x", sources: ["nsr", "openstreetmap"] }, signal());
    await sdk.reverse({ lat: 0, lon: 0 }, signal());
    expect(f.calls.map((call) => call.url)).toEqual([
      "https://api.entur.io/geocoder/v3/autocomplete?q=x&sources=nsr",
      "https://api.entur.io/geocoder/v3/reverse?lat=0&lon=0&sources=nsr",
    ]);
    await expect(
      sdk.autocomplete({ q: "x", sources: ["openstreetmap"] }, signal()),
    ).rejects.toMatchObject({ kind: "policy" });
    expect(f.calls).toHaveLength(2);
    const value = body();
    value.features[0].properties.source = "openstreetmap";
    f.setBody(value);
    await expect(sdk.reverse({ lat: 0, lon: 0 }, signal())).rejects.toMatchObject({
      kind: "policy",
    });
  });
  it("checks exact lookup ids and supplier policy again before publication", async () => {
    const f = fixture();
    let allowed = true;
    const ids: unknown[] = [];
    const policy: EnturGeocoderPolicy = {
      allowedSources: async () => (allowed ? ["nsr"] : ["openstreetmap"]),
      assertLookupAllowed: async (value, sources, operationSignal) => {
        ids.push({ value: [...value], sources: [...sources], aborted: operationSignal.aborted });
      },
    };
    f.setAcquire(async () => {
      allowed = false;
    });
    await expect(
      createEnturGeocoder(f.client, { policy }).place({ ids: ["NSR:StopPlace:58404"] }, signal()),
    ).rejects.toMatchObject({ kind: "policy" });
    expect(ids[0]).toEqual({ value: ["NSR:StopPlace:58404"], sources: ["nsr"], aborted: false });
  });
  it.each(["policy", "lookup", "http", "publication"])(
    "owns a typed timeout around hung %s",
    async (stage) => {
      vi.useFakeTimers();
      const f = fixture();
      const hung = () => new Promise<never>(() => {});
      let checks = 0;
      if (stage === "http") f.setAcquire(hung);
      const policy: EnturGeocoderPolicy = {
        allowedSources: async () => {
          checks++;
          if (stage === "policy" || (stage === "publication" && checks > 1)) return hung();
          return ["nsr"];
        },
        assertLookupAllowed: stage === "lookup" ? hung : async () => undefined,
      };
      const promise = createEnturGeocoder(f.client, { timeoutMs: 40, policy }).place(
        { ids: ["x"] },
        signal(),
      );
      const assertion = expect(promise).rejects.toMatchObject({ kind: "timeout" });
      await Promise.all([assertion, vi.advanceTimersByTimeAsync(40)]);
    },
  );
  it("gives caller abort precedence over the operation deadline", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.setAcquire(() => new Promise(() => {}));
    const caller = new AbortController();
    const promise = createEnturGeocoder(f.client, { timeoutMs: 40 }).autocomplete(
      { q: "x" },
      caller.signal,
    );
    const assertion = expect(promise).rejects.toMatchObject({ kind: "abort" });
    caller.abort();
    await Promise.all([assertion, vi.advanceTimersByTimeAsync(40)]);
  });
  it.each([0, -1, 8001, 1.5, Infinity, null])(
    "rejects unbounded timeout construction %s",
    (timeoutMs) => {
      const f = fixture();
      expect(() => createEnturGeocoder(f.client, { timeoutMs: timeoutMs as number })).toThrow();
    },
  );
  it("cannot bypass injected client/signal requirements via generated operations", async () => {
    const f = fixture();
    expect(() => createEnturGeocoder(undefined as never)).toThrow();
    await expect(
      createEnturGeocoder(f.client).autocomplete({ q: "x" }, undefined as never),
    ).rejects.toMatchObject({ kind: "config" });
    await expect(rawAutocomplete({ q: "x" })).rejects.toMatchObject({ kind: "config" });
    await expect(
      enturGeocoderRequest("/v3/autocomplete?q=x", {
        client: f.client,
        signal: signal(),
        method: "POST",
      }),
    ).rejects.toMatchObject({ kind: "config" });
    expect(f.calls).toHaveLength(0);
  });
  it("rejects total supplier revocation even when transport returned no records", async () => {
    const f = fixture();
    f.setBody({ ...body(), features: [] });
    let checks = 0;
    const policy: EnturGeocoderPolicy = {
      allowedSources: async () => (++checks === 1 ? ["nsr"] : []),
      assertLookupAllowed: async () => undefined,
    };
    await expect(
      createEnturGeocoder(f.client, { policy }).autocomplete({ q: "x" }, signal()),
    ).rejects.toMatchObject({ kind: "policy" });
  });
  it("restricts acquisition with a duplicated supplier policy set", async () => {
    const f = fixture();
    const policy: EnturGeocoderPolicy = {
      allowedSources: async () => ["nsr", "nsr", "nsr", "nsr", "nsr"],
      assertLookupAllowed: async () => undefined,
    };
    await createEnturGeocoder(f.client, { policy }).autocomplete({ q: "x" }, signal());
    expect(f.calls[0]?.url).toBe("https://api.entur.io/geocoder/v3/autocomplete?q=x&sources=nsr");
  });
  it("does not let policy wait mutate the captured request parameters", async () => {
    const f = fixture();
    const params = { q: "original", layers: ["stopPlace" as const] };
    const policy: EnturGeocoderPolicy = {
      allowedSources: async () => {
        params.q = "changed";
        params.layers.splice(0);
        return ["nsr"];
      },
      assertLookupAllowed: async () => undefined,
    };
    await createEnturGeocoder(f.client, { policy }).autocomplete(params, signal());
    expect(f.calls[0]?.url).toBe(
      "https://api.entur.io/geocoder/v3/autocomplete?q=original&layers=stopPlace&sources=nsr",
    );
  });
  it("bounds hung lookup revalidation before publication", async () => {
    vi.useFakeTimers();
    const f = fixture();
    let checks = 0;
    const policy: EnturGeocoderPolicy = {
      allowedSources: async () => ["nsr"],
      assertLookupAllowed: async () => {
        if (++checks > 1) await new Promise(() => {});
      },
    };
    const assertion = expect(
      createEnturGeocoder(f.client, { timeoutMs: 40, policy }).place({ ids: ["x"] }, signal()),
    ).rejects.toMatchObject({ kind: "timeout" });
    await Promise.all([assertion, vi.advanceTimersByTimeAsync(40)]);
  });
  it("uses the eight-second construction default and aborts its host signal", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.setAcquire(() => new Promise(() => {}));
    const assertion = expect(
      createEnturGeocoder(f.client).autocomplete({ q: "x" }, signal()),
    ).rejects.toMatchObject({ kind: "timeout" });
    await vi.advanceTimersByTimeAsync(7999);
    expect(f.calls[0]?.options.signal?.aborted).toBe(false);
    await Promise.all([assertion, vi.advanceTimersByTimeAsync(1)]);
    expect(f.calls[0]?.options.signal?.aborted).toBe(true);
  });
  it("requires caller signals and exposes no raw operation authority in its types", () => {
    expectTypeOf<Parameters<typeof createEnturGeocoder>[1]>().toEqualTypeOf<
      { timeoutMs?: number; policy?: EnturGeocoderPolicy } | undefined
    >();
    const compileContract = (sdk: EnturGeocoder) => {
      // @ts-expect-error Callers cannot omit the lifetime owner.
      void sdk.autocomplete({ q: "x" });
      // @ts-expect-error RequestInit cannot replace the caller signal.
      void sdk.reverse({ lat: 0, lon: 0 }, { headers: { Authorization: "x" } });
      // @ts-expect-error No public method, URL, client or schema override options.
      void sdk.place({ ids: ["x"] }, signal(), { method: "POST", url: "https://other.test" });
      // @ts-expect-error Factory options cannot inject HTTP authority.
      void createEnturGeocoder(fixture().client, { headers: { Authorization: "x" } });
    };
    void compileContract;
  });
});
