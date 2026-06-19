import { describe, expect, it, vi } from "vitest";
import { createOllamaProvider } from "../providers/ollama";
import type { ParseContext } from "../types";

const CTX: ParseContext = {
  mapCenter: [2.35, 48.86],
  mapBbox: { south: 48.85, west: 2.33, north: 48.87, east: 2.37 },
};

const INTENT = {
  filter: {
    selectors: [{ tags: [{ key: "tourism", op: "=" as const, value: "museum" }] }],
    require: [
      { key: "wheelchair", op: "=" as const, value: "yes" },
      { key: "fee", op: "=" as const, value: "no" },
    ],
  },
  spatial_constraint: { type: "near_place" as const, place_name: "train station" },
  time_constraint: null,
  sort_by: "distance" as const,
  unmapped_attributes: [],
  confidence: 0.9,
  explanation: "Museums with wheelchair access, no entry fee, near train station",
};

describe("createOllamaProvider", () => {
  it("has id 'local' and requiresNetwork false", () => {
    const provider = createOllamaProvider({
      endpoint: "http://localhost:11434",
      model: "llama3.2",
      timeoutMs: 5000,
    });
    expect(provider.id).toBe("local");
    expect(provider.requiresNetwork).toBe(false);
  });

  it("happy path: posts to /api/chat and returns parsed intent", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ message: { content: JSON.stringify(INTENT) } }),
      text: async () => "",
    });

    const endpoint = "http://localhost:11434";
    const model = "llama3.2";

    const provider = createOllamaProvider({
      endpoint,
      model,
      timeoutMs: 5000,
      fetchImpl: mockFetch,
    });

    const result = await provider.parseQuery(
      "museums near train station wheelchair accessible no fee",
      CTX,
    );

    expect(result).toEqual(INTENT);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];

    expect(url).toBe(`${endpoint}/api/chat`);

    const body = JSON.parse(init.body as string);
    expect(body.model).toBe(model);
    expect(body.stream).toBe(false);
    expect(body.format).toBeDefined();
    expect(body.options.temperature).toBe(0);
    expect(Array.isArray(body.messages)).toBe(true);
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[1].role).toBe("user");
  });

  it("rejects on non-ok response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "boom",
      json: async () => ({}),
    });

    const provider = createOllamaProvider({
      endpoint: "http://localhost:11434",
      model: "llama3.2",
      timeoutMs: 5000,
      fetchImpl: mockFetch,
    });

    await expect(provider.parseQuery("museums", CTX)).rejects.toThrow("Ollama 500");
  });

  it("rejects when content is empty", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ message: { content: "" } }),
      text: async () => "",
    });

    const provider = createOllamaProvider({
      endpoint: "http://localhost:11434",
      model: "llama3.2",
      timeoutMs: 5000,
      fetchImpl: mockFetch,
    });

    await expect(provider.parseQuery("museums", CTX)).rejects.toThrow("empty content");
  });

  it("uses default global fetch when fetchImpl is not provided", () => {
    expect(() =>
      createOllamaProvider({
        endpoint: "http://localhost:11434",
        model: "llama3.2",
        timeoutMs: 5000,
      }),
    ).not.toThrow();
  });
});
