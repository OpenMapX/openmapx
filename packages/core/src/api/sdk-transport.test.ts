import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ApiClientError, createApiClient } from "./client";
import { getApiCapabilities } from "./generated/runtime-metadata.generated";
import { ApiContractError, sdkRequest } from "./sdk-transport";

const schema = z.strictObject({ value: z.string() });
const client = createApiClient({ baseUrl: "https://api.example", credentials: "omit" });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("generated SDK transport", () => {
  it("validates the body and preserves response metadata and server cache policy", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ value: "ok" }, { headers: { etag: '"revision"' } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await sdkRequest<{ status: 200; data: { value: string }; headers: Headers }>(
      "/api/example",
      { client, method: "GET", cache: "no-store", schema },
    );
    expect(result.status).toBe(200);
    expect(result.data).toEqual({ value: "ok" });
    expect(result.headers.get("etag")).toBe('"revision"');
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example/api/example",
      expect.objectContaining({ credentials: "omit", cache: "no-store", method: "GET" }),
    );
  });

  it("returns an empty 304 without attempting JSON validation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 304 })),
    );
    const result = await sdkRequest("/api/example", {
      client,
      schema,
      method: "GET",
      declaredStatuses: [200, 304],
    });
    expect(result).toMatchObject({ status: 304, data: undefined });
  });

  it("rejects a bodyless status absent from an operation's declared responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 304 })),
    );
    await expect(getApiCapabilities({ client })).rejects.toBeInstanceOf(ApiClientError);
  });

  it.each([
    { status: 200, contentType: "text/html" },
    { status: 201, contentType: "application/json" },
  ])(
    "cancels unread bodies on contract rejection ($status, $contentType)",
    async ({ status, contentType }) => {
      const cancel = vi.fn();
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(new ReadableStream({ cancel }), {
              status,
              headers: { "content-type": contentType },
            }),
        ),
      );
      await expect(sdkRequest("/api/example", { client, schema })).rejects.toBeInstanceOf(
        ApiContractError,
      );
      expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it.each([
    Response.json({ value: 2, secret: "never-log-this" }),
    new Response('{"secret":"never-log-this",', {
      headers: { "content-type": "application/json" },
    }),
    new Response("never-log-this", { headers: { "content-type": "text/html" } }),
    Response.json({ value: "ok" }, { status: 201 }),
  ])("rejects malformed successful replies without exposing their content", async (response) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response),
    );
    const error = await sdkRequest("/api/example", { client, schema }).catch((value) => value);
    expect(error).toBeInstanceOf(ApiContractError);
    expect(String(error)).not.toContain("never-log-this");
    expect(JSON.stringify(error)).not.toContain("never-log-this");
    expect(error.cause).toBeUndefined();
  });

  it("retains bounded redacted HTTP errors from the existing transport", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { secret: "never-log-this" },
          { status: 429, headers: { "retry-after": "20" } },
        ),
      ),
    );
    const error = await sdkRequest("/api/example", { client, schema }).catch((value) => value);
    expect(error).toBeInstanceOf(ApiClientError);
    expect(error.retryAfterSeconds).toBe(20);
    expect(JSON.stringify(error)).not.toContain("never-log-this");
  });

  it.each(["timeout", "aborted"] as const)(
    "keeps %s active during body consumption",
    async (mode) => {
      vi.useFakeTimers();
      const abort = new AbortController();
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async (_url: string, init: RequestInit) =>
            new Response(
              new ReadableStream({
                start(controller) {
                  init.signal?.addEventListener("abort", () =>
                    controller.error(new Error("aborted")),
                  );
                },
              }),
              { headers: { "content-type": "application/json" } },
            ),
        ),
      );
      const outcome = sdkRequest("/api/example", {
        client,
        schema,
        signal: abort.signal,
        ...(mode === "timeout" ? { timeoutMs: 10 } : {}),
      }).catch((value) => value);
      await vi.advanceTimersByTimeAsync(0);
      if (mode === "aborted") abort.abort();
      else await vi.advanceTimersByTimeAsync(11);
      expect(await outcome).toMatchObject({ name: "ApiRequestAbortedError", code: mode });
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
