import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient, ApiClientError, configureApiClient, isApiClientError } from "../client";

/**
 * A value that must never escape through an error message, stack, serialized
 * form or object spread. Upstream bodies can carry account details, so the
 * client keeps them in a non-enumerable `payload` only.
 */
const SECRET = "s3cret-upstream-detail-do-not-leak";

const BASE = "http://api.test";

let fetchMock: ReturnType<typeof vi.fn>;
const client = new ApiClient();

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
}

beforeEach(() => {
  configureApiClient({ baseUrl: BASE, credentials: "omit" });
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ApiClient success paths", () => {
  it("returns parsed JSON and forwards query params for get()", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    await expect(client.get<{ ok: boolean }>("/api/x", { a: "1" })).resolves.toEqual({
      ok: true,
    });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toBe("http://api.test/api/x?a=1");
  });

  it("returns null for a 204 from getOptional()", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await expect(client.getOptional("/api/x")).resolves.toBeNull();
  });

  it("returns parsed JSON from getOptional() on 200", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ v: 2 }));
    await expect(client.getOptional("/api/x")).resolves.toEqual({ v: 2 });
  });

  it("posts a JSON body and returns the parsed response", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ created: true }));
    await expect(client.post("/api/x", { name: "a" })).resolves.toEqual({
      created: true,
    });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ name: "a" }));
  });

  it("returns undefined for an empty delete() body and parses a JSON one", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 200 }));
    await expect(client.delete("/api/x")).resolves.toBeUndefined();
    fetchMock.mockResolvedValueOnce(jsonResponse({ deleted: 1 }));
    await expect(client.delete("/api/x")).resolves.toEqual({ deleted: 1 });
  });
});

