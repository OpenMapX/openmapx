import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import type { PersonalTimelineDayV1 } from "../types/personalTimeline";
import { apiClient } from "./client";
import { API_ENDPOINTS } from "./endpoints";
import {
  connectTimeline,
  disconnectTimeline,
  getPersonalTimelineDay,
  getTimelineConnection,
  testTimelineConnection,
} from "./personalTimeline";

afterEach(() => vi.restoreAllMocks());

describe("personal timeline API", () => {
  it("types normalized map features with identifier-only properties", () => {
    type TrackProperties = PersonalTimelineDayV1["map"]["tracks"]["features"][number]["properties"];
    type VisitProperties = PersonalTimelineDayV1["map"]["visits"]["features"][number]["properties"];

    expectTypeOf<TrackProperties>().toEqualTypeOf<{ id: string }>();
    expectTypeOf<VisitProperties>().toEqualTypeOf<{ id: string }>();
  });

  it("gets connection metadata from the provider-neutral endpoint", async () => {
    const response = { connected: false };
    const get = vi.spyOn(apiClient, "get").mockResolvedValue(response as never);

    await expect(getTimelineConnection()).resolves.toBe(response);
    expect(get).toHaveBeenCalledWith(API_ENDPOINTS.timelineConnection);
  });

  it("connects, tests and disconnects through the connection endpoint", async () => {
    const request = {
      mode: "external" as const,
      instanceUrl: "https://timeline.example.test",
      apiKey: "fixture-key",
    };
    const put = vi.spyOn(apiClient, "put").mockResolvedValue({ connected: true } as never);
    const post = vi.spyOn(apiClient, "post").mockResolvedValue({ connected: true } as never);
    const deleteRequest = vi.spyOn(apiClient, "delete").mockResolvedValue({ ok: true } as never);

    await connectTimeline(request);
    await testTimelineConnection();
    await disconnectTimeline();

    expect(put).toHaveBeenCalledWith(API_ENDPOINTS.timelineConnection, request);
    expect(post).toHaveBeenCalledWith(API_ENDPOINTS.timelineConnectionTest, {});
    expect(deleteRequest).toHaveBeenCalledWith(API_ENDPOINTS.timelineConnection);
  });

  it("URL-encodes the calendar date as one path segment", async () => {
    const get = vi.spyOn(apiClient, "get").mockResolvedValue({ version: 1 } as never);

    await getPersonalTimelineDay("2026/08/09 unsafe");

    expect(get).toHaveBeenCalledWith(`${API_ENDPOINTS.timelineDay}/2026%2F08%2F09%20unsafe`);
  });
});
