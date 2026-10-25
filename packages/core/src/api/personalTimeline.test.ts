import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { connected, day, disconnected } from "../test/fixtures/personalTimeline";
import type { PersonalTimelineDayV1 } from "../types/personalTimeline";
import { ApiClientError, apiClient } from "./client";
import { API_ENDPOINTS } from "./endpoints";
import {
  connectTimeline,
  disconnectTimeline,
  getPersonalTimelineDay,
  getTimelineConnection,
  PersonalTimelineApiError,
  testTimelineConnection,
} from "./personalTimeline";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("personal timeline API", () => {
  describe.each(["get", "put", "post"] as const)("%s connection response", (method) => {
    const invoke = () =>
      method === "get"
        ? getTimelineConnection()
        : method === "put"
          ? connectTimeline({ mode: "managed", apiKey: "fixture-key" })
          : testTimelineConnection();
    it.each([
      { connected: true },
      { ...connected, connection: null },
      { ...disconnected, connected: true },
      { ...connected, connection: { ...connected.connection, validatedAt: "invalid" } },
      { ...connected, connection: { ...connected.connection, status: "unknown" } },
      {
        ...connected,
        connection: {
          ...connected.connection,
          publicOrigin: "https://user:secret@timeline.example.test",
        },
      },
      { ...disconnected, managed: undefined },
      null,
    ])("rejects malformed successful metadata without private diagnostics", async (payload) => {
      vi.spyOn(apiClient, method).mockResolvedValue(payload as never);
      await expect(invoke()).rejects.toMatchObject({
        name: "PersonalTimelineApiError",
        status: 200,
        code: "TIMELINE_RESPONSE_INVALID",
        retryAfterSeconds: null,
      });
    });
    it.each([
      disconnected,
      connected,
      {
        ...disconnected,
        managed: { available: false, healthy: true, publicOrigin: null, reason: "unprovisioned" },
      },
    ])("preserves complete metadata including healthy unprovisioned instances", async (payload) => {
      vi.spyOn(apiClient, method).mockResolvedValue(payload as never);
      expect(await invoke()).toEqual(payload);
    });
  });

  it.each([undefined, null, {}, { ok: false }])(
    "rejects missing or false disconnect receipts",
    async (payload) => {
      vi.spyOn(apiClient, "delete").mockResolvedValue(payload as never);
      await expect(disconnectTimeline()).rejects.toMatchObject({
        status: 200,
        code: "TIMELINE_RESPONSE_INVALID",
        retryAfterSeconds: null,
      });
    },
  );

  it.each([
    { version: 1 },
    { ...day, version: 2 },
    { ...day, date: "2026-02-30" },
    { ...day, bounds: [13, 45, 12, 46] },
    { ...day, summary: { ...day.summary, placesVisited: -1 } },
    { ...day, entries: [{ ...day.entries[0], durationSeconds: -1 }] },
    { ...day, warnings: ["unknown-warning"] },
    {
      ...day,
      map: {
        ...day.map,
        tracks: {
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              properties: { id: "track-a" },
              geometry: {
                type: "LineString",
                coordinates: [
                  [12, 91],
                  [13, 46],
                ],
              },
            },
          ],
        },
      },
    },
    {
      ...day,
      map: {
        ...day.map,
        tracks: {
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              properties: { id: "track-a" },
              geometry: { type: "LineString", coordinates: [[12, 45]] },
            },
          ],
        },
      },
    },
    {
      ...day,
      map: {
        ...day.map,
        visits: {
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              properties: {},
              geometry: { type: "Point", coordinates: [12, 45] },
            },
          ],
        },
      },
    },
  ])("rejects malformed normalized days before query publication", async (payload) => {
    vi.spyOn(apiClient, "get").mockResolvedValue(payload as never);
    await expect(getPersonalTimelineDay("2026-01-02")).rejects.toMatchObject({
      status: 200,
      code: "TIMELINE_RESPONSE_INVALID",
      retryAfterSeconds: null,
    });
  });

  it("projects successful payloads onto declared fields before UI/cache access", async () => {
    const secret = "private-extra-field";
    vi.spyOn(apiClient, "get").mockResolvedValue({
      ...day,
      secret,
      map: {
        ...day.map,
        tracks: {
          ...day.map.tracks,
          features: [
            {
              ...day.map.tracks.features[0],
              properties: { id: "track-a", deviceId: secret },
            },
          ],
        },
      },
    } as never);
    const result = await getPersonalTimelineDay("2026-01-02");
    expect(result).toEqual(day);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("does not retain malformed success payloads or schema diagnostics on errors", async () => {
    vi.spyOn(apiClient, "get").mockResolvedValue({
      ...day,
      entries: "private-track-data",
    } as never);
    const error = await getPersonalTimelineDay("2026-01-02").catch((value: unknown) => value);
    expect(error).toBeInstanceOf(PersonalTimelineApiError);
    expect(JSON.stringify(error)).not.toContain("private-track-data");
    expect(error).not.toHaveProperty("payload");
    expect(error).not.toHaveProperty("cause");
    expect(error).not.toHaveProperty("issues");
  });

  it("accepts valid normalized geometry above the generated SDK's 8 MiB default", async () => {
    // Four tracks of ~2.4 MiB each can arrive across four <=5 MiB source pages.
    const payload = {
      ...day,
      map: {
        ...day.map,
        tracks: {
          type: "FeatureCollection",
          features: Array.from({ length: 4 }, () => ({
            type: "Feature",
            properties: { id: "track-a" },
            geometry: {
              type: "LineString",
              coordinates: Array.from({ length: 80_000 }, () => [12.3456789, 45.6789123, 123]),
            },
          })),
        },
      },
    };
    expect(JSON.stringify(payload).length).toBeGreaterThan(8 * 1024 * 1024);
    vi.spyOn(apiClient, "get").mockResolvedValue(payload as never);
    const result = await getPersonalTimelineDay("2026-01-02");
    expect(result.map.tracks.features).toHaveLength(4);
    expect(result.map.tracks.features[3].geometry.coordinates).toHaveLength(80_000);
  });

  it("validates actual transport JSON and preserves request credentials", async () => {
    const fetch = vi.fn(async () => Response.json(day));
    vi.stubGlobal("fetch", fetch);
    expect(await getPersonalTimelineDay("2026-01-02")).toEqual(day);
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/timeline/day/2026-01-02"),
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("types normalized map features with identifier-only properties", () => {
    type TrackProperties = PersonalTimelineDayV1["map"]["tracks"]["features"][number]["properties"];
    type VisitProperties = PersonalTimelineDayV1["map"]["visits"]["features"][number]["properties"];

    expectTypeOf<TrackProperties>().toEqualTypeOf<{ id: string }>();
    expectTypeOf<VisitProperties>().toEqualTypeOf<{ id: string }>();
  });

  it("gets connection metadata from the provider-neutral endpoint", async () => {
    const response = disconnected;
    const get = vi.spyOn(apiClient, "get").mockResolvedValue(response as never);

    await expect(getTimelineConnection()).resolves.toEqual(response);
    expect(get).toHaveBeenCalledWith(API_ENDPOINTS.timelineConnection);
  });

  it("connects, tests and disconnects through the connection endpoint", async () => {
    const request = {
      mode: "external" as const,
      instanceUrl: "https://timeline.example.test",
      apiKey: "fixture-key",
    };
    const put = vi.spyOn(apiClient, "put").mockResolvedValue(connected as never);
    const post = vi.spyOn(apiClient, "post").mockResolvedValue(connected as never);
    const deleteRequest = vi.spyOn(apiClient, "delete").mockResolvedValue({ ok: true } as never);

    await connectTimeline(request);
    await testTimelineConnection();
    await disconnectTimeline();

    expect(put).toHaveBeenCalledWith(API_ENDPOINTS.timelineConnection, request);
    expect(post).toHaveBeenCalledWith(API_ENDPOINTS.timelineConnectionTest, {});
    expect(deleteRequest).toHaveBeenCalledWith(API_ENDPOINTS.timelineConnection);
  });

  it("URL-encodes the calendar date as one path segment", async () => {
    const get = vi.spyOn(apiClient, "get").mockResolvedValue(day as never);

    await getPersonalTimelineDay("2026/08/09 unsafe");

    expect(get).toHaveBeenCalledWith(`${API_ENDPOINTS.timelineDay}/2026%2F08%2F09%20unsafe`);
  });

  it("translates a known transport code without retaining private payload fields", async () => {
    vi.spyOn(apiClient, "get").mockRejectedValue(
      new ApiClientError(
        503,
        {
          error: "private upstream response",
          code: "TIMELINE_UPSTREAM_UNAVAILABLE",
          secret: "never-serialize-this",
        },
        17,
      ),
    );

    const error = await getTimelineConnection().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PersonalTimelineApiError);
    expect(error).toMatchObject({
      status: 503,
      code: "TIMELINE_UPSTREAM_UNAVAILABLE",
      retryAfterSeconds: 17,
    });
    expect(JSON.stringify(error)).not.toMatch(/private upstream|never-serialize/);
    expect(error).not.toHaveProperty("payload");
  });

  it("collapses unknown and malformed error codes to the safe null fallback", async () => {
    for (const payload of [{ code: "UNAUTHORIZED" }, { code: 42 }, null]) {
      vi.spyOn(apiClient, "get").mockRejectedValueOnce(new ApiClientError(401, payload, null));
      await expect(getTimelineConnection()).rejects.toMatchObject({
        status: 401,
        code: null,
        retryAfterSeconds: null,
      });
    }
  });

  it("collapses non-transport failures without retaining the thrown value", async () => {
    vi.spyOn(apiClient, "get").mockRejectedValue(new Error("private thrown value"));

    const error = await getTimelineConnection().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PersonalTimelineApiError);
    expect(error).toMatchObject({ status: 0, code: null, retryAfterSeconds: null });
    expect(JSON.stringify(error)).not.toContain("private thrown value");
  });
});
