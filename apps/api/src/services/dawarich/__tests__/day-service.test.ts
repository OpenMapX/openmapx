import { beforeEach, describe, expect, it, vi } from "vitest";
import { timelineResponseFixture } from "../__fixtures__/timeline-day.js";
import { tracksPageFixture } from "../__fixtures__/tracks-page.js";
import { DawarichClientError, type DawarichTracksPage } from "../client.js";
import { TimelineConnectionError, type TimelineConnectionSnapshot } from "../connection-service.js";
import { TimelineDayService } from "../day-service.js";

const USER_ID = "user-day";
const SNAPSHOT: TimelineConnectionSnapshot = {
  id: "connection-day",
  credentialGeneration: "opaque-ciphertext-generation-a",
};
const REFRESHED_SNAPSHOT: TimelineConnectionSnapshot = {
  id: "connection-day",
  credentialGeneration: "opaque-ciphertext-generation-a",
};

function credential(overrides: Record<string, unknown> = {}) {
  return {
    mode: "external" as const,
    publicOrigin: "https://timeline.example.test",
    upstreamBaseUrl: "https://timeline.example.test",
    hostname: "timeline.example.test",
    apiKey: "fixture-secret-key",
    timeZone: "Etc/UTC",
    distanceUnit: "km",
    allowPrivateHosts: [] as string[],
    connectionSnapshot: SNAPSHOT,
    ...overrides,
  };
}

function emptyTracksPage(): DawarichTracksPage {
  return {
    data: { type: "FeatureCollection" as const, features: [] },
    pagination: { currentPage: 1, totalPages: 0, totalCount: 0 },
  };
}

function trackFeatures(count: number, prefix: string) {
  return Array.from({ length: count }, (_, index) => ({
    ...tracksPageFixture.features[0],
    properties: { id: `${prefix}-${index}` },
  }));
}

