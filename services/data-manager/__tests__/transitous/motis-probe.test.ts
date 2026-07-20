import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithTimeout } from "../../src/jobs/transitous/motis-probe.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function okResponse(): Response {
  return new Response("{}", { headers: { "content-type": "application/json" } });
}

describe("fetchWithTimeout", () => {
  it("retries a transient undici 'terminated' fault and then succeeds", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      if (calls < 3) throw new TypeError("terminated");
      return okResponse();
    }) as typeof fetch;
    const res = await fetchWithTimeout("http://motis/api/v1/plan", 1000, 3);
    expect(res.ok).toBe(true);
    expect(calls).toBe(3);
  });

  it("matches the transient error on the error's cause too", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      if (calls === 1) {
        const err = new TypeError("fetch failed");
        (err as { cause?: unknown }).cause = new Error("other side closed");
        throw err;
      }
      return okResponse();
    }) as typeof fetch;
    const res = await fetchWithTimeout("http://motis/x", 1000, 2);
    expect(res.ok).toBe(true);
    expect(calls).toBe(2);
  });

  it("does NOT retry a deliberate timeout abort", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      const err = new Error("This operation was aborted");
      err.name = "AbortError";
      throw err;
    }) as typeof fetch;
    await expect(fetchWithTimeout("http://motis/x", 1000, 3)).rejects.toThrow(/aborted/);
    expect(calls).toBe(1);
  });

  it("gives up after exhausting retries on a persistent transient fault", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      throw new TypeError("terminated");
    }) as typeof fetch;
    await expect(fetchWithTimeout("http://motis/x", 1000, 2)).rejects.toThrow(/terminated/);
    expect(calls).toBe(3); // initial + 2 retries
  });
});
