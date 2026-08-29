import { createNoopLogger } from "@openmapx/integration-framework/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHttpClient } from "../integration-clients";

function jsonResponse(
  body: unknown,
  status = 200,
  statusText = "OK",
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createHttpClient", () => {
  it("returns bounded JSON status and only allowlisted normalized headers", async () => {
    const fn = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ error: "quota" }, 429, "Too Many Requests", {
        "Retry-After": "60",
        "X-RateLimit-Remaining": "0",
        "X-Upstream-Secret": "do-not-forward",
      }),
    );
    vi.stubGlobal("fetch", fn);

    const response = await createHttpClient(createNoopLogger()).getResponse<{ error: string }>(
      "https://x.test/data",
      {
        maxBytes: 1_024,
        contentTypes: ["application/json"],
        responseHeaders: ["RETRY-AFTER", "x-ratelimit-remaining"],
        redirect: "error",
      },
    );

    expect(response).toEqual({
      status: 429,
      headers: { "retry-after": "60", "x-ratelimit-remaining": "0" },
      body: { error: "quota" },
    });
    expect(fn.mock.calls[0]?.[1]?.redirect).toBe("error");
  });

  it("rejects response content types outside the explicit allowlist", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Response("<html/>", { headers: { "Content-Type": "text/html" } })),
    );

    await expect(
      createHttpClient(createNoopLogger()).getResponse("https://x.test/data", {
        maxBytes: 1_024,
        contentTypes: ["application/json"],
      }),
    ).rejects.toThrow(/content type/i);
  });

  it("returns bounded binary bytes with status and allowlisted headers", async () => {
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Response(png, {
            status: 206,
            headers: {
              "Content-Type": "image/png",
              ETag: '"abc"',
              "Content-Length": String(png.byteLength),
            },
          }),
      ),
    );

    const response = await createHttpClient(createNoopLogger()).getBytes("https://x.test/tile", {
      maxBytes: 8,
      contentTypes: ["image/png"],
      responseHeaders: ["etag"],
    });

    expect(response.status).toBe(206);
    expect(response.headers).toEqual({ etag: '"abc"' });
    expect([...response.bytes]).toEqual([...png]);
  });

  it("rejects declared and streamed binary bodies over maxBytes", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(new Uint8Array([1]), {
            headers: { "Content-Type": "image/png", "Content-Length": "100" },
          }),
        )
        .mockResolvedValueOnce(
          new Response(new Uint8Array([1, 2, 3, 4]), {
            headers: { "Content-Type": "image/png" },
          }),
        ),
    );
    const client = createHttpClient(createNoopLogger());
    const options = { maxBytes: 2, contentTypes: ["image/png"] } as const;

    await expect(client.getBytes("https://x.test/declared", options)).rejects.toThrow(/too large/i);
    await expect(client.getBytes("https://x.test/streamed", options)).rejects.toThrow(/too large/i);
  });

  it("rejects a hung GET within the given timeoutMs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(init.signal?.reason ?? new Error("aborted")),
            );
          }),
      ),
    );
    const client = createHttpClient(createNoopLogger());
    await expect(client.get("https://x.test/slow", { timeoutMs: 25 })).rejects.toThrow();
  });

  it("rejects a hung POST within the given timeoutMs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(init.signal?.reason ?? new Error("aborted")),
            );
          }),
      ),
    );
    const client = createHttpClient(createNoopLogger());
    await expect(client.post("https://x.test/slow", { a: 1 }, { timeoutMs: 25 })).rejects.toThrow();
  });

  it("combines caller cancellation with the ordinary client deadline", async () => {
    let fetchSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            fetchSignal = init?.signal ?? undefined;
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
              once: true,
            });
          }),
      ),
    );
    const controller = new AbortController();
    const work = createHttpClient(createNoopLogger()).get("https://x.test/slow", {
      signal: controller.signal,
      timeoutMs: 10_000,
    });

    controller.abort();

    await expect(work).rejects.toThrow();
    expect(fetchSignal?.aborted).toBe(true);
  });

  it("always attaches a default abort signal on GET", async () => {
    const fn = vi.fn((_url: string, _init?: RequestInit) => jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fn);
    const client = createHttpClient(createNoopLogger());
    await client.get("https://x.test/data");
    const init = fn.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("rejects declared and streamed JSON bodies above the operation limit", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response("{}", {
            headers: { "Content-Type": "application/json", "Content-Length": "100" },
          }),
        )
        .mockResolvedValueOnce(jsonResponse({ value: "x".repeat(100) })),
    );
    const client = createHttpClient(createNoopLogger());

    await expect(client.get("https://x.test/declared", { maxResponseBytes: 10 })).rejects.toThrow(
      /too large/i,
    );
    await expect(
      client.post("https://x.test/streamed", undefined, { maxResponseBytes: 10 }),
    ).rejects.toThrow(/too large/i);
  });

  it("rejects a successful non-JSON response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () => new Response("<html>not json</html>", { headers: { "Content-Type": "text/html" } }),
      ),
    );
    const client = createHttpClient(createNoopLogger());
    await expect(client.get("https://x.test/data")).rejects.toThrow(/content type/i);
  });

  it("always attaches a default abort signal on POST", async () => {
    const fn = vi.fn((_url: string, _init?: RequestInit) => jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fn);
    const client = createHttpClient(createNoopLogger());
    await client.post("https://x.test/data", { a: 1 });
    const init = fn.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("GET resolves parsed JSON on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => jsonResponse({ ok: true, n: 42 })),
    );
    const client = createHttpClient(createNoopLogger());
    const data = await client.get<{ ok: boolean; n: number }>("https://x.test/data");
    expect(data).toEqual({ ok: true, n: 42 });
  });

  it("GET throws the preserved HTTP <status> <statusText> message on non-2xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => jsonResponse({}, 503, "Service Unavailable")),
    );
    const client = createHttpClient(createNoopLogger());
    await expect(client.get("https://x.test/data")).rejects.toThrow("HTTP 503 Service Unavailable");
  });

  it("POST resolves parsed JSON on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => jsonResponse({ ok: true })),
    );
    const client = createHttpClient(createNoopLogger());
    const data = await client.post<{ ok: boolean }>("https://x.test/data", { a: 1 });
    expect(data).toEqual({ ok: true });
  });

  it("POST throws the preserved HTTP <status> <statusText> message on non-2xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => jsonResponse({}, 500, "Internal Server Error")),
    );
    const client = createHttpClient(createNoopLogger());
    await expect(client.post("https://x.test/data", { a: 1 })).rejects.toThrow(
      "HTTP 500 Internal Server Error",
    );
  });
});
