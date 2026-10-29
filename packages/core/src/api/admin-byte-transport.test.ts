/** Canonical bytes stay bytes and remain owned until each sink callback settles. */
import { afterEach, expect, it, vi } from "vitest";
import z from "zod/v4";
import { createAdminOperationBinder } from "./admin-sdk-transport";
import { ApiRequestAbortedError, createApiClient } from "./client";

const download = {
  method: "GET",
  path: "/api/admin/artifact-transfers/fixture/content",
  auth: "admin",
  responses: {
    200: {
      kind: "bytes",
      mediaType: "application/octet-stream",
      headers: z.object({ "content-length": z.string().regex(/^\d+$/) }),
    },
    409: { kind: "json", schema: z.object({ error: z.string() }) },
  },
} as const;
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it("passes non-UTF8 octets unchanged through the configured client", async () => {
  const bytes = new Uint8Array([0, 255, 192, 128]),
    chunks: number[][] = [];
  const fetch = vi.fn().mockResolvedValue(
    new Response(bytes, {
      headers: { "content-type": "application/octet-stream", "content-length": "4" },
    }),
  );
  vi.stubGlobal("fetch", fetch);
  const client = createApiClient({
    baseUrl: "https://api.example",
    credentials: "omit",
    headerInterceptor: () => ({ "x-client": "retained" }),
  });
  const result = await createAdminOperationBinder({ download })("download")(download.path, {
    client,
    onByteChunk: async (chunk) => {
      chunks.push(Array.from(chunk));
    },
  });
  expect(result).toMatchObject({ status: 200, data: undefined });
  expect(chunks).toEqual([[0, 255, 192, 128]]);
  expect(fetch.mock.calls[0]?.[1]).toMatchObject({ credentials: "omit" });
  expect(new Headers(fetch.mock.calls[0]?.[1].headers).get("x-client")).toBe("retained");
});
it("refuses an interceptor's changed byte request media type before fetch", async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json({ ok: true }));
  vi.stubGlobal("fetch", fetch);
  const client = createApiClient({
    baseUrl: "https://api.example",
    headerInterceptor: () => ({ "content-type": "application/json" }),
  });
  await expect(
    client.request(
      "/api/admin/artifact-transfers/fixture/content",
      { method: "PUT", body: new Blob([new Uint8Array([0, 255])]) },
      async (response) => response.status,
      {
        headers: { "content-type": "application/octet-stream" },
        expectedRequestMediaType: "application/octet-stream",
      },
    ),
  ).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});
