import { afterEach, describe, expect, it, vi } from "vitest";
import { takeUnmockedFetchCalls, unmockedFetch } from "./setup";

// Each case takes the calls it recorded before it ends, so the setup file's
// afterEach does not fail it.
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("unmocked fetch guard", () => {
  it("is the global fetch in a web test", () => {
    expect(globalThis.fetch).toBe(unmockedFetch);
  });

  it("rejects with the URL in the message and records the call", async () => {
    await expect(fetch("/api/places/123")).rejects.toThrow(
      "Unmocked fetch in a web test: /api/places/123. Mock the request in the test.",
    );
    expect(takeUnmockedFetchCalls()).toEqual(["/api/places/123"]);
    expect(takeUnmockedFetchCalls()).toEqual([]);
  });

  it("records a URL and a Request argument by their URL", async () => {
    await expect(fetch(new URL("https://example.test/tiles.json"))).rejects.toThrow(TypeError);
    await expect(fetch(new Request("https://example.test/style.json"))).rejects.toThrow(TypeError);
    expect(takeUnmockedFetchCalls()).toEqual([
      "https://example.test/tiles.json",
      "https://example.test/style.json",
    ]);
  });

  it("comes back after a stubbed fetch is unstubbed", async () => {
    const stub = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", stub);
    await fetch("/api/health");
    expect(stub).toHaveBeenCalledTimes(1);
    expect(takeUnmockedFetchCalls()).toEqual([]);

    vi.unstubAllGlobals();
    expect(globalThis.fetch).toBe(unmockedFetch);
    await expect(fetch("/api/health")).rejects.toThrow(TypeError);
    expect(takeUnmockedFetchCalls()).toEqual(["/api/health"]);
  });
});
