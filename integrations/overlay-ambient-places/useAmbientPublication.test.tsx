import { AMBIENT_MAX_AGE_MS, type AmbientManifest } from "@openmapx/core/ambient-places";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAmbientPublication } from "./useAmbientPublication";

const DAY = 86_400_000;
const ORIGIN_A = "https://api-a.example";
const ORIGIN_B = "https://api-b.example";

function publication(
  generation: string,
  overrides: { publishedAt?: Date; enabled?: boolean; overtureAt?: Date | null } = {},
): AmbientManifest {
  const publishedAt = (overrides.publishedAt ?? new Date()).toISOString();
  const overture =
    overrides.overtureAt === null
      ? null
      : {
          region: "Germany",
          release: "2026-07",
          publishedAt: (overrides.overtureAt ?? overrides.publishedAt ?? new Date()).toISOString(),
          count: 1,
        };
  return {
    version: 2,
    policyVersion: 2,
    generation,
    publishedAt,
    region: { name: "Aachen", bounds: [5.9, 50.65, 6.3, 50.95] },
    placeCount: 1,
    enabled: overrides.enabled ?? true,
    sources: { osm: { region: "Germany", epoch: "one", publishedAt, count: 1 }, overture },
  };
}
const FIRST = "11111111-1111-4111-8111-111111111111";
const SECOND = "22222222-2222-4222-8222-222222222222";

interface Pending {
  url: string;
  signal: AbortSignal;
  init: RequestInit;
  respond: (body: unknown, status?: number) => void;
  fail: (error: unknown) => void;
}
let requests: Pending[] = [];
let honorAbort = true;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-14T12:00:00Z"));
  requests = [];
  honorAbort = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (url: string, init: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          const signal = init.signal as AbortSignal;
          signal.addEventListener("abort", () => {
            if (honorAbort) reject(new DOMException("The operation was aborted.", "AbortError"));
          });
          requests.push({
            url,
            signal,
            init,
            respond: (body, status = 200) =>
              resolve({ ok: status < 400, status, json: async () => body } as Response),
            fail: reject,
          });
        }),
    ),
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}
async function answer(index: number, body: unknown, status?: number) {
  requests[index]?.respond(body, status);
  await settle();
}
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
async function mount(origin = ORIGIN_A) {
  const view = renderHook(({ url }) => useAmbientPublication(url), {
    initialProps: { url: origin },
  });
  await settle();
  return view;
}

describe("useAmbientPublication discovery", () => {
  it("discovers the current origin without caching and yields only a usable publication", async () => {
    const view = await mount();
    expect(view.result.current).toBeNull();
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(`${ORIGIN_A}/api/ambient-places/manifest`);
    expect(requests[0].init.cache).toBe("no-store");

    const manifest = publication(FIRST);
    await answer(0, { manifest });
    expect(view.result.current).toEqual(manifest);
  });

  it.each([
    ["absent", () => null],
    ["disabled", () => publication(SECOND, { enabled: false })],
    ["stale", () => publication(SECOND, { publishedAt: new Date(Date.now() - 91 * DAY) })],
    [
      "partly stale",
      () => publication(SECOND, { overtureAt: new Date(Date.now() - AMBIENT_MAX_AGE_MS - DAY) }),
    ],
  ])("clears prior content when a successful reply is %s", async (_name, next) => {
    const view = await mount();
    await answer(0, { manifest: publication(FIRST) });
    expect(view.result.current?.generation).toBe(FIRST);

    await advance(60_000);
    await answer(1, { manifest: next() });
    expect(view.result.current).toBeNull();
  });

  it("refreshes every minute, replaces the in-flight request and keeps content meanwhile", async () => {
    const view = await mount();
    await answer(0, { manifest: publication(FIRST) });

    await advance(60_000);
    expect(requests).toHaveLength(2);
    expect(view.result.current?.generation).toBe(FIRST);

    // The previous refresh never settles; the next tick cancels it.
    await advance(60_000);
    expect(requests).toHaveLength(3);
    expect(requests[1].signal.aborted).toBe(true);

    await answer(2, { manifest: publication(SECOND) });
    expect(view.result.current?.generation).toBe(SECOND);
  });

  it.each([
    ["an HTTP error", (i: number) => answer(i, { error: "down" }, 503)],
    ["a network error", async (i: number) => requests[i].fail(new TypeError("offline"))],
    [
      "an unsupported version",
      (i: number) => answer(i, { manifest: { ...publication(SECOND), version: 3 } }),
    ],
    [
      "a publication without a generation",
      (i: number) => answer(i, { manifest: { ...publication(SECOND), generation: "" } }),
    ],
  ])("keeps a fresh same-API-origin publication through %s", async (_name, fail) => {
    const view = await mount();
    await answer(0, { manifest: publication(FIRST) });

    await advance(60_000);
    await fail(1);
    await settle();
    expect(view.result.current?.generation).toBe(FIRST);
  });

  it("never invents content when the first discovery fails", async () => {
    const view = await mount();
    await answer(0, {}, 503);
    expect(view.result.current).toBeNull();
  });

  it("drops a last-known publication once it passes the 90-day freshness limit", async () => {
    const view = await mount();
    await answer(0, {
      manifest: publication(FIRST, { publishedAt: new Date(Date.now() - 89 * DAY) }),
    });
    expect(view.result.current?.generation).toBe(FIRST);

    await advance(60_000);
    await answer(1, {}, 503);
    expect(view.result.current?.generation).toBe(FIRST);

    // Two days later the same generation is 91 days old; a failed refresh cannot keep it.
    vi.setSystemTime(Date.now() + 2 * DAY);
    await advance(60_000);
    await answer(2, {}, 503);
    expect(view.result.current).toBeNull();
  });

  it("expires an aged last-known publication at the next refresh even while that refresh hangs", async () => {
    const view = await mount();
    await answer(0, {
      manifest: publication(FIRST, { publishedAt: new Date(Date.now() - 89 * DAY) }),
    });
    expect(view.result.current?.generation).toBe(FIRST);

    // The refresh that starts while the generation is still fresh keeps it visible.
    await advance(60_000);
    expect(requests).toHaveLength(2);
    expect(view.result.current?.generation).toBe(FIRST);

    // The publication crosses 90 days while every refresh stays unresolved.
    vi.setSystemTime(Date.now() + 2 * DAY);
    await advance(60_000);
    expect(requests).toHaveLength(3);
    expect(requests[2].signal.aborted).toBe(false);
    expect(view.result.current).toBeNull();
  });
});

