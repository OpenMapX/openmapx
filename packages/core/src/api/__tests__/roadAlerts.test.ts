import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureApiClient } from "../client";
import { fetchRoadAlerts } from "../roadAlerts";

const BBOX = { south: 51.2, west: 6.6, north: 51.3, east: 6.7 };

function respond(body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }),
    ),
  );
}

beforeEach(() => {
  configureApiClient({ baseUrl: "http://api.test", credentials: "omit" });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchRoadAlerts", () => {
  it("passes the alerts' roads through", async () => {
    const roads = [
      {
        wayId: 1,
        line: [
          [6.6, 51.2],
          [6.61, 51.2],
        ],
        anchorIndex: 1,
        forward: true,
        backward: false,
      },
    ];
    respond({ alerts: [{ id: "stop:1", type: "stop", lat: 51.2, lng: 6.61, roads }] });
    await expect(fetchRoadAlerts(BBOX)).resolves.toEqual([
      { id: "stop:1", type: "stop", lat: 51.2, lng: 6.61, roads },
    ]);
  });

  it("gives an alert without road information no roads", async () => {
    // An answer cached before the server described each alert's roads.
    respond({ alerts: [{ id: "stop:1", type: "stop", lat: 51.2, lng: 6.61 }] });
    await expect(fetchRoadAlerts(BBOX)).resolves.toEqual([
      { id: "stop:1", type: "stop", lat: 51.2, lng: 6.61, roads: [] },
    ]);
  });

  it("answers [] when the request fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 502 })),
    );
    await expect(fetchRoadAlerts(BBOX)).resolves.toEqual([]);
  });
});
