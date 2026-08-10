import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiClient,
  ApiClientError,
  ApiRequestAbortedError,
  apiClient,
  configureApiClient,
  createApiClient,
  isApiRequestAbortedError,
} from "./client";

/** Records every fetch the client makes, so isolation can be asserted. */
interface RecordedCall {
  url: string;
  init: RequestInit;
}

let calls: RecordedCall[] = [];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockFetch(handler: (url: string, init: RequestInit) => Promise<Response> | Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init: RequestInit = {}) => {
      calls.push({ url: String(url), init });
      return handler(String(url), init);
    }),
  );
}

beforeEach(() => {
  calls = [];
  configureApiClient({ baseUrl: "https://web.example/", credentials: "include" });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("instance isolation", () => {
  it("uses its own origin and credentials, not the singleton's", async () => {
    mockFetch(() => jsonResponse({ ok: true }));
    const native = createApiClient({ baseUrl: "https://api.example/", credentials: "omit" });

    await native.get("/api/x");
    expect(calls[0].url).toBe("https://api.example/api/x");
    expect(calls[0].init.credentials).toBe("omit");
  });

  it("keeps two interleaved clients on their own configuration", async () => {
    mockFetch(() => jsonResponse({ ok: true }));
    const a = createApiClient({ baseUrl: "https://a.example/", credentials: "omit" });
    const b = createApiClient({ baseUrl: "https://b.example/", credentials: "include" });

    await Promise.all([a.get("/one"), b.get("/two"), a.get("/three")]);
    const byUrl = Object.fromEntries(calls.map((c) => [c.url, c.init.credentials]));
    expect(byUrl["https://a.example/one"]).toBe("omit");
    expect(byUrl["https://b.example/two"]).toBe("include");
    expect(byUrl["https://a.example/three"]).toBe("omit");
  });

  it("still omits credentials after the singleton is reconfigured to include them", async () => {
    mockFetch(() => jsonResponse({ ok: true }));
    const native = createApiClient({ baseUrl: "https://api.example/", credentials: "omit" });

    configureApiClient({ baseUrl: "https://web.example/", credentials: "include" });
    await native.get("/api/x");

    expect(calls[0].init.credentials).toBe("omit");
    expect(calls[0].url.startsWith("https://api.example/")).toBe(true);
  });

  it("sends no cookie or authorization header for a native-shaped client", async () => {
    mockFetch(() => jsonResponse({ ok: true }));
    const native = createApiClient({ baseUrl: "https://api.example/", credentials: "omit" });
    await native.get("/api/x");

    const headers = new Headers(calls[0].init.headers as HeadersInit);
    expect(headers.get("cookie")).toBeNull();
    expect(headers.get("authorization")).toBeNull();
  });

  it("freezes the instance config so a caller cannot mutate it later", () => {
    const config = { baseUrl: "https://api.example/", credentials: "omit" as const };
    createApiClient(config);
    expect(() => {
      (config as { baseUrl: string }).baseUrl = "https://evil.example/";
    }).not.toThrow();
    // The client copied the config, so the original object is irrelevant to it.
    expect(config.baseUrl).toBe("https://evil.example/");
  });

  it("leaves the singleton following the global configuration", async () => {
    mockFetch(() => jsonResponse({ ok: true }));
    await apiClient.get("/api/y");
    expect(calls[0].url).toBe("https://web.example/api/y");
    expect(calls[0].init.credentials).toBe("include");
  });
});

describe("timeouts and aborts", () => {
  it("aborts with a timeout code once the deadline passes", async () => {
    vi.useFakeTimers();
    mockFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          );
        }),
    );
    const client = createApiClient({ baseUrl: "https://api.example/", credentials: "omit" });
    const pending = client.get("/slow", undefined, { timeoutMs: 1_000 });
    const assertion = expect(pending).rejects.toBeInstanceOf(ApiRequestAbortedError);
    await vi.advanceTimersByTimeAsync(1_001);
    await assertion;
  });

  it("distinguishes a caller abort from a timeout", async () => {
    const controller = new AbortController();
    mockFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          );
        }),
    );
    const client = createApiClient({ baseUrl: "https://api.example/", credentials: "omit" });
    const pending = client.get("/slow", undefined, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
  });

  it("rejects immediately when the caller signal is already aborted", async () => {
    mockFetch(() => jsonResponse({ ok: true }));
    const controller = new AbortController();
    controller.abort();
    const client = createApiClient({ baseUrl: "https://api.example/", credentials: "omit" });
    await expect(client.get("/x", undefined, { signal: controller.signal })).rejects.toMatchObject({
      code: "aborted",
    });
    expect(calls).toHaveLength(0);
  });

  it("clears its timer on success, so nothing keeps the loop alive", async () => {
    vi.useFakeTimers();
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    mockFetch(() => jsonResponse({ ok: true }));
    const client = createApiClient({ baseUrl: "https://api.example/", credentials: "omit" });
    await client.get("/x", undefined, { timeoutMs: 5_000 });
    expect(clearSpy).toHaveBeenCalled();
  });

  it("clears its timer when the request fails", async () => {
    vi.useFakeTimers();
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    mockFetch(() => {
      throw new Error("network down");
    });
    const client = createApiClient({ baseUrl: "https://api.example/", credentials: "omit" });
    await expect(client.get("/x", undefined, { timeoutMs: 5_000 })).rejects.toThrow("network down");
    expect(clearSpy).toHaveBeenCalled();
  });

  it("recognises its own abort error", () => {
    expect(isApiRequestAbortedError(new ApiRequestAbortedError("timeout"))).toBe(true);
    expect(isApiRequestAbortedError(new Error("nope"))).toBe(false);
  });
});

