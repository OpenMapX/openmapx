import { describe, expect, it, vi } from "vitest";
import { createClient } from "../index.js";

describe("@hey-api/client-fetch compatibility layer", () => {
  it("serializes path and query params and parses JSON responses", async () => {
    const fetchMock = vi.fn(async (request: Request) => {
      expect(request.url).toBe("https://example.test/stops/central?ids=1&ids=2&meta[lang]=en");
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
        status: 200,
      });
    });

    const client = createClient({
      baseUrl: "https://example.test",
      fetch: fetchMock as typeof fetch,
    });

    const response = await client.get<{ ok: boolean }>({
      path: { stopId: "central" },
      query: { ids: [1, 2], meta: { lang: "en" } },
      url: "/stops/{stopId}",
    });

    expect(response.data).toEqual({ ok: true });
  });

  it("applies interceptors and config updates", async () => {
    const fetchMock = vi.fn(async (request: Request) => {
      expect(request.headers.get("X-Test")).toBe("1");
      return new Response(JSON.stringify({ baseUrl: request.url }), {
        headers: { "Content-Type": "application/json" },
        status: 200,
      });
    });

    const client = createClient({
      baseUrl: "https://old.test",
      fetch: fetchMock as typeof fetch,
    });

    client.interceptors.request.use((request) => {
      const headers = new Headers(request.headers);
      headers.set("X-Test", "1");
      return new Request(request, { headers });
    });

    client.setConfig({ baseUrl: "https://new.test" });

    const response = await client.get<{ baseUrl: string }>({
      url: "/health",
    });

    expect(response.data?.baseUrl).toBe("https://new.test/health");
  });
});
