import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchJson } from "./fetchJson";
import { USER_AGENT } from "./userAgent";

function mockFetch(impl: (url: string, init: RequestInit) => Promise<Response> | Response) {
  const fn = vi.fn(impl);
  vi.stubGlobal("fetch", fn);
  return fn;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchJson", () => {
  it("returns parsed JSON on a 2xx response", async () => {
    mockFetch(() => jsonResponse({ ok: true, n: 42 }));
    const data = await fetchJson<{ ok: boolean; n: number }>("https://x.test/data");
    expect(data).toEqual({ ok: true, n: 42 });
  });

  it("sends the shared User-Agent and merges extra headers", async () => {
    const fn = mockFetch(() => jsonResponse({}));
    await fetchJson("https://x.test/data", { headers: { "Accept-Language": "de" } });
    const init = fn.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)["User-Agent"]).toBe(USER_AGENT);
    expect((init.headers as Record<string, string>)["Accept-Language"]).toBe("de");
  });

  it("omits the User-Agent when userAgent is null", async () => {
    const fn = mockFetch(() => jsonResponse({}));
    await fetchJson("https://x.test/data", { userAgent: null });
    const init = fn.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)["User-Agent"]).toBeUndefined();
  });

  it("throws with the label on a non-2xx response", async () => {
    mockFetch(() => jsonResponse({ error: "boom" }, 503));
    await expect(fetchJson("https://x.test/data", { label: "Acme" })).rejects.toThrow(
      "Acme HTTP 503",
    );
  });

  it("uses a custom errorMessage builder on a non-2xx response", async () => {
    mockFetch(() => new Response("{}", { status: 404, statusText: "Not Found" }));
    await expect(
      fetchJson("https://x.test/data", {
        errorMessage: ({ status, statusText }) => `RIS failed: ${status} ${statusText}`,
      }),
    ).rejects.toThrow("RIS failed: 404 Not Found");
  });

  it("returns null on a non-2xx response when nullOnError is set", async () => {
    mockFetch(() => jsonResponse({}, 500));
    const data = await fetchJson("https://x.test/data", { nullOnError: true });
    expect(data).toBeNull();
  });

  it("returns null on a network error when nullOnError is set", async () => {
    mockFetch(() => Promise.reject(new Error("network down")));
    const data = await fetchJson("https://x.test/data", { nullOnError: true });
    expect(data).toBeNull();
  });
});