describe("error hygiene", () => {
  it("maps a non-2xx response to a status-bearing error", async () => {
    mockFetch(() => jsonResponse({ message: "nope" }, 503));
    const client = createApiClient({ baseUrl: "https://api.example/", credentials: "omit" });
    await expect(client.get("/x")).rejects.toBeInstanceOf(ApiClientError);
  });

  it("keeps the response body out of anything that gets logged", async () => {
    const secret = "user@example.com";
    mockFetch(() => jsonResponse({ email: secret }, 403));
    const client = createApiClient({ baseUrl: "https://api.example/", credentials: "omit" });

    await client.get("/x").then(
      () => expect.unreachable("expected a rejection"),
      (error: ApiClientError) => {
        expect(JSON.stringify(error)).not.toContain(secret);
        expect(error.message).not.toContain(secret);
      },
    );
  });

  it("keeps the request query out of the error message", async () => {
    mockFetch(() => jsonResponse({}, 500));
    const client = createApiClient({ baseUrl: "https://api.example/", credentials: "omit" });
    await client.get("/x", { lat: "50.1", lng: "8.6" }).then(
      () => expect.unreachable("expected a rejection"),
      (error: ApiClientError) => {
        expect(error.message).not.toContain("50.1");
        expect(error.message).not.toContain("8.6");
      },
    );
  });
});

describe("requests", () => {
  it("appends query parameters", async () => {
    mockFetch(() => jsonResponse({ ok: true }));
    const client = createApiClient({ baseUrl: "https://api.example/", credentials: "omit" });
    await client.get("/search", { q: "frankfurt hbf" });
    expect(calls[0].url).toContain("q=frankfurt+hbf");
  });

  it("returns null for a 204 from getOptional", async () => {
    mockFetch(() => jsonResponse(null, 204));
    const client = createApiClient({ baseUrl: "https://api.example/", credentials: "omit" });
    await expect(client.getOptional("/maybe")).resolves.toBeNull();
  });

  it("posts a JSON body", async () => {
    mockFetch(() => jsonResponse({ ok: true }));
    const client = createApiClient({ baseUrl: "https://api.example/", credentials: "omit" });
    await client.post("/thing", { a: 1 });
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.body).toBe('{"a":1}');
  });

  it("accepts a bare client that falls back to the global configuration", async () => {
    mockFetch(() => jsonResponse({ ok: true }));
    await new ApiClient().get("/fallback");
    expect(calls[0].url).toBe("https://web.example/fallback");
  });
});
