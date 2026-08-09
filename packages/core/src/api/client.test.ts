import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError, configureApiClient } from "./client";

function mockResponse(body: string, status: number, contentType = "application/json") {
  vi.mocked(fetch).mockResolvedValueOnce(
    new Response(body, { status, headers: { "Content-Type": contentType } }),
  );
}

function asApiError(error: unknown): ApiError {
  expect(error).toBeInstanceOf(ApiError);
  if (!(error instanceof ApiError)) throw new Error("Expected ApiError");
  return error;
}

async function invoke(
  client: ApiClient,
  method: "GET" | "GET_OPTIONAL" | "POST" | "PATCH" | "PUT" | "DELETE",
) {
  switch (method) {
    case "GET":
      return client.get("/api/test");
    case "GET_OPTIONAL":
      return client.getOptional("/api/test");
    case "POST":
      return client.post("/api/test", { value: 1 });
    case "PATCH":
      return client.patch("/api/test", { value: 1 });
    case "PUT":
      return client.put("/api/test", { value: 1 });
    case "DELETE":
      return client.delete("/api/test");
  }
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
  configureApiClient({
    baseUrl: "https://openmapx.example.test",
    credentials: "include",
    headerInterceptor: () => ({ "X-Test": "safe" }),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ApiClient", () => {
  it.each(["GET", "GET_OPTIONAL", "POST", "PATCH", "PUT", "DELETE"] as const)(
    "returns parsed successful JSON for %s",
    async (method) => {
      mockResponse('{"ok":true}', 200);
      const client = new ApiClient();

      await expect(invoke(client, method)).resolves.toEqual({ ok: true });
      expect(fetch).toHaveBeenCalledWith(
        "https://openmapx.example.test/api/test",
        expect.objectContaining({
          credentials: "include",
          headers: expect.objectContaining({ Accept: "application/json", "X-Test": "safe" }),
        }),
      );
    },
  );

  it("preserves getOptional 204 and empty DELETE behavior", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new ApiClient();

    await expect(client.getOptional("/api/optional")).resolves.toBeNull();
    await expect(client.delete("/api/empty")).resolves.toBeUndefined();
  });

  it.each(["GET", "GET_OPTIONAL", "POST", "PATCH", "PUT", "DELETE"] as const)(
    "throws a safe typed JSON error for %s",
    async (method) => {
      mockResponse(
        JSON.stringify({
          error: "Timeline source is unavailable",
          code: "TIMELINE_UPSTREAM_UNAVAILABLE",
          retryAfterSeconds: 17,
          internal: "raw private body detail",
        }),
        503,
      );
      const client = new ApiClient();

      const error = asApiError(await invoke(client, method).catch((caught) => caught));

      expect(error).toMatchObject({
        message: "Timeline source is unavailable",
        status: 503,
        code: "TIMELINE_UPSTREAM_UNAVAILABLE",
        retryAfterSeconds: 17,
      });
      expect(JSON.stringify(error)).not.toContain("raw private body detail");
      expect(error).not.toHaveProperty("body");
      expect(error).not.toHaveProperty("response");
    },
  );

  it.each(["GET", "GET_OPTIONAL", "POST", "PATCH", "PUT", "DELETE"] as const)(
    "falls back without retaining a non-JSON %s response",
    async (method) => {
      mockResponse("raw upstream secret body", 502, "text/plain");
      const client = new ApiClient();

      const error = asApiError(await invoke(client, method).catch((caught) => caught));

      expect(error).toMatchObject({
        message: "Request failed (HTTP 502)",
        status: 502,
        code: null,
        retryAfterSeconds: null,
      });
      expect(JSON.stringify(error)).not.toContain("raw upstream secret body");
    },
  );

  it("caps a server-provided error message at 200 characters", async () => {
    mockResponse(JSON.stringify({ error: "x".repeat(250), code: "LONG" }), 400);
    const client = new ApiClient();

    const error = asApiError(await client.get("/api/test").catch((caught) => caught));

    expect(error.message).toBe("x".repeat(200));
    expect(error.message).toHaveLength(200);
    expect(error.code).toBe("LONG");
  });

  it.each([
    { body: null, code: null, retry: null },
    { body: [], code: null, retry: null },
    { body: { error: 42, code: 42, retryAfterSeconds: "17" }, code: null, retry: null },
    {
      body: { error: "Safe message", code: "SAFE", retryAfterSeconds: -1 },
      code: "SAFE",
      retry: null,
    },
    {
      body: { error: "Safe message", code: "SAFE", retryAfterSeconds: Number.POSITIVE_INFINITY },
      code: "SAFE",
      retry: null,
    },
  ])("accepts only safe object error fields: %#", async ({ body, code, retry }) => {
    mockResponse(JSON.stringify(body), 429);
    const client = new ApiClient();

    const error = asApiError(await client.get("/api/test").catch((caught) => caught));

    expect(error.code).toBe(code);
    expect(error.retryAfterSeconds).toBe(retry);
  });
});
