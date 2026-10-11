import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LngLat } from "../types/geometry";
import type { MatchResult } from "../types/routing";
import { configureApiClient } from "./client";
import { fetchRouteMatchWindow } from "./routeAttributes";

const trace: LngLat[] = [
  [6.086047, 50.776993],
  [6.086282, 50.777161],
  [6.088038, 50.778025],
];

const matched: MatchResult = {
  mode: "driving",
  provider: "routing-valhalla",
  geometry: [trace[0], trace[1], [6.087297, 50.778288], trace[2]],
  edges: [
    {
      length: 25,
      speedLimit: 30,
      beginShapeIndex: 0,
      endShapeIndex: 1,
      endNodeTrafficSignal: true,
      endNodeCountryCode: "DE",
    },
    { length: 58, beginShapeIndex: 1, endShapeIndex: 2 },
    {
      length: 60,
      speedLimit: 50,
      beginShapeIndex: 2,
      endShapeIndex: 3,
      endNodeCountryCode: "NL",
    },
  ],
  points: [
    { lng: trace[0][0], lat: trace[0][1], type: "matched", edgeIndex: 0 },
    { lng: trace[1][0], lat: trace[1][1], type: "unmatched" },
    { lng: trace[2][0], lat: trace[2][1], type: "matched", edgeIndex: 2 },
  ],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("fetchRouteMatchWindow", () => {
  beforeEach(() => {
    configureApiClient({ baseUrl: "https://openmapx.example" });
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("obtains point-aligned limits and countries when edge walking would omit points", async () => {
    // Valhalla's successful edge walk has edges/shape but no matched_points.
    // Exercise the real API client and extraction against that mode contract.
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        return Promise.resolve(
          jsonResponse(body.shapeMatch === "map_snap" ? matched : { ...matched, points: [] }),
        );
      }),
    );

    expect(await fetchRouteMatchWindow(trace, "driving")).toEqual({
      signals: [trace[1]],
      speedLimitsByPoint: [30, null, 50],
      countriesByPoint: ["DE", null, "NL"],
    });
  });

  it.each([[], matched.points.slice(0, 2), [...matched.points, matched.points[0]]])(
    "rejects misaligned point attributes while retaining traffic signals (%j)",
    async (points) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ ...matched, points })));

      expect(await fetchRouteMatchWindow(trace, "driving")).toEqual({
        signals: [trace[1]],
        speedLimitsByPoint: [],
        countriesByPoint: [],
      });
    },
  );

  it("keeps unknown and zero speed limits unknown", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          ...matched,
          edges: matched.edges.map((edge) => ({ ...edge, speedLimit: 0 })),
        }),
      ),
    );

    expect((await fetchRouteMatchWindow(trace, "driving")).speedLimitsByPoint).toEqual([
      null,
      null,
      null,
    ]);
  });

  it("returns empty attributes on a failed match", async () => {
    const fetch = vi.fn(() => Promise.resolve(jsonResponse({ error: "unavailable" }, 502)));
    vi.stubGlobal("fetch", fetch);

    const pending = fetchRouteMatchWindow(trace, "driving");
    await vi.advanceTimersByTimeAsync(4000);
    expect(await pending).toEqual({
      signals: [],
      speedLimitsByPoint: [],
      countriesByPoint: [],
    });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("recovers the same trace after network and temporary provider failures with backoff", async () => {
    const attempts: { at: number; body: unknown }[] = [];
    const started = Date.now();
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        attempts.push({ at: Date.now() - started, body: JSON.parse(String(init.body)) });
        if (attempts.length === 1) return Promise.reject(new TypeError("Failed to fetch"));
        return Promise.resolve(
          jsonResponse(attempts.length === 2 ? {} : matched, attempts.length === 2 ? 503 : 200),
        );
      }),
    );

    const pending = fetchRouteMatchWindow(trace, "driving");
    await vi.advanceTimersByTimeAsync(4000);
    expect((await pending).speedLimitsByPoint).toEqual([30, null, 50]);
    expect(attempts.map(({ at }) => at)).toEqual([0, 1000, 4000]);
    expect(attempts.map(({ body }) => body)).toEqual(new Array(3).fill(attempts[0].body));
  });

  it.each([400, 401, 403, 404, 422, 501])(
    "does not retry permanent HTTP %i failures",
    async (status) => {
      const fetch = vi.fn(() => Promise.resolve(jsonResponse({}, status)));
      vi.stubGlobal("fetch", fetch);
      const pending = fetchRouteMatchWindow(trace, "driving");
      await vi.advanceTimersByTimeAsync(4000);
      expect((await pending).speedLimitsByPoint).toEqual([]);
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it("honours a short Retry-After before retrying a throttled request", async () => {
    const attempts: number[] = [];
    const started = Date.now();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        attempts.push(Date.now() - started);
        return Promise.resolve(
          attempts.length === 1
            ? new Response("", { status: 429, headers: { "Retry-After": "5" } })
            : jsonResponse(matched),
        );
      }),
    );
    const pending = fetchRouteMatchWindow(trace, "driving");
    await vi.advanceTimersByTimeAsync(5000);
    expect((await pending).speedLimitsByPoint).toEqual([30, null, 50]);
    expect(attempts).toEqual([0, 5000]);
  });

  it("does not shorten a Retry-After longer than the bounded retry budget", async () => {
    const fetch = vi.fn(() =>
      Promise.resolve(
        new Response("", {
          status: 503,
          headers: { "Retry-After": "120" },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetch);
    const pending = fetchRouteMatchWindow(trace, "driving");
    await vi.advanceTimersByTimeAsync(120_000);
    expect((await pending).speedLimitsByPoint).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("times out a stalled request and recovers on the next attempt", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        if (++calls > 1) return Promise.resolve(jsonResponse(matched));
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        });
      }),
    );
    const pending = fetchRouteMatchWindow(trace, "driving");
    await vi.advanceTimersByTimeAsync(11_000);
    expect((await pending).speedLimitsByPoint).toEqual([30, null, 50]);
    expect(calls).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a pending retry without another request", async () => {
    const controller = new AbortController();
    const fetch = vi.fn(() => Promise.reject(new TypeError("Failed to fetch")));
    vi.stubGlobal("fetch", fetch);
    const pending = fetchRouteMatchWindow(trace, "driving", { signal: controller.signal });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await vi.advanceTimersByTimeAsync(4000);
    expect((await pending).speedLimitsByPoint).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not request an already cancelled window", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetch = vi.fn(() => Promise.resolve(jsonResponse(matched)));
    vi.stubGlobal("fetch", fetch);
    expect(
      (await fetchRouteMatchWindow(trace, "driving", { signal: controller.signal }))
        .speedLimitsByPoint,
    ).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("cancels an in-flight request without treating cancellation as a timeout", async () => {
    const controller = new AbortController();
    const fetch = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    vi.stubGlobal("fetch", fetch);
    const pending = fetchRouteMatchWindow(trace, "driving", { signal: controller.signal });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    expect((await pending).speedLimitsByPoint).toEqual([]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
