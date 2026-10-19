import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import z from "zod/v4";
import {
  bindAdminOperation,
  bindAdminStreamOperation,
  createAdminOperationBinder,
} from "./admin-sdk-transport";
import { createApiClient } from "./client";
import { adminEmpty, adminJson, adminStream, adminText } from "./contracts/admin";
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
  createAdminOperationBinder({
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
      auth: "admin",
      responses: { 200: adminStream("text/plain") },
    },
  });
describe("family-neutral administration operation binding", () => {
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
  it("builds a typed SSE target from the exact generated path without fetching or JSON parsing", async () => {
    const path = "/api/admin/jobs/a%2Fb/events?source=application&cursor=2";
    await expect(
      bindAdminStreamOperation("streamAdminActivityJobEvents")(path, { client }),
    ).resolves.toEqual({
      url: "https://app.example/api/admin/jobs/a%2Fb/events?source=application&cursor=2",
      withCredentials: true,
    });
    await expect(
      bindAdminOperation("streamAdminActivityJobEvents")(path, { client }),
    ).rejects.toThrow(/stream/);
    for (const wrong of [
      "https://evil.test/api/admin/jobs/a/events",
      "//evil.test/api/admin/jobs/a/events",
      "/api/admin/jobs/a/cancel",
      "/api/admin/jobs/a/events?source=data-manager",
    ])
      await expect(
        bindAdminStreamOperation("streamAdminActivityJobEvents")(wrong, { client }),
      ).rejects.toThrow();
  });
  it("never returns configured URL credentials or accepts non-HTTP and authority-replacing targets", () => {
    for (const baseUrl of [
      "https://username:secret@app.example",
      "file:///tmp/app",
      "data:text/plain,secret",
    ]) {
      const scoped = createApiClient({ baseUrl, credentials: "include" });
      let error: unknown;
      try {
        scoped.connectionTarget("/api/admin/jobs/a/events");
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain("secret");
    }
    for (const path of [
      "https://evil.test/api/jobs",
      "//evil.test/api/jobs",
      "/\\evil.test/api/jobs",
    ])
      expect(() => client.connectionTarget(path)).toThrow();
  });
  it("rejects EventSource credential/header modes that native EventSource cannot honor", async () => {
    const operation = bindAdminStreamOperation("streamAdminActivityJobEvents");
    for (const unsupported of [
      createApiClient({ baseUrl: "https://app.example", credentials: "omit" }),
      createApiClient({
        baseUrl: "https://app.example",
        credentials: "include",
        headerInterceptor: () => ({ Authorization: "secret" }),
      }),
    ]) {
      const error = await operation("/api/admin/jobs/a/events", { client: unsupported }).catch(
        (e) => e,
      );
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain("secret");
    }
    await expect(
      operation("/api/admin/jobs/a/events", { client, headers: { Authorization: "secret" } }),
    ).rejects.toThrow(/headers/);
    await expect(operation("/api/admin/jobs/a/events", { client, method: "POST" })).rejects.toThrow(
      /bound operation/,
    );
  });
});
