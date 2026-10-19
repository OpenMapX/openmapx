import { createNoopLogger } from "@openmapx/integration-framework/testing";
import { HealthCheckDocument } from "@openmapx/mobility-formats/entur/journey-planner.generated.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createEnturClient,
  createEnturGeocoder,
} from "../../../../packages/entur-client/src/index";
import { createHttpClient } from "../integration-clients";

function client() {
  return createEnturClient({
    http: createHttpClient(createNoopLogger()),
    config: {},
    sourceIds: { vehicles: "vehicles", nsr: "nsr" },
    contributors: {},
    isSourceAllowed: async () => true,
  });
}
const signal = () => new AbortController().signal;
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Entur adapter through real host HTTP transport", () => {
  it("posts the raw GraphQL JSON body and rejects redirects", async () => {
    let wire: RequestInit | undefined;
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      wire = init;
      return new Response('{"data":{"stopPlace":null}}', {
        headers: { "Content-Type": "application/json; charset=UTF-8" },
      });
    });
    await expect(
      client().graphQl("vehicles", HealthCheckDocument, { id: "NSR:StopPlace:1" }, signal()),
    ).resolves.toEqual({ stopPlace: null });
    expect(wire?.redirect).toBe("error");
    expect(wire?.method).toBe("POST");
    expect(new Headers(wire?.headers).get("ET-Client-Name")).toBe("openmapx-server");
    expect(JSON.parse(wire?.body as string)).toEqual({
      query: HealthCheckDocument.toString(),
      variables: { id: "NSR:StopPlace:1" },
    });
    expect(wire?.signal).toBeInstanceOf(AbortSignal);
  });
  it("inspects non-JSON 429 before envelope decoding and retains observed cooldown", async () => {
    let requests = 0;
    vi.stubGlobal("fetch", async () => {
      requests++;
      return new Response("<h1>private-secret</h1>", {
        status: 429,
        headers: { "Content-Type": "text/html", "Retry-After": "10" },
      });
    });
    const instance = client();
    await expect(
      instance.getJson("nsr", "/stop-places/NSR:StopPlace:1", signal()),
    ).rejects.toMatchObject({ kind: "http", status: 429 });
    await expect(
      instance.getJson("nsr", "/stop-places/NSR:StopPlace:1", signal()),
    ).rejects.toMatchObject({ kind: "cooldown" });
    expect(requests).toBe(1);
  });
  it.each(["text/html", "application/xml", undefined])(
    "rejects success Content-Type %s rather than guessing JSON",
    async (media) => {
      vi.stubGlobal(
        "fetch",
        async () =>
          new Response(new TextEncoder().encode('{"features":[]}'), {
            headers: media ? { "Content-Type": media } : {},
          }),
      );
      await expect(client().getJson("nsr", "/x", signal())).rejects.toMatchObject({
        kind: "unavailable",
      });
    },
  );
  it("accepts GraphQL response JSON media", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response('{"data":{"stopPlace":null}}', {
          headers: { "Content-Type": "application/graphql-response+json" },
        }),
    );
    await expect(
      client().graphQl("vehicles", HealthCheckDocument, { id: "x" }, signal()),
    ).resolves.toEqual({ stopPlace: null });
  });
  it.each([true, false])(
    "enforces eight MiB before/while body consumption (declared=%s)",
    async (declared) => {
      let cancelled = false;
      vi.stubGlobal(
        "fetch",
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1));
              },
              cancel() {
                cancelled = true;
              },
            }),
            {
              headers: {
                "Content-Type": "application/json",
                ...(declared ? { "Content-Length": "8388609" } : {}),
              },
            },
          ),
      );
      await expect(client().getJson("nsr", "/x", signal())).rejects.toMatchObject({
        kind: "unavailable",
      });
      expect(cancelled).toBe(true);
    },
  );
  it("aborts a stalled body at the overall deadline and cancels its stream", async () => {
    vi.useFakeTimers();
    let cancelled = false;
    let wireSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      wireSignal = init?.signal ?? undefined;
      return new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    });
    const work = client().getJson("nsr", "/x", signal());
    const assertion = expect(work).rejects.toMatchObject({ kind: "timeout" });
    await vi.advanceTimersByTimeAsync(8000);
    await assertion;
    expect(wireSignal?.aborted).toBe(true);
    expect(cancelled).toBe(true);
  });
  it("caller cancellation aborts a stalled body without publishing", async () => {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let cancelled = false;
    vi.stubGlobal("fetch", async () => {
      entered();
      return new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    });
    const controller = new AbortController();
    const work = client().getJson("nsr", "/x", controller.signal);
    const assertion = expect(work).rejects.toMatchObject({ kind: "abort" });
    await started;
    controller.abort();
    await assertion;
    await Promise.resolve();
    expect(cancelled).toBe(true);
  });
  it.each([201, 204, 400, 429])(
    "preserves actual HTTP %s through the Entur geocoder host bridge",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          () =>
            new Response(status === 204 ? null : status === 400 ? '{"detail":"invalid"}' : "text", {
              status,
              headers: status === 400 ? { "Content-Type": "application/problem+json" } : {},
            }),
        ),
      );
      const client = createEnturClient({
        http: createHttpClient(createNoopLogger()),
        config: { geocoderEndpoint: "https://api.entur.io/geocoder" },
        sourceIds: { geocoder: "entur-geocoder" },
        contributors: {},
        isSourceAllowed: async () => true,
      });
      await expect(
        createEnturGeocoder(client).autocomplete({ q: "Oslo" }, new AbortController().signal),
      ).rejects.toMatchObject({ kind: "http", status });
    },
  );
});
