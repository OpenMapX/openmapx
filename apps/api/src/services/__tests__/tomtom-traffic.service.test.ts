import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function loadService() {
  vi.stubEnv("TOMTOM_TRAFFIC_KEY", "fixture-key");
  return (await import("../tomtom-traffic.service.js")).tomtomTrafficService;
}

describe("TomTom traffic tile acquisition", () => {
  it("combines the caller signal with a deadline and fails redirects closed", async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(new Uint8Array([1]), {
          headers: { "Content-Type": "image/png" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const service = await loadService();
    const caller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout");

    await service.getFlowTile(2, 1, 1, caller.signal);
    const options = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const signal = options.signal as AbortSignal;
    caller.abort(new Error("client disconnected"));

    expect(options.redirect).toBe("error");
    expect(timeout).toHaveBeenCalledWith(15_000);
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(true);
  });

  it.each([
    ["wrong MIME", { "Content-Type": "text/html" }],
    [
      "oversized declared length",
      {
        "Content-Type": "image/png",
        "Content-Length": String(8 * 1024 * 1024 + 1),
      },
    ],
  ])("rejects a successful response with %s", async (_label, headers) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Uint8Array([1]), { headers })),
    );
    const service = await loadService();

    await expect(service.getFlowTile(2, 1, 1)).rejects.toThrow();
  });

  it("rejects a bodyless successful response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { headers: { "Content-Type": "image/png" } })),
    );
    const service = await loadService();

    await expect(service.getFlowTile(2, 1, 1)).rejects.toThrow(/body/i);
  });

  it("aborts the upstream body when streamed bytes exceed 8 MiB", async () => {
    let cancelled = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                controller.enqueue(new Uint8Array(3 * 1024 * 1024));
              },
              cancel() {
                cancelled = true;
              },
            }),
            { headers: { "Content-Type": "image/png" } },
          ),
      ),
    );
    const service = await loadService();
    const tile = await service.getFlowTile(2, 1, 1);

    await expect(
      (async () => {
        for await (const _chunk of tile.body) {
          // Consume through the real limiter.
        }
      })(),
    ).rejects.toThrow(/too large/i);
    await new Promise((resolve) => setImmediate(resolve));

    expect(cancelled).toBe(true);
  });

  it("does not retain or expose a provider-controlled error body", async () => {
    let cancelled = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                controller.enqueue(new TextEncoder().encode("secret provider detail"));
              },
              cancel() {
                cancelled = true;
              },
            }),
            { status: 429, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );
    const service = await loadService();

    const error = await service.getFlowTile(2, 1, 1).catch((caught: unknown) => caught);
    await new Promise((resolve) => setImmediate(resolve));

    expect(error).toMatchObject({ message: "TomTom traffic flow tile error 429", statusCode: 429 });
    expect(String(error)).not.toContain("secret provider detail");
    expect(cancelled).toBe(true);
  });
});
