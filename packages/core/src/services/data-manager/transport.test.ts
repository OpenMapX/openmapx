import { describe, expect, it, vi } from "vitest";
import {
  bindDataManagerOperation,
  createDataManagerTransport,
  DataManagerHttpError,
  unwrapDataManagerResponse,
  validateDataManagerBaseUrl,
} from "./transport";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
describe("canonical data-manager acquisition", () => {
  it("rejects fabricated success rather than inventing defaults", async () => {
    const transport = createDataManagerTransport({
      baseUrl: "http://data-manager",
      fetch: vi.fn().mockResolvedValue(json({})),
    });
    await expect(
      bindDataManagerOperation("reloadDatasets")("/datasets/reload", { transport, method: "POST" }),
    ).rejects.toThrow(/contract/i);
  });
  it("keeps operation identity in its closure even with forged options", async () => {
    const acquire = vi.fn().mockResolvedValue(json({ ok: true }));
    const transport = createDataManagerTransport({
      baseUrl: "http://data-manager",
      fetch: acquire,
    });
    await expect(
      bindDataManagerOperation("reloadDatasets")("/datasets/reload", {
        transport,
        method: "POST",
        contractId: "getLive",
      } as never),
    ).rejects.toThrow(/contract/i);
    expect(acquire.mock.calls[0]?.[1]).not.toHaveProperty("contractId");
  });
  it("preserves declared non-success responses and checked HTTP status policy", async () => {
    const transport = createDataManagerTransport({
      baseUrl: "http://data-manager",
      fetch: vi.fn().mockResolvedValue(json({ ok: false, error: "absent" }, 404)),
    });
    const result = await bindDataManagerOperation("getSearchIndexStatus")<{
      status: 404;
      data: unknown;
      headers: Headers;
    }>("/search-index/status", { transport });
    expect(result.status).toBe(404);
    expect(() => unwrapDataManagerResponse(result)).toThrow(DataManagerHttpError);
    try {
      unwrapDataManagerResponse(result);
    } catch (error) {
      expect((error as DataManagerHttpError).status).toBe(404);
    }
  });
  it("uses bearer auth with redirect rejection and preserves configured budgets", async () => {
    const acquire = vi.fn().mockResolvedValue(json({ datasets: [] }));
    const transport = createDataManagerTransport({
      baseUrl: "http://data-manager",
      authToken: "secret",
      fetch: acquire,
      maxJsonBytes: 4,
    });
    await expect(
      bindDataManagerOperation("getDatasets")("/datasets", { transport }),
    ).rejects.toThrow(/large/);
    expect(acquire.mock.calls[0]?.[1].redirect).toBe("error");
    expect(new Headers(acquire.mock.calls[0]?.[1].headers).get("authorization")).toBe(
      "Bearer secret",
    );
  });
  it("rejects incorrect content types and undeclared statuses without revealing bodies", async () => {
    for (const response of [
      new Response("secret", { headers: { "content-type": "text/html" } }),
      json({ secret: true }, 418),
    ]) {
      const transport = createDataManagerTransport({
        baseUrl: "http://data-manager",
        fetch: vi.fn().mockResolvedValue(response),
      });
      await expect(
        bindDataManagerOperation("getDatasets")("/datasets", { transport }),
      ).rejects.toThrow(/contract/i);
      expect(response.body?.locked).toBe(false);
    }
  });
  it("owns late responses after header timeout and aborts a stalled JSON read", async () => {
    let canceled = false;
    const response = new Response(
      new ReadableStream({
        cancel() {
          canceled = true;
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
    const transport = createDataManagerTransport({
      baseUrl: "http://data-manager",
      requestTimeoutMs: 5,
      fetch: vi.fn().mockResolvedValue(response),
    });
    await expect(
      bindDataManagerOperation("getDatasets")("/datasets", { transport }),
    ).rejects.toThrow(/timeout/i);
    expect(canceled).toBe(true);
    expect(response.body?.locked).toBe(false);
  });
  it("accepts TLS and deliberate plaintext destinations only", () => {
    expect(validateDataManagerBaseUrl("https://example.org")).toBe("https://example.org");
    expect(() => validateDataManagerBaseUrl("http://example.org")).toThrow();
    expect(() => validateDataManagerBaseUrl("https://example.org/path")).toThrow();
    expect(
      validateDataManagerBaseUrl("http://example.org", { allowPlaintextHosts: ["example.org"] }),
    ).toBe("http://example.org");
  });
  it("preserves raw ranges, headers and explicit HEAD without buffering a Blob", async () => {
    const archive = new Response("bytes", {
      status: 206,
      headers: {
        "content-type": "application/vnd.pmtiles",
        "content-range": "bytes 0-4/10",
        etag: `sha256-${"a".repeat(64)}`,
        "accept-ranges": "bytes",
        "content-length": "5",
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
    const acquire = vi
      .fn()
      .mockResolvedValueOnce(archive)
      .mockResolvedValueOnce(
        new Response(null, {
          status: 416,
          headers: {
            "content-range": "bytes */10",
            "accept-ranges": "bytes",
            etag: `sha256-${"a".repeat(64)}`,
          },
        }),
      );
    const transport = createDataManagerTransport({
      baseUrl: "http://data-manager",
      fetch: acquire,
      maxJsonBytes: 1,
    });
    const result = await bindDataManagerOperation("getOfflinePackageArchive")<{
      status: 206;
      headers: Headers;
      data: Response;
    }>("/offline/packages/omp2-id/archive", {
      transport,
      headers: { Range: "bytes=0-4", "If-Range": '"v1"' },
    });
    expect(result.data).toBe(archive);
    expect(result.data.bodyUsed).toBe(false);
    expect(result.headers.get("content-range")).toBe("bytes 0-4/10");
    expect(new Headers(acquire.mock.calls[0]?.[1].headers).get("if-range")).toBe('"v1"');
    const head = await bindDataManagerOperation("headOfflinePackageArchive")<{
      status: 416;
      headers: Headers;
      data: undefined;
    }>("/offline/packages/omp2-id/archive", { transport, method: "HEAD" });
    expect(head.status).toBe(416);
    expect(head.data).toBeUndefined();
    expect(head.headers.get("content-range")).toBe("bytes */10");
    await result.data.body?.cancel();
  });
  it("accepts encoded named glyph segments and rejects destination/method substitution", async () => {
    const acquire = vi.fn().mockResolvedValue(
      new Response("glyph", {
        headers: {
          "content-type": "application/x-protobuf",
          "content-length": "5",
          "cache-control": "public, max-age=31536000, immutable",
        },
      }),
    );
    const transport = createDataManagerTransport({
      baseUrl: "http://data-manager",
      fetch: acquire,
    });
    const request = bindDataManagerOperation("getOfflineGlyph");
    const result = await request<{ data: Response }>(
      "/offline/packages/glyphs/v1/Noto%20Sans%2C%E8%A1%97/0-255.pbf",
      { transport },
    );
    expect(result.data.bodyUsed).toBe(false);
    await result.data.body?.cancel();
    await expect(
      request("https://other.example/offline/packages/glyphs/v1/a/0-255.pbf", { transport }),
    ).rejects.toThrow(/bound operation/);
    await expect(
      request("/offline/packages/glyphs/v1/a/0-255.pbf", { transport, method: "POST" }),
    ).rejects.toThrow(/bound operation/);
  });
  it("keeps public probes and capability downloads independent of service bearer authority", async () => {
    const acquire = vi
      .fn()
      .mockResolvedValueOnce(json({ ok: true }))
      .mockResolvedValueOnce(
        new Response("feed", {
          headers: {
            "content-type": "text/plain",
            "content-length": "4",
            "cache-control": "no-store",
            pragma: "no-cache",
            "referrer-policy": "no-referrer",
          },
        }),
      );
    const transport = createDataManagerTransport({
      baseUrl: "http://data-manager",
      fetch: acquire,
      authToken: "secret",
    });
    await bindDataManagerOperation("getLive")("/live", { transport });
    const feed = await bindDataManagerOperation("getTransitOperatorFeed")<{ data: Response }>(
      "/internal/transit/operator-feed/handle",
      { transport },
    );
    for (const [, init] of acquire.mock.calls)
      expect(new Headers(init.headers).has("authorization")).toBe(false);
    await feed.data.body?.cancel();
  });
  it("honors explicit custom-token authentication without adding bearer auth", async () => {
    const acquire = vi.fn().mockResolvedValue(json({ datasets: [] }));
    const transport = createDataManagerTransport({
      baseUrl: "http://data-manager",
      fetch: acquire,
      authToken: "default",
    });
    await bindDataManagerOperation("getDatasets")("/datasets", {
      transport,
      headers: { "x-data-manager-token": "custom" },
    });
    const headers = new Headers(acquire.mock.calls[0]?.[1].headers);
    expect(headers.get("x-data-manager-token")).toBe("custom");
    expect(headers.has("authorization")).toBe(false);
  });
  it("preserves 202 acceptance, readiness 503 and coverage 409 as declared unions", async () => {
    const acquire = vi
      .fn()
      .mockResolvedValueOnce(json({ jobId: "job", sourceId: "source", status: "started" }, 202))
      .mockResolvedValueOnce(
        json(
          { ok: false, status: "starting", phase: "offline-storage", uptime: 0, dataDir: "/data" },
          503,
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "snapshot_expired" }), {
          status: 409,
          headers: {
            "content-type": "application/json",
            "cache-control": "private, no-store",
            pragma: "no-cache",
          },
        }),
      );
    const transport = createDataManagerTransport({
      baseUrl: "http://data-manager",
      fetch: acquire,
    });
    const accepted = await bindDataManagerOperation("addTransitSource")<{
      status: 202;
      data: { jobId: string };
    }>("/transit/sources", { transport, method: "POST" });
    expect(unwrapDataManagerResponse(accepted).jobId).toBe("job");
    expect(await bindDataManagerOperation("getStatus")("/status", { transport })).toMatchObject({
      status: 503,
      data: { status: "starting" },
    });
    const expired = await bindDataManagerOperation("getCoverageEvidence")<{
      status: 409;
      data: { error: string };
    }>("/coverage/evidence?snapshotId=old", { transport });
    expect(() => unwrapDataManagerResponse(expired)).toThrowError(
      expect.objectContaining({ status: 409 }),
    );
  });
  it("redacts malformed JSON diagnostics and retains ownership of late fetch responses", async () => {
    const malformed = createDataManagerTransport({
      baseUrl: "http://data-manager",
      fetch: vi
        .fn()
        .mockResolvedValue(
          new Response("sensitive credential", { headers: { "content-type": "application/json" } }),
        ),
    });
    await expect(
      bindDataManagerOperation("getDatasets")("/datasets", { transport: malformed }),
    ).rejects.toThrow("invalid JSON");
    let resolve!: (value: Response) => void;
    let canceled = false;
    const transport = createDataManagerTransport({
      baseUrl: "http://data-manager",
      requestTimeoutMs: 5,
      fetch: vi.fn().mockImplementation(
        () =>
          new Promise<Response>((done) => {
            resolve = done;
          }),
      ),
    });
    await expect(
      bindDataManagerOperation("getDatasets")("/datasets", { transport }),
    ).rejects.toThrow(/timeout/i);
    resolve(
      new Response(
        new ReadableStream({
          cancel() {
            canceled = true;
          },
        }),
      ),
    );
    await new Promise((done) => setTimeout(done, 0));
    expect(canceled).toBe(true);
  });
});
