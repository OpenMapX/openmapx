import { SafeFetchHttpError, type SafeJsonResponse } from "@openmapx/core/server";
import { describe, expect, it, vi } from "vitest";
import { currentUserFixture, timelineResponseFixture } from "../__fixtures__/timeline-day";
import { tracksPageFixture } from "../__fixtures__/tracks-page";
import { DawarichClient, DawarichClientError, type FetchJsonResponse } from "../client";

function response<T>(data: T, headers: Record<string, string> = {}): SafeJsonResponse<T> {
  return {
    data,
    text: JSON.stringify(data),
    status: 200,
    headers: new Headers(headers),
    finalUrl: "https://fixture.invalid/api",
  };
}

function clientWith(fetchJsonResponse: FetchJsonResponse): DawarichClient {
  return new DawarichClient({
    baseUrl: "https://fixture.invalid/untrusted/path?discard=true#fragment",
    apiKey: "fixture-token",
    allowPrivateHosts: ["fixture.invalid"],
    fetchJsonResponse,
  });
}

describe("DawarichClient", () => {
  it("normalizes the base URL and uses encoded Bearer JSON requests with the exact redirect host", async () => {
    const fetchJsonResponse = vi.fn(async () =>
      response(currentUserFixture),
    ) as unknown as FetchJsonResponse;
    const client = clientWith(fetchJsonResponse);

    const user = await client.getCurrentUser();

    expect(user.user.email).toBe("fixture@example.invalid");
    const [url, options] = vi.mocked(fetchJsonResponse).mock.calls[0];
    expect(url).toBe("https://fixture.invalid/api/v1/users/me");
    expect(options).toMatchObject({
      acceptedContentTypes: ["application/json"],
      allowedRedirectHosts: ["fixture.invalid"],
      allowedRedirectOrigin: "https://fixture.invalid",
      allowPrivateHosts: ["fixture.invalid"],
      timeoutMs: 10_000,
      maxBytes: 2 * 1024 * 1024,
    });
    expect(options.headers).toEqual({
      Accept: "application/json",
      Authorization: "Bearer fixture-token",
    });
  });

  it("encodes timeline ranges and validates returned runtime data", async () => {
    const fetchJsonResponse = vi.fn(async () =>
      response(timelineResponseFixture),
    ) as unknown as FetchJsonResponse;
    const client = clientWith(fetchJsonResponse);

    const timeline = await client.getTimeline(
      { startAt: "2026-01-02T00:00:00+01:00", endAt: "2026-01-02T23:59:59+01:00" },
      "km & miles",
    );

    expect(timeline.days[0].date).toBe("2026-01-02");
    expect(vi.mocked(fetchJsonResponse).mock.calls[0][0]).toContain("distance_unit=km+%26+miles");
    expect(vi.mocked(fetchJsonResponse).mock.calls[0][0]).toContain(
      "start_at=2026-01-02T00%3A00%3A00%2B01%3A00",
    );
  });

  it("reads case-insensitive bounded pagination headers for GeoJSON tracks", async () => {
    const fetchJsonResponse = vi.fn(async () =>
      response(tracksPageFixture, {
        "x-current-page": "1",
        "X-Total-Pages": "1",
        "x-total-count": "1",
      }),
    ) as unknown as FetchJsonResponse;
    const client = clientWith(fetchJsonResponse);

    const tracks = await client.getTracksPage(
      { startAt: "2026-01-02T00:00:00Z", endAt: "2026-01-03T00:00:00Z" },
      1,
    );

    expect(tracks.pagination).toEqual({ currentPage: 1, totalPages: 1, totalCount: 1 });
    expect(tracks.data.features).toHaveLength(1);
    const [url, options] = vi.mocked(fetchJsonResponse).mock.calls[0];
    expect(url).toContain("page=1");
    expect(url).toContain("per_page=500");
    expect(options).toMatchObject({
      maxBytes: 5 * 1024 * 1024,
      acceptedContentTypes: ["application/json", "application/geo+json"],
    });
  });

  it("accepts the explicit first-page empty result metadata", async () => {
    const emptyPage = vi.fn(async () =>
      response(
        { ...tracksPageFixture, features: [] },
        {
          "x-current-page": "1",
          "x-total-pages": "0",
          "x-total-count": "0",
        },
      ),
    ) as unknown as FetchJsonResponse;

    await expect(
      clientWith(emptyPage).getTracksPage(
        { startAt: "2026-01-02T00:00:00Z", endAt: "2026-01-03T00:00:00Z" },
        1,
      ),
    ).resolves.toMatchObject({ pagination: { currentPage: 1, totalPages: 0, totalCount: 0 } });
  });

  it.each([
    [401, "unauthorized"],
    [403, "forbidden"],
    [404, "unsupported"],
    [429, "rate_limited"],
    [503, "unavailable"],
  ] as const)("maps HTTP %i to a redacted %s error", async (status, kind) => {
    const fetchJsonResponse = vi.fn(async () => {
      throw new SafeFetchHttpError(
        status,
        "https://fixture.invalid/api",
        status === 429 ? 12 : null,
      );
    }) as unknown as FetchJsonResponse;

    try {
      await clientWith(fetchJsonResponse).getSettings();
      throw new Error("expected request to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(DawarichClientError);
      expect(error).toMatchObject({ kind, status, retryAfterSeconds: status === 429 ? 12 : null });
      expect((error as Error).message).not.toMatch(/fixture-token/);
    }
  });

  it("maps invalid upstream data and impossible pagination to typed errors", async () => {
    const invalidData = vi.fn(async () =>
      response({ settings: { timezone: "" }, status: "success" }),
    ) as unknown as FetchJsonResponse;
    await expect(clientWith(invalidData).getSettings()).rejects.toMatchObject({
      kind: "invalid_response",
    });

    const invalidPages = vi.fn(async () =>
      response(tracksPageFixture, {
        "x-current-page": "2",
        "x-total-pages": "1",
        "x-total-count": "1",
      }),
    ) as unknown as FetchJsonResponse;
    await expect(
      clientWith(invalidPages).getTracksPage(
        { startAt: "2026-01-02T00:00:00Z", endAt: "2026-01-03T00:00:00Z" },
        1,
      ),
    ).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it("classifies syntactically valid totals beyond configured caps as page_limit", async () => {
    const excessivePages = vi.fn(async () =>
      response(tracksPageFixture, {
        "x-current-page": "1",
        "x-total-pages": "21",
        "x-total-count": "10001",
      }),
    ) as unknown as FetchJsonResponse;

    await expect(
      clientWith(excessivePages).getTracksPage(
        { startAt: "2026-01-02T00:00:00Z", endAt: "2026-01-03T00:00:00Z" },
        1,
      ),
    ).rejects.toMatchObject({ kind: "page_limit" });
  });

  it("returns a validated oversized page only in explicit bounded-partial mode", async () => {
    const firstPage = {
      ...tracksPageFixture,
      features: Array.from({ length: 500 }, (_, index) => ({
        ...tracksPageFixture.features[0],
        properties: { id: `track-${index}` },
      })),
    };
    const excessivePages = vi.fn(async () =>
      response(firstPage, {
        "x-current-page": "1",
        "x-total-pages": "21",
        "x-total-count": "10001",
      }),
    ) as unknown as FetchJsonResponse;

    await expect(
      clientWith(excessivePages).getTracksPage(
        { startAt: "2026-01-02T00:00:00Z", endAt: "2026-01-03T00:00:00Z" },
        1,
        { overflowMode: "bounded-partial" },
      ),
    ).resolves.toMatchObject({
      data: { features: expect.arrayContaining([expect.any(Object)]) },
      pagination: { currentPage: 1, totalPages: 21, totalCount: 10_001 },
    });
  });

  it("rejects contradictory oversized pagination headers before applying caps", async () => {
    const contradictory = vi.fn(async () =>
      response(tracksPageFixture, {
        "x-current-page": "1",
        "x-total-pages": "21",
        "x-total-count": "1",
      }),
    ) as unknown as FetchJsonResponse;

    await expect(
      clientWith(contradictory).getTracksPage(
        { startAt: "2026-01-02T00:00:00Z", endAt: "2026-01-03T00:00:00Z" },
        1,
      ),
    ).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it("rejects contradictory page metadata and feature counts", async () => {
    const inconsistent = vi.fn(async () =>
      response(tracksPageFixture, {
        "x-current-page": "1",
        "x-total-pages": "1",
        "x-total-count": "501",
      }),
    ) as unknown as FetchJsonResponse;

    await expect(
      clientWith(inconsistent).getTracksPage(
        { startAt: "2026-01-02T00:00:00Z", endAt: "2026-01-03T00:00:00Z" },
        1,
      ),
    ).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it("enforces the explicit tracks page and feature bounds before returning data", async () => {
    const neverFetch = vi.fn() as unknown as FetchJsonResponse;
    await expect(
      clientWith(neverFetch).getTracksPage(
        { startAt: "2026-01-02T00:00:00Z", endAt: "2026-01-03T00:00:00Z" },
        21,
      ),
    ).rejects.toMatchObject({ kind: "page_limit" });

    const tooManyFeatures = vi.fn(async () =>
      response(
        {
          ...tracksPageFixture,
          features: Array.from({ length: 501 }, () => tracksPageFixture.features[0]),
        },
        {
          "x-current-page": "1",
          "x-total-pages": "1",
          "x-total-count": "501",
        },
      ),
    ) as unknown as FetchJsonResponse;
    await expect(
      clientWith(tooManyFeatures).getTracksPage(
        { startAt: "2026-01-02T00:00:00Z", endAt: "2026-01-03T00:00:00Z" },
        1,
      ),
    ).rejects.toMatchObject({ kind: "invalid_response" });
  });
});