describe("ApiClientError", () => {
  it("exposes status and parsed payload for a JSON 409 without leaking the body", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ code: "VERSION_CONFLICT", message: SECRET }, { status: 409 }),
    );
    const error = await client.get("/api/x").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiClientError);
    const apiError = error as ApiClientError;
    expect(apiError.status).toBe(409);
    expect(apiError.message).toBe("API request failed with status 409");
    expect(apiError.payload).toEqual({ code: "VERSION_CONFLICT", message: SECRET });
    expect(apiError.retryAfterSeconds).toBeNull();
  });

  it("parses an integer Retry-After alongside a JSON 429 body", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ code: "RATE_LIMITED" }, { status: 429, headers: { "retry-after": "30" } }),
    );
    const error = (await client.get("/api/x").catch((e: unknown) => e)) as ApiClientError;
    expect(error.status).toBe(429);
    expect(error.retryAfterSeconds).toBe(30);
    expect(error.payload).toEqual({ code: "RATE_LIMITED" });
  });

  it("parses an HTTP-date Retry-After into bounded seconds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    fetchMock.mockResolvedValue(
      jsonResponse(
        {},
        {
          status: 429,
          headers: { "retry-after": "Thu, 01 Jan 2026 00:01:00 GMT" },
        },
      ),
    );
    const error = (await client.get("/api/x").catch((e: unknown) => e)) as ApiClientError;
    expect(error.retryAfterSeconds).toBe(60);
    vi.useRealTimers();
  });

  it("clamps an absurd Retry-After to the bounded maximum", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({}, { status: 429, headers: { "retry-after": "99999999" } }),
    );
    const error = (await client.get("/api/x").catch((e: unknown) => e)) as ApiClientError;
    expect(error.retryAfterSeconds).toBe(86_400);
  });

  it("ignores a malformed Retry-After", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({}, { status: 429, headers: { "retry-after": "soon" } }),
    );
    const error = (await client.get("/api/x").catch((e: unknown) => e)) as ApiClientError;
    expect(error.retryAfterSeconds).toBeNull();
  });

  it("discards a non-JSON 502 body", async () => {
    fetchMock.mockResolvedValue(
      new Response(`<html>${SECRET}</html>`, {
        status: 502,
        headers: { "content-type": "text/html" },
      }),
    );
    const error = (await client.get("/api/x").catch((e: unknown) => e)) as ApiClientError;
    expect(error.status).toBe(502);
    expect(error.payload).toBeNull();
    expect(error.message).toBe("API request failed with status 502");
  });

  it("yields a null payload for an empty 403", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 403 }));
    const error = (await client.get("/api/x").catch((e: unknown) => e)) as ApiClientError;
    expect(error.status).toBe(403);
    expect(error.payload).toBeNull();
  });

  it("yields a null payload for malformed JSON", async () => {
    fetchMock.mockResolvedValue(
      new Response(`{"code": broken ${SECRET}`, {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    );
    const error = (await client.get("/api/x").catch((e: unknown) => e)) as ApiClientError;
    expect(error.payload).toBeNull();
    expect(JSON.stringify(error)).not.toContain(SECRET);
  });

  it("caps an oversize JSON error body at 64 KiB and cancels the remainder", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    let emitted = 0;
    const encoder = new TextEncoder();
    const chunk = encoder.encode(`"${"x".repeat(16 * 1024 - 2)}"`);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        emitted += 1;
        controller.enqueue(chunk);
      },
      cancel,
    });
    fetchMock.mockResolvedValue(
      new Response(stream, { status: 500, headers: { "content-type": "application/json" } }),
    );
    const error = (await client.get("/api/x").catch((e: unknown) => e)) as ApiClientError;
    expect(error.payload).toBeNull();
    expect(cancel).toHaveBeenCalled();
    // The reader stops well before an unbounded upstream stream is drained.
    expect(emitted).toBeLessThan(16);
  });

  it("accepts application/problem+json error bodies", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ code: "X" }), {
        status: 400,
        headers: { "content-type": "application/problem+json; charset=utf-8" },
      }),
    );
    const error = (await client.get("/api/x").catch((e: unknown) => e)) as ApiClientError;
    expect(error.payload).toEqual({ code: "X" });
  });

  it("uses the same structured failure for getOptional, post and delete", async () => {
    for (const call of [
      () => client.getOptional("/api/x"),
      () => client.post("/api/x", {}),
      () => client.patch("/api/x", {}),
      () => client.put("/api/x", {}),
      () => client.delete("/api/x"),
    ]) {
      fetchMock.mockResolvedValue(jsonResponse({ code: "NOPE", detail: SECRET }, { status: 403 }));
      const error = (await call().catch((e: unknown) => e)) as ApiClientError;
      expect(error).toBeInstanceOf(ApiClientError);
      expect(error.status).toBe(403);
      expect(error.message).toBe("API request failed with status 403");
      expect(error.payload).toEqual({ code: "NOPE", detail: SECRET });
    }
  });

  it("keeps upstream detail out of message, stack, serialization and spreads", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ detail: SECRET }, { status: 400 }));
    const error = (await client.get("/api/x").catch((e: unknown) => e)) as ApiClientError;
    expect(error.message).not.toContain(SECRET);
    expect(error.stack ?? "").not.toContain(SECRET);
    expect(JSON.stringify(error)).not.toContain(SECRET);
    expect(JSON.stringify({ ...error })).not.toContain(SECRET);
    expect(String(error)).not.toContain(SECRET);
    expect(Object.keys(error)).not.toContain("payload");
    expect(error.toJSON()).toEqual({
      name: "ApiClientError",
      message: "API request failed with status 400",
      status: 400,
      retryAfterSeconds: null,
    });
  });

  it("is recognized by isApiClientError and remains an Error", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, { status: 500 }));
    const error = await client.get("/api/x").catch((e: unknown) => e);
    expect(isApiClientError(error)).toBe(true);
    expect(error).toBeInstanceOf(Error);
    expect(isApiClientError(new Error("plain"))).toBe(false);
    expect(isApiClientError(null)).toBe(false);
  });
});
