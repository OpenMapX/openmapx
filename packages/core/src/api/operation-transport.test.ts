/** The one request binder behind every generated operation family. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import z from "zod/v4";
import { ApiClientError, ApiRequestAbortedError, createApiClient } from "./client";
import { adminEmpty, adminJson, adminStream, adminText } from "./contracts/admin";
import {
  createOperationBinder,
  operationErrorMessage,
  unwrapOperationResponse,
} from "./operation-transport";
import { ApiContractError } from "./sdk-transport";

const client = createApiClient({ baseUrl: "https://app.example", credentials: "include" });
beforeEach(() =>
  vi.stubGlobal("fetch", () => {
    throw new Error("Unexpected network");
  }),
);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const bind = () =>
  createOperationBinder({
    state: {
      method: "GET",
      path: "/api/fixture/state",
      auth: "admin",
      responses: {
        200: adminJson(z.strictObject({ state: z.string() })),
        404: adminJson(z.strictObject({ error: z.string() })),
      },
    },
    sync: {
      method: "POST",
      path: "/api/fixture/sync",
      auth: "admin",
      responses: {
        200: adminJson(z.strictObject({ jobId: z.string() })),
        409: adminJson(
          z.strictObject({ ok: z.literal(false), reason: z.string(), existingJobId: z.string() }),
        ),
      },
    },
    update: {
      method: "PUT",
      path: "/api/fixture/:id",
      auth: "admin",
      request: { headers: z.object({ "x-revision": z.string() }) },
      responses: { 200: adminText(z.string(), "application/yaml"), 204: adminEmpty() },
    },
    patch: {
      method: "PATCH",
      path: "/api/fixture/:id",
      auth: "admin",
      responses: { 204: adminEmpty() },
    },
    unavailable: {
      method: "POST",
      path: "/api/fixture/down",
      auth: "admin",
      responses: { 503: adminJson(z.strictObject({ error: z.string() })) },
    },
    logs: {
      method: "GET",
      path: "/api/fixture/logs",
      auth: "session",
      responses: { 200: adminStream("text/plain") },
    },
  });
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

describe("JSON acquisition", () => {
  it("rejects malformed successes through the operation closure despite forged validator/status options", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetch);
    await expect(
      bind()("state")("/api/fixture/state", {
        client,
        operationId: "sync",
        schema: { safeParse: () => ({ success: true, data: {} }) },
        declaredStatuses: [200],
        acceptedStatuses: [200],
      } as never),
    ).rejects.toBeInstanceOf(ApiContractError);
    expect(fetch.mock.calls[0]?.[1]).not.toHaveProperty("operationId");
    expect(fetch.mock.calls[0]?.[1]).not.toHaveProperty("schema");
  });
  it("preserves declared conflict and absence states, cookies and client scope", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ error: "absent" }, { status: 404 }))
      .mockResolvedValueOnce(
        Response.json(
          { error: "Another data job is running.", code: "in-flight", existingJobId: "job" },
          { status: 409 },
        ),
      );
    vi.stubGlobal("fetch", fetch);
    const absent = await bind()("state")<{
      status: 404;
      headers: Headers;
      data: { error: string };
    }>("/api/fixture/state", { client });
    expect(absent.status).toBe(404);
    expect(fetch.mock.calls[0]?.[0]).toBe("https://app.example/api/fixture/state");
    expect(fetch.mock.calls[0]?.[1].credentials).toBe("include");
    const conflict = await bind()("sync")<{
      status: 409;
      headers: Headers;
      data: unknown;
    }>("/api/fixture/sync", { client, method: "POST", body: "{}" });
    expect(conflict.status).toBe(409);
    expect(() => unwrapOperationResponse(conflict)).toThrow(ApiClientError);
  });
  it.each([
    Response.json({ secret: "never-log" }, { status: 409 }),
    new Response("never-log", { headers: { "content-type": "text/html" } }),
    Response.json({ jobId: "job" }, { status: 201 }),
  ])(
    "rejects malformed errors, wrong media and undeclared success without leaking bodies",
    async (response) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
      const error = await bind()("sync")("/api/fixture/sync", { client, method: "POST" }).catch(
        (error) => error,
      );
      expect(error).toBeInstanceOf(ApiContractError);
      expect(String(error)).not.toContain("never-log");
      expect(JSON.stringify(error)).not.toContain("never-log");
    },
  );
  it("bounds declared error and success bodies and releases their readers", async () => {
    for (const status of [200, 404]) {
      let canceled = false;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"error":"too large"}'));
        },
        cancel() {
          canceled = true;
        },
      });
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue(
            new Response(body, { status, headers: { "content-type": "application/json" } }),
          ),
      );
      await expect(
        bind()("state")("/api/fixture/state", { client, maxJsonBytes: 4, maxErrorBytes: 4 }),
      ).rejects.toBeInstanceOf(ApiContractError);
      expect(canceled).toBe(true);
      expect(body.locked).toBe(false);
    }
  });
  it("returns safe structured HTTP errors and exposes messages only by deliberate display helper", () => {
    const response = {
      status: 429 as const,
      headers: new Headers({ "retry-after": "30" }),
      data: { error: "wait", retryAfter: 30 },
    };
    let failure: unknown;
    try {
      unwrapOperationResponse(response);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ status: 429, retryAfterSeconds: 30 });
    expect(JSON.stringify(failure)).not.toContain('"wait"');
    expect(operationErrorMessage(failure, "fallback")).toBe("wait");
    expect(operationErrorMessage(new Error("private detail"), "fallback")).toBe("fallback");
  });
  it.each(["timeout", "aborted"] as const)(
    "keeps %s active through actual SDK bounded body consumption",
    async (mode) => {
      vi.useFakeTimers();
      let canceled = false;
      const body = new ReadableStream<Uint8Array>({
        cancel() {
          canceled = true;
        },
      });
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue(
            new Response(body, { headers: { "content-type": "application/json" } }),
          ),
      );
      const observer = new AbortController();
      const outcome = bind()("state")("/api/fixture/state", {
        client,
        signal: observer.signal,
        ...(mode === "timeout" ? { timeoutMs: 10 } : {}),
      }).catch((error) => error);
      await vi.advanceTimersByTimeAsync(0);
      if (mode === "timeout") await vi.advanceTimersByTimeAsync(11);
      else observer.abort();
      expect(await outcome).toMatchObject({ name: "ApiRequestAbortedError", code: mode });
      expect(canceled).toBe(true);
      expect(body.locked).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it("rejects operation URL substitution and non-finite budgets before acquisition", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(bind()("state")("/api/fixture/other", { client })).rejects.toThrow(
      /bound operation/,
    );
    await expect(
      bind()("state")("/api/fixture/state", { client, maxJsonBytes: Number.POSITIVE_INFINITY }),
    ).rejects.toThrow(/limits/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects unexpected error statuses without exposing an unvalidated display payload", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(Response.json({ error: "private upstream details" }, { status: 418 })),
    );
    const error = await bind()("state")("/api/fixture/state", { client }).catch((error) => error);
    expect(error).toBeInstanceOf(ApiContractError);
    expect(operationErrorMessage(error, "fallback")).toBe("fallback");
    expect(JSON.stringify(error)).not.toContain("private upstream");
  });
  it("rejects an undeclared status without waiting for its untrusted body", async () => {
    vi.useFakeTimers();
    let canceled = false;
    let close = () => {};
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        close = () => controller.close();
      },
      cancel() {
        canceled = true;
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(body, {
          status: 418,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const outcome = bind()("state")("/api/fixture/state", { client, timeoutMs: 10 }).catch(
      (error) => error,
    );
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(canceled).toBe(true);
      expect(body.locked).toBe(false);
      expect(await outcome).toBeInstanceOf(ApiContractError);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      if (!canceled) close();
      await outcome;
    }
  });
  it("allows an all-error operation without widening success or reading unknown outcomes", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(Response.json({ error: "guidance" }, { status: 503 }))
        .mockResolvedValueOnce(Response.json({})),
    );
    const operation = bind()("unavailable");
    await expect(operation("/api/fixture/down", { client, method: "POST" })).resolves.toMatchObject(
      { status: 503, data: { error: "guidance" } },
    );
    await expect(operation("/api/fixture/down", { client, method: "POST" })).rejects.toBeInstanceOf(
      ApiContractError,
    );
  });
});

describe("text and bodyless outcomes", () => {
  it("supports PUT/PATCH, required headers, finite text and explicit bodyless outcomes", async () => {
    const acquire = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://app.example/api/fixture/a%2Fb");
      expect(init.method).toMatch(/^(PUT|PATCH)$/);
      if (init.method === "PUT") {
        expect(new Headers(init.headers).get("x-revision")).toBe("v1");
        return new Response("name: test\n", { headers: { "content-type": "application/yaml" } });
      }
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", acquire);
    const binding = bind();
    await expect(
      binding("update")("/api/fixture/a%2Fb", {
        client,
        method: "PUT",
        headers: { "x-revision": "v1" },
      }),
    ).resolves.toMatchObject({ status: 200, data: "name: test\n" });
    await expect(
      binding("patch")("/api/fixture/a%2Fb", { client, method: "PATCH" }),
    ).resolves.toMatchObject({ status: 204, data: undefined });
    await expect(
      binding("update")("/api/fixture/a%2Fb", { client, method: "PUT" }),
    ).rejects.toThrow(/contract/);
    expect(acquire).toHaveBeenCalledTimes(2);
  });
  it("rejects malformed media, bounded text and bodyful empty outcomes with redacted errors", async () => {
    for (const response of [
      new Response("secret", { headers: { "content-type": "text/html" } }),
      new Response("secret too long", { headers: { "content-type": "application/yaml" } }),
      new Response("secret", { status: 201 }),
    ]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
      const error = await bind()("update")("/api/fixture/a", {
        client,
        method: "PUT",
        headers: { "x-revision": "v1" },
        maxTextBytes: 3,
      }).catch((error) => error);
      expect(error).toBeInstanceOf(ApiContractError);
      expect(String(error)).not.toContain("secret");
    }
  });
});

describe("incremental text streams", () => {
  it("keeps UTF8 streaming callbacks under caller cancellation and releases readers", async () => {
    const bytes = new TextEncoder().encode("ä");
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes.slice(0, 1));
        c.enqueue(bytes.slice(1));
      },
      cancel() {
        canceled = true;
      },
    });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response(stream, { headers: { "content-type": "text/plain" } })),
    );
    const abort = new AbortController();
    const chunks: string[] = [];
    const outcome = bind()("logs")("/api/fixture/logs", {
      client,
      signal: abort.signal,
      onTextChunk(chunk) {
        chunks.push(chunk);
        abort.abort();
      },
    }).catch((e) => e);
    expect(await outcome).toMatchObject({ code: "aborted" });
    expect(chunks).toEqual(["ä"]);
    expect(canceled).toBe(true);
    expect(stream.locked).toBe(false);
  });
  it("owns a callback rejection even when that callback aborts synchronously", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("line"));
      },
    });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response(stream, { headers: { "content-type": "text/plain" } })),
    );
    const abort = new AbortController();
    await expect(
      bind()("logs")("/api/fixture/logs", {
        client,
        signal: abort.signal,
        onTextChunk() {
          abort.abort();
          return Promise.reject(new Error("callback private detail"));
        },
      }),
    ).rejects.toMatchObject({ code: "aborted" });
    // An unowned promise rejection fails Vitest's enclosing run.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stream.locked).toBe(false);
  });
  it("keeps a pending stream callback within the deadline and clears its reader and timer", async () => {
    vi.useFakeTimers();
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("line"));
      },
      cancel() {
        canceled = true;
      },
    });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response(stream, { headers: { "content-type": "text/plain" } })),
    );
    const outcome = bind()("logs")("/api/fixture/logs", {
      client,
      timeoutMs: 10,
      onTextChunk: () => new Promise(() => {}),
    }).catch((error) => error);
    await vi.advanceTimersByTimeAsync(11);
    expect(await outcome).toMatchObject({ code: "timeout" });
    expect(canceled).toBe(true);
    expect(stream.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["throw", "reject", "hang-then-reject"])(
    "cancels/unlocks for %s without unhandled rejection or leaked timer",
    async (mode) => {
      vi.useFakeTimers();
      let canceled = 0;
      let entered!: () => void;
      let rejectCallback!: (reason: Error) => void;
      const entering = new Promise<void>((r) => {
        entered = r;
      });
      const body = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode("chunk"));
        },
        cancel() {
          canceled++;
        },
      });
      vi.stubGlobal(
        "fetch",
        async () => new Response(body, { headers: { "content-type": "text/plain" } }),
      );
      const caller = new AbortController();
      const result = bind()("logs")("/api/fixture/logs", {
        client,
        signal: caller.signal,
        timeoutMs: 60_000,
        onTextChunk: () => {
          entered();
          if (mode === "throw") throw new Error("synthetic-callback");
          if (mode === "reject") return Promise.reject(new Error("synthetic-callback"));
          return new Promise<void>((_resolve, reject) => {
            rejectCallback = reject;
          });
        },
      });
      const rejected = expect(result).rejects.toThrow();
      await entering;
      if (mode === "hang-then-reject") caller.abort();
      await rejected;
      if (mode === "hang-then-reject") rejectCallback(new Error("late-callback"));
      await vi.advanceTimersByTimeAsync(0);
      expect(canceled).toBe(1);
      expect(body.locked).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it("returns undefined success data after transport UTF8 EOF flush", async () => {
    const body = new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array([0xe2]));
        c.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      async () => new Response(body, { headers: { "content-type": "text/plain" } }),
    );
    const chunks: string[] = [];
    const result = await bind()("logs")<{ status: number; data: unknown }>("/api/fixture/logs", {
      client,
      onTextChunk: (chunk) => {
        chunks.push(chunk);
      },
    });
    expect(result.status).toBe(200);
    expect(result.data).toBeUndefined();
    expect(chunks).toEqual(["�"]);
    expect(body.locked).toBe(false);
  });
  it("passes a nested request abort through instead of reporting a contract violation", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("line"));
      },
    });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response(stream, { headers: { "content-type": "text/plain" } })),
    );
    const error = await bind()("logs")("/api/fixture/logs", {
      client,
      onTextChunk: () => {
        throw new ApiRequestAbortedError("timeout");
      },
    }).catch((caught) => caught);
    expect(error).toBeInstanceOf(ApiRequestAbortedError);
    expect(error).toMatchObject({ code: "timeout" });
    expect(stream.locked).toBe(false);
  });
});

describe("byte responses and uploads", () => {
  it("passes non-UTF8 octets unchanged through the configured client", async () => {
    const bytes = new Uint8Array([0, 255, 192, 128]),
      chunks: number[][] = [];
    const fetch = vi.fn().mockResolvedValue(
      new Response(bytes, {
        headers: { "content-type": "application/octet-stream", "content-length": "4" },
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const scoped = createApiClient({
      baseUrl: "https://api.example",
      credentials: "omit",
      headerInterceptor: () => ({ "x-client": "retained" }),
    });
    const result = await createOperationBinder({ download })("download")(download.path, {
      client: scoped,
      onByteChunk: async (chunk) => {
        chunks.push(Array.from(chunk));
      },
    });
    expect(result).toMatchObject({ status: 200, data: undefined });
    expect(chunks).toEqual([[0, 255, 192, 128]]);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ credentials: "omit" });
    expect(new Headers(fetch.mock.calls[0]?.[1].headers).get("x-client")).toBe("retained");
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
        scoped = createApiClient({ baseUrl: "https://api.example" });
      const pending = createOperationBinder({ download })("download")(download.path, {
        client: scoped,
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
      createOperationBinder({
        bad: {
          ...download,
          requestBody: { kind: "bytes", mediaType: "application/octet-stream" },
          request: { body: z.object({ value: z.string() }) },
        },
      })("bad"),
    ).toThrow();
    expect(() =>
      createOperationBinder({
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
    const scoped = createApiClient({ baseUrl: "https://api.example" });
    const bound = createOperationBinder({ download })("download");
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
        bound(download.path, {
          client: scoped,
          onByteChunk: consume,
          maxErrorBytes: 10 * 1024 ** 2,
        }),
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
    const pending = createOperationBinder({ download })("download")(download.path, {
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
  it("caps byte-upload success JSON at 64 KiB even when the caller asks for more", async () => {
    const operation = {
      method: "PUT",
      path: "/api/admin/artifact-transfers/fixture/content",
      auth: "admin",
      requestBody: { kind: "bytes", mediaType: "application/octet-stream" },
      responses: { 200: { kind: "json", schema: z.object({ padding: z.string() }) } },
    } as const;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ padding: "x".repeat(65537) })),
    );
    await expect(
      createOperationBinder({ upload: operation })("upload")(operation.path, {
        client: createApiClient({ baseUrl: "https://api.example" }),
        method: "PUT",
        body: new Blob([new Uint8Array([0])]),
        maxJsonBytes: 1024 ** 2,
      }),
    ).rejects.toThrow();
  });
});

describe("session text downloads", () => {
  const savedClient = createApiClient({ baseUrl: "https://saved.example", credentials: "include" });
  it("consumes a declared session download as a Blob within the request lifetime", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("<gpx>café</gpx>", {
          headers: {
            "content-type": "application/gpx+xml; charset=utf-8",
            "content-disposition": "attachment; filename=trip.gpx",
          },
        }),
      ),
    );
    const binding = createOperationBinder({
      download: {
        method: "GET",
        path: "/api/saved/lists/:id/export",
        auth: "session",
        responses: {
          200: {
            kind: "text-download",
            mediaTypes: ["application/gpx+xml"],
            headers: z.object({ "content-disposition": z.string().startsWith("attachment;") }),
          },
        },
      },
    });
    const response = await binding("download")<{ data: Blob }>("/api/saved/lists/list/export", {
      client: savedClient,
    });
    expect(response.data).toBeInstanceOf(Blob);
    expect(await response.data.text()).toBe("<gpx>café</gpx>");
  });
  it("rejects a different declared download format than the one requested", async () => {
    const { exportSavedList } = await import("./saved-sdk");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("<kml/>", {
          headers: {
            "content-type": "application/vnd.google-earth.kml+xml",
            "content-disposition": "attachment; filename=trip.kml",
          },
        }),
      ),
    );
    await expect(
      exportSavedList("list", { format: "gpx" }, { client: savedClient }),
    ).rejects.toThrow("contract");
  });
  it.each(["wrong-media", "missing-attachment", "oversized", "stalled"] as const)(
    "rejects %s downloads and releases the response body",
    async (scenario) => {
      const { exportSavedList } = await import("./saved-sdk");
      let canceled = false;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          if (scenario !== "stalled") controller.enqueue(new TextEncoder().encode("<gpx/>"));
        },
        cancel() {
          canceled = true;
        },
      });
      const headers = new Headers({
        "content-type": scenario === "wrong-media" ? "text/html" : "application/gpx+xml",
      });
      if (scenario !== "missing-attachment")
        headers.set("content-disposition", "attachment; filename=trip.gpx");
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { headers })));
      await expect(
        exportSavedList(
          "list",
          { format: "gpx" },
          {
            client: savedClient,
            maxDownloadBytes: scenario === "oversized" ? 2 : 100,
            timeoutMs: 20,
          },
        ),
      ).rejects.toThrow();
      expect(canceled).toBe(true);
      expect(body.locked).toBe(false);
    },
  );
  it("honors caller cancellation during a pending download body", async () => {
    const { exportSavedList } = await import("./saved-sdk");
    const abort = new AbortController();
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        canceled = true;
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(body, {
          headers: {
            "content-type": "application/gpx+xml",
            "content-disposition": "attachment; filename=trip.gpx",
          },
        }),
      ),
    );
    const pending = exportSavedList(
      "list",
      { format: "gpx" },
      { client: savedClient, signal: abort.signal },
    );
    try {
      await vi.waitFor(() => expect(body.locked).toBe(true));
      abort.abort();
      await expect(pending).rejects.toThrow("aborted");
      expect(canceled).toBe(true);
      expect(body.locked).toBe(false);
    } finally {
      abort.abort();
      await pending.catch(() => {});
    }
  });
  it("cannot publish a completed download after cancellation wins at the consumption boundary", async () => {
    const { exportSavedList } = await import("./saved-sdk");
    const abort = new AbortController();
    const response = new Response("<gpx/>", {
      headers: {
        "content-type": "application/gpx+xml",
        "content-disposition": "attachment; filename=trip.gpx",
      },
    });
    const readHeader = response.headers.get.bind(response.headers);
    let mediaReads = 0;
    vi.spyOn(response.headers, "get").mockImplementation((name) => {
      if (name === "content-type" && ++mediaReads === 2) abort.abort();
      return readHeader(name);
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    await expect(
      exportSavedList("list", { format: "gpx" }, { client: savedClient, signal: abort.signal }),
    ).rejects.toThrow("aborted");
    expect(mediaReads).toBe(2);
  });
});