describe("useAmbientPublication ownership", () => {
  it("releases the old origin immediately and never carries its generation over", async () => {
    const view = await mount(ORIGIN_A);
    await answer(0, { manifest: publication(FIRST) });
    expect(view.result.current?.generation).toBe(FIRST);

    view.rerender({ url: ORIGIN_B });
    // Cleared in the very render that changes origin, before any reply.
    expect(view.result.current).toBeNull();
    await settle();
    expect(requests[0].signal.aborted).toBe(true);
    expect(requests[1].url).toBe(`${ORIGIN_B}/api/ambient-places/manifest`);
    expect(view.result.current).toBeNull();

    // A failed first discovery on the new origin cannot reuse the old publication.
    await answer(1, {}, 503);
    expect(view.result.current).toBeNull();

    await advance(60_000);
    await answer(2, { manifest: publication(SECOND) });
    expect(view.result.current?.generation).toBe(SECOND);
  });

  it("does not resurrect an origin's generation when the origin is restored", async () => {
    const view = await mount(ORIGIN_A);
    await answer(0, { manifest: publication(FIRST) });

    view.rerender({ url: ORIGIN_B });
    await settle();
    view.rerender({ url: ORIGIN_A });
    expect(view.result.current).toBeNull();
    await settle();

    await answer(2, {}, 503);
    expect(view.result.current).toBeNull();
  });

  it("ignores a late reply from the replaced origin", async () => {
    honorAbort = false;
    const view = await mount(ORIGIN_A);
    view.rerender({ url: ORIGIN_B });
    await settle();
    expect(requests[0].signal.aborted).toBe(true);

    // Even a transport that ignores abort cannot publish for the wrong origin.
    await answer(0, { manifest: publication(FIRST) });
    expect(view.result.current).toBeNull();
    await answer(1, { manifest: publication(SECOND) });
    expect(view.result.current?.generation).toBe(SECOND);
  });

  it("cancels the request and the refresh timer on unmount", async () => {
    const view = await mount();
    view.unmount();
    expect(requests[0].signal.aborted).toBe(true);

    await advance(180_000);
    expect(requests).toHaveLength(1);
  });

  it("starts from scratch after a remount instead of reusing a previous generation", async () => {
    const first = await mount();
    await answer(0, { manifest: publication(FIRST) });
    expect(first.result.current?.generation).toBe(FIRST);
    first.unmount();

    const second = await mount();
    expect(second.result.current).toBeNull();
    expect(requests).toHaveLength(2);

    await answer(1, {}, 503);
    expect(second.result.current).toBeNull();
  });
});