function harness(connectionOverrides: Record<string, unknown> = {}) {
  const connection = {
    decryptConnectionCredential: vi.fn(async () => credential()),
    updateReadMetadata: vi.fn(async () => REFRESHED_SNAPSHOT),
    recordReadSuccess: vi.fn(async () => {}),
    recordReadFailure: vi.fn(async () => {}),
    ...connectionOverrides,
  };
  const client = {
    getSettings: vi.fn(async () => ({
      settings: { timezone: "Etc/UTC", maps: { distance_unit: "km" } },
      status: "success",
    })),
    getTimeline: vi.fn(async () => timelineResponseFixture),
    getTracksPage: vi.fn(
      async (
        _range: { startAt: string; endAt: string },
        _page: number,
      ): Promise<DawarichTracksPage> => emptyTracksPage(),
    ),
  };
  const clientOptions: unknown[] = [];
  const service = new TimelineDayService({
    connectionService: connection,
    clientFactory: (options) => {
      clientOptions.push(options);
      return client;
    },
  });
  return { service, connection, client, clientOptions };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("TimelineDayService", () => {
  it.each(["TIMELINE_NOT_CONNECTED", "TIMELINE_MANAGED_DISABLED"] as const)(
    "preserves connection error %s without creating an upstream client",
    async (code) => {
      const clientFactory = vi.fn();
      const connection = {
        decryptConnectionCredential: vi.fn(async () => {
          throw new TimelineConnectionError(code);
        }),
        updateReadMetadata: vi.fn(),
        recordReadSuccess: vi.fn(),
        recordReadFailure: vi.fn(),
      };
      const service = new TimelineDayService({ connectionService: connection, clientFactory });

      await expect(service.getPersonalTimelineDay(USER_ID, "2026-01-02")).rejects.toMatchObject({
        code,
      });
      expect(clientFactory).not.toHaveBeenCalled();
      expect(connection.recordReadSuccess).not.toHaveBeenCalled();
    },
  );

  it("uses exact timezone instants and records success against the connection snapshot", async () => {
    const { service, connection, client, clientOptions } = harness();

    const day = await service.getPersonalTimelineDay(USER_ID, "2026-01-02");

    expect(clientOptions).toEqual([
      {
        baseUrl: "https://timeline.example.test",
        apiKey: "fixture-secret-key",
        allowPrivateHosts: [],
      },
    ]);
    expect(client.getTimeline).toHaveBeenCalledWith(
      {
        startAt: "2026-01-02T00:00:00Z",
        endAt: "2026-01-02T23:59:59.999999999Z",
      },
      "km",
    );
    expect(day).toMatchObject({ version: 1, date: "2026-01-02", timeZone: "Etc/UTC" });
    expect(connection.recordReadSuccess).toHaveBeenCalledWith(USER_ID, SNAPSHOT);
    expect(connection.recordReadFailure).not.toHaveBeenCalled();
  });

  it("refreshes missing settings once and carries the refreshed snapshot into success", async () => {
    const { service, connection, client } = harness({
      decryptConnectionCredential: vi.fn(async () =>
        credential({ timeZone: "", distanceUnit: null }),
      ),
    });
    client.getSettings.mockResolvedValueOnce({
      settings: { timezone: "Europe/Berlin", maps: { distance_unit: "mi" } },
      status: "success",
    });
    client.getTimeline.mockResolvedValueOnce({
      days: [{ ...timelineResponseFixture.days[0], date: "2026-03-29" }],
    });

    const day = await service.getPersonalTimelineDay(USER_ID, "2026-03-29");

    expect(client.getSettings).toHaveBeenCalledOnce();
    expect(connection.updateReadMetadata).toHaveBeenCalledWith(USER_ID, SNAPSHOT, {
      timeZone: "Europe/Berlin",
      distanceUnit: "mi",
    });
    expect(client.getTimeline).toHaveBeenCalledWith(
      {
        startAt: "2026-03-28T23:00:00Z",
        endAt: "2026-03-29T21:59:59.999999999Z",
      },
      "mi",
    );
    expect(day).toMatchObject({ timeZone: "Europe/Berlin", distanceUnit: "mi" });
    expect(connection.recordReadSuccess).toHaveBeenCalledWith(USER_ID, REFRESHED_SNAPSHOT);
  });

  it.each([
    { kind: "unauthorized", code: "TIMELINE_CREDENTIAL_INVALID", failure: "credential_invalid" },
    { kind: "unavailable", code: "TIMELINE_UPSTREAM_UNAVAILABLE", failure: "transient" },
  ] as const)(
    "records required settings $kind failures against the credential generation",
    async (testCase) => {
      const { service, connection, client } = harness({
        decryptConnectionCredential: vi.fn(async () => credential({ distanceUnit: null })),
      });
      client.getSettings.mockRejectedValueOnce(new DawarichClientError(testCase.kind));

      await expect(service.getPersonalTimelineDay(USER_ID, "2026-01-02")).rejects.toMatchObject({
        code: testCase.code,
      });
      expect(connection.recordReadFailure).toHaveBeenCalledWith(
        USER_ID,
        SNAPSHOT,
        testCase.failure,
      );
      expect(connection.recordReadSuccess).not.toHaveBeenCalled();
      expect(client.getTimeline).not.toHaveBeenCalled();
    },
  );

  it.each([
    { kind: "unauthorized", code: "TIMELINE_CREDENTIAL_INVALID", failure: "credential_invalid" },
    { kind: "forbidden", code: "TIMELINE_PLAN_RESTRICTED", failure: null },
    { kind: "unsupported", code: "TIMELINE_INSTANCE_UNSUPPORTED", failure: null },
    { kind: "rate_limited", code: "TIMELINE_RATE_LIMITED", failure: null, retry: 17 },
    { kind: "unavailable", code: "TIMELINE_UPSTREAM_UNAVAILABLE", failure: "transient" },
    { kind: "invalid_response", code: "TIMELINE_RESPONSE_INVALID", failure: null },
    { kind: "page_limit", code: "TIMELINE_RESPONSE_INVALID", failure: null },
  ] as const)("maps required timeline $kind failures to $code", async (testCase) => {
    const { service, connection, client } = harness();
    client.getTimeline.mockRejectedValueOnce(
      new DawarichClientError(testCase.kind, null, testCase.retry ?? null),
    );

    await expect(service.getPersonalTimelineDay(USER_ID, "2026-01-02")).rejects.toMatchObject({
      code: testCase.code,
      retryAfterSeconds: testCase.retry ?? null,
    });
    expect(connection.recordReadSuccess).not.toHaveBeenCalled();
    if (testCase.failure) {
      expect(connection.recordReadFailure).toHaveBeenCalledWith(
        USER_ID,
        SNAPSHOT,
        testCase.failure,
      );
    } else {
      expect(connection.recordReadFailure).not.toHaveBeenCalled();
    }
  });

  it("returns a normalized empty day when the required endpoint has no day", async () => {
    const { service, client } = harness();
    client.getTimeline.mockResolvedValueOnce({ days: [] });

    await expect(service.getPersonalTimelineDay(USER_ID, "2026-01-02")).resolves.toEqual({
      version: 1,
      date: "2026-01-02",
      timeZone: "Etc/UTC",
      distanceUnit: "km",
      summary: { totalDistance: 0, placesVisited: 0, movingMinutes: 0, stationaryMinutes: 0 },
      bounds: null,
      entries: [],
      map: {
        tracks: { type: "FeatureCollection", features: [] },
        visits: { type: "FeatureCollection", features: [] },
      },
      capabilities: { trackGeometry: false, elevation: false },
      warnings: [],
    });
  });

  it("combines every bounded tracks page with the required timeline", async () => {
    const { service, client } = harness();
    client.getTracksPage
      .mockResolvedValueOnce({
        data: { ...tracksPageFixture, features: trackFeatures(500, "fixture-page-1") },
        pagination: { currentPage: 1, totalPages: 2, totalCount: 501 },
      })
      .mockResolvedValueOnce({
        data: { ...tracksPageFixture, features: trackFeatures(1, "fixture-page-2") },
        pagination: { currentPage: 2, totalPages: 2, totalCount: 501 },
      });

    const day = await service.getPersonalTimelineDay(USER_ID, "2026-01-02");

    expect(client.getTracksPage).toHaveBeenCalledTimes(2);
    expect(day.map.tracks.features).toHaveLength(501);
    expect(day.capabilities.trackGeometry).toBe(true);
    expect(day.warnings).toEqual([]);
  });

  it("keeps validated geometry and warns when a later tracks page fails", async () => {
    const { service, connection, client } = harness();
    client.getTracksPage
      .mockResolvedValueOnce({
        data: { ...tracksPageFixture, features: trackFeatures(500, "fixture-partial") },
        pagination: { currentPage: 1, totalPages: 2, totalCount: 501 },
      })
      .mockRejectedValueOnce(new DawarichClientError("unavailable", 503));

    const day = await service.getPersonalTimelineDay(USER_ID, "2026-01-02");

    expect(day.map.tracks.features).toHaveLength(500);
    expect(day.warnings).toEqual(["TRACK_GEOMETRY_UNAVAILABLE"]);
    expect(connection.recordReadSuccess).toHaveBeenCalledWith(USER_ID, SNAPSHOT);
    expect(connection.recordReadFailure).not.toHaveBeenCalled();
  });

  it("keeps accepted pages and warns when the client reports the page cap", async () => {
    const { service, client } = harness();
    client.getTracksPage
      .mockResolvedValueOnce({
        data: { ...tracksPageFixture, features: trackFeatures(500, "fixture-capped") },
        pagination: { currentPage: 1, totalPages: 2, totalCount: 501 },
      })
      .mockRejectedValueOnce(new DawarichClientError("page_limit"));

    const day = await service.getPersonalTimelineDay(USER_ID, "2026-01-02");

    expect(day.map.tracks.features).toHaveLength(500);
    expect(day.warnings).toEqual(["PARTIAL_TRACK_PAGE_LIMIT"]);
  });

  it("stops at the configured page cap and retains the bounded partial result", async () => {
    const { service, client } = harness();
    client.getTracksPage.mockImplementation(async (_range, page) => ({
      data: {
        ...tracksPageFixture,
        features: trackFeatures(500, `fixture-track-${page}`),
      },
      pagination: { currentPage: page, totalPages: 21, totalCount: 10_500 },
    }));

    const day = await service.getPersonalTimelineDay(USER_ID, "2026-01-02");

    expect(client.getTracksPage).toHaveBeenCalledTimes(20);
    expect(day.map.tracks.features).toHaveLength(10_000);
    expect(day.warnings).toEqual(["PARTIAL_TRACK_PAGE_LIMIT"]);
  });

  it("treats a mismatched required day as an invalid response without recording success", async () => {
    const { service, connection, client } = harness();
    client.getTimeline.mockResolvedValueOnce({
      days: [{ ...timelineResponseFixture.days[0], date: "2026-01-03" }],
    });

    await expect(service.getPersonalTimelineDay(USER_ID, "2026-01-02")).rejects.toMatchObject({
      code: "TIMELINE_RESPONSE_INVALID",
    });
    expect(connection.recordReadSuccess).not.toHaveBeenCalled();
  });
});