it("constructs only a same-origin browser-owned native target", () => {
  vi.stubGlobal("window", { location: { origin: "https://app.example" } });
  const client = createApiClient({ baseUrl: "https://app.example", credentials: "include" });
  expect(client.downloadTarget(download.path)).toEqual({
    url: "https://app.example" + download.path,
    ownership: "browser",
  });
  for (const cfg of [
    { baseUrl: "https://other.example", credentials: "include" as const },
    { baseUrl: "https://app.example", credentials: "omit" as const },
    {
      baseUrl: "https://app.example",
      credentials: "include" as const,
      headerInterceptor: () => ({}),
    },
  ])
    expect(() => createApiClient(cfg).downloadTarget(download.path)).toThrow();
  expect(() => client.downloadTarget("//foreign.example/file")).toThrow();
  expect(() => client.downloadTarget(download.path + "#fragment")).toThrow();
});
it.each(["aborted", "timeout"] as const)(
  "awaits active sink cleanup and upstream cancellation after %s",
  async (mode) => {
    vi.useFakeTimers();
    let entered = false,
      cleanupStarted = false,
      cleanupFinished = false,
      canceled = false,
      settled = false;
    let release = () => {};
    const cleanup = new Promise<void>((resolve) => {
      release = resolve;
    });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0, 255]));
      },
      cancel() {
        canceled = true;
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(body, {
          headers: { "content-type": "application/octet-stream", "content-length": "2" },
        }),
      ),
    );
    const owner = new AbortController(),
      client = createApiClient({ baseUrl: "https://api.example" });
    const pending = createAdminOperationBinder({ download })("download")(download.path, {
      client,
      signal: owner.signal,
      ...(mode === "timeout" ? { timeoutMs: 20 } : {}),
      onByteChunk: async (_chunk, signal) => {
        entered = true;
        await new Promise<void>((resolve) =>
          signal.addEventListener(
            "abort",
            () => {
              cleanupStarted = true;
              void cleanup.then(() => {
                cleanupFinished = true;
                resolve();
              });
            },
            { once: true },
          ),
        );
      },
    })
      .catch((error) => error)
      .finally(() => {
        settled = true;
      });
    await vi.advanceTimersByTimeAsync(0);
    expect(entered).toBe(true);
    if (mode === "timeout") await vi.advanceTimersByTimeAsync(21);
    else owner.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(cleanupStarted).toBe(true);
    expect(settled).toBe(false);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(await pending).toBeInstanceOf(ApiRequestAbortedError);
    expect(cleanupFinished).toBe(true);
    expect(canceled).toBe(true);
    expect(body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  },
);
it("rejects ambiguous binary declarations and native POST targets at binding", () => {
  expect(() =>
    createAdminOperationBinder({
      bad: {
        ...download,
        requestBody: { kind: "bytes", mediaType: "application/octet-stream" },
        request: { body: z.object({ value: z.string() }) },
      },
    })("bad"),
  ).toThrow();
  expect(() =>
    createAdminOperationBinder({
      bad: {
        ...download,
        method: "POST",
        responses: { 200: { ...download.responses[200], nativeDownload: true } },
      },
    })("bad"),
  ).toThrow();
});
it("refuses malformed success headers and bounded non-JSON/oversized error responses before callbacks", async () => {
  const consume = vi.fn();
  const client = createApiClient({ baseUrl: "https://api.example" });
  const bound = createAdminOperationBinder({ download })("download");
  for (const response of [
    new Response(new Uint8Array([1]), {
      headers: { "content-type": "application/octet-stream", "content-length": "invalid" },
    }),
    new Response("x".repeat(65537), {
      status: 409,
      headers: { "content-type": "application/json" },
    }),
    new Response("private-error", { status: 409, headers: { "content-type": "text/plain" } }),
  ]) {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    await expect(
      bound(download.path, { client, onByteChunk: consume, maxErrorBytes: 10 * 1024 ** 2 }),
    ).rejects.toThrow();
  }
  expect(consume).not.toHaveBeenCalled();
});
it("keeps invalid-header rejection owned until upstream cancellation finishes", async () => {
  let entered = false,
    settled = false;
  let release = () => {};
  const cleanup = new Promise<void>((resolve) => {
    release = resolve;
  });
  const body = new ReadableStream<Uint8Array>({
    cancel: async () => {
      entered = true;
      await cleanup;
    },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(body, {
        headers: { "content-type": "application/octet-stream", "content-length": "invalid" },
      }),
    ),
  );
  const pending = createAdminOperationBinder({ download })("download")(download.path, {
    client: createApiClient({ baseUrl: "https://api.example" }),
    onByteChunk: () => {},
  })
    .catch((error) => error)
    .finally(() => {
      settled = true;
    });
  await vi.waitFor(() => expect(entered).toBe(true));
  const early = settled;
  release();
  await pending;
  expect(early).toBe(false);
});
it("generated native targets validate UUID params and refuse unsupported headers without fetch", async () => {
  const { getDownloadAdminArtifactTransferContentTarget } = await import(
    "./generated/admin/service-admin.generated"
  );
  vi.stubGlobal("window", { location: { origin: "https://app.example" } });
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const client = createApiClient({ baseUrl: "https://app.example", credentials: "include" });
  const stageId = "91a78b3e-208b-4ba4-9ddf-870fbdf1da22";
  expect(await getDownloadAdminArtifactTransferContentTarget(stageId, { client })).toEqual({
    url: `https://app.example/api/admin/artifact-transfers/${stageId}/content`,
    ownership: "browser",
  });
  await expect(
    getDownloadAdminArtifactTransferContentTarget("invalid", { client }),
  ).rejects.toThrow();
  await expect(
    getDownloadAdminArtifactTransferContentTarget(stageId, {
      client,
      headers: { Authorization: "not-supported" } as never,
    }),
  ).rejects.toMatchObject({ reason: "headers" });
  expect(fetch).not.toHaveBeenCalled();
});
it("caps byte-upload success JSON at 64 KiB even when the caller asks for more", async () => {
  const operation = {
    method: "PUT",
    path: "/api/admin/artifact-transfers/fixture/content",
    auth: "admin",
    requestBody: { kind: "bytes", mediaType: "application/octet-stream" },
    responses: { 200: { kind: "json", schema: z.object({ padding: z.string() }) } },
  } as const;
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ padding: "x".repeat(65537) })));
  await expect(
    createAdminOperationBinder({ upload: operation })("upload")(operation.path, {
      client: createApiClient({ baseUrl: "https://api.example" }),
      method: "PUT",
      body: new Blob([new Uint8Array([0])]),
      maxJsonBytes: 1024 ** 2,
    }),
  ).rejects.toThrow();
});
