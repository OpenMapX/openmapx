import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "./client";
import {
  fetchRoadConditions,
  fetchRoadConditionsWithStatus,
  fetchRouteFlow,
  roadConditionFeatureToEvent,
} from "./roadConditions";

/** The least a transported situation needs to read back: id, classification, validity. */
const minimal = (properties: Record<string, unknown> = {}) => ({
  id: "status:1",
  kind: "roadworks",
  type: "works",
  validity: { status: "active" },
  ...properties,
});

const point = { type: "Point" as const, coordinates: [13.4, 52.5] };

describe("fetchRoadConditions", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("returns parsed events with an explicit success status", async () => {
    vi.spyOn(apiClient, "get").mockResolvedValue({
      features: [{ geometry: point, properties: minimal() }],
    } as never);

    await expect(fetchRoadConditionsWithStatus([13, 52, 14, 53])).resolves.toMatchObject({
      ok: true,
      events: [{ id: "status:1", kind: "roadworks", type: "works" }],
    });
  });

  it("returns a failed status without throwing when the request fails (transport throw)", async () => {
    vi.spyOn(apiClient, "get").mockRejectedValue(new Error("network"));

    await expect(fetchRoadConditionsWithStatus([13, 52, 14, 53])).resolves.toEqual({
      ok: false,
      events: [],
    });
  });

  it("returns a failed status when the server responds non-2xx", async () => {
    // `apiClient.get` throws on `!res.ok`, so this exercises the same catch
    // path as a transport failure — confirmed by reading `client.ts`, not
    // assumed.
    vi.spyOn(apiClient, "get").mockRejectedValue(new Error("API error 503: {}"));

    await expect(fetchRoadConditionsWithStatus([13, 52, 14, 53])).resolves.toEqual({
      ok: false,
      events: [],
    });
  });

  it("reports a genuine empty successful aggregation as ok: true with zero events", async () => {
    vi.spyOn(apiClient, "get").mockResolvedValue({
      type: "FeatureCollection",
      features: [],
    } as never);

    await expect(fetchRoadConditionsWithStatus([13, 52, 14, 53])).resolves.toEqual({
      ok: true,
      events: [],
    });
  });

  it("treats a non-object response body as a failure", async () => {
    vi.spyOn(apiClient, "get").mockResolvedValue(null as never);

    await expect(fetchRoadConditionsWithStatus([13, 52, 14, 53])).resolves.toEqual({
      ok: false,
      events: [],
    });
  });

  it("treats a `features` field that isn't an array as a failure", async () => {
    vi.spyOn(apiClient, "get").mockResolvedValue({ features: "nope" } as never);

    await expect(fetchRoadConditionsWithStatus([13, 52, 14, 53])).resolves.toEqual({
      ok: false,
      events: [],
    });
  });

  it("forwards an abort signal without serializing it as a query parameter", async () => {
    const spy = vi.spyOn(apiClient, "get").mockResolvedValue({ features: [] } as never);
    const controller = new AbortController();

    await fetchRoadConditionsWithStatus([13, 52, 14, 53], { signal: controller.signal });

    expect(spy).toHaveBeenCalledWith(
      "/api/integrations/road-conditions/events",
      { bbox: "13,52,14,53" },
      { signal: controller.signal },
    );
  });

  it("serializes the bbox + filters and parses the FeatureCollection to events", async () => {
    const spy = vi.spyOn(apiClient, "get").mockResolvedValue({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: point,
          properties: {
            id: "oc:situation:nl-ndw:1",
            source: "nl-ndw",
            provider: "road-conditions-openconditions",
            kind: "incident",
            type: "accident",
            severity: { label: "major", level: 4 },
            certainty: "observed",
            temporality: "live",
            planned: false,
            headline: [{ lang: "nl", text: "Ongeval op A1" }],
            description: [{ lang: "nl", text: "Twee auto's" }],
            groupId: "SITUATION_1",
            validity: { status: "active", start: "2026-09-11T08:00:00Z" },
            effects: [],
            origin: "feed",
            attribution: { provider: "NDW", license: "CC0-1.0" },
            fetchedAt: "2026-09-11T08:01:00Z",
          },
        },
      ],
    } as never);

    const out = await fetchRoadConditions([13.39, 52.49, 13.41, 52.51], {
      kinds: ["incident", "roadworks"],
      types: ["accident"],
      minSeverity: "moderate",
    });

    expect(spy).toHaveBeenCalledWith(
      "/api/integrations/road-conditions/events",
      expect.objectContaining({
        bbox: "13.39,52.49,13.41,52.51",
        kinds: "incident,roadworks",
        types: "accident",
        minSeverity: "moderate",
      }),
    );
    expect(out).toEqual([
      {
        id: "oc:situation:nl-ndw:1",
        source: "nl-ndw",
        provider: "road-conditions-openconditions",
        groupId: "SITUATION_1",
        kind: "incident",
        type: "accident",
        severity: { label: "major", level: 4 },
        certainty: "observed",
        temporality: "live",
        planned: false,
        headline: [{ lang: "nl", text: "Ongeval op A1" }],
        description: [{ lang: "nl", text: "Twee auto's" }],
        geometry: point,
        validity: { status: "active", start: "2026-09-11T08:00:00Z" },
        effects: [],
        origin: "feed",
        attribution: { provider: "NDW", license: "CC0-1.0" },
        fetchedAt: "2026-09-11T08:01:00Z",
      },
    ]);
  });

  it("sends horizonDays only when set", async () => {
    const spy = vi.spyOn(apiClient, "get").mockResolvedValue({ features: [] } as never);

    await fetchRoadConditions([0, 0, 1, 1], { horizonDays: 7 });
    expect(spy).toHaveBeenLastCalledWith(
      "/api/integrations/road-conditions/events",
      expect.objectContaining({ horizonDays: "7" }),
    );

    // `0` means "active now" — a falsy value that must still be sent.
    await fetchRoadConditions([0, 0, 1, 1], { horizonDays: 0 });
    expect(spy).toHaveBeenLastCalledWith(
      "/api/integrations/road-conditions/events",
      expect.objectContaining({ horizonDays: "0" }),
    );

    await fetchRoadConditions([0, 0, 1, 1]);
    expect(spy).toHaveBeenLastCalledWith(
      "/api/integrations/road-conditions/events",
      expect.not.objectContaining({ horizonDays: expect.anything() }),
    );
  });

  it("drops features without an id, geometry, classification or readable validity", async () => {
    vi.spyOn(apiClient, "get").mockResolvedValue({
      features: [
        { geometry: point, properties: minimal({ id: undefined }) },
        { geometry: null, properties: minimal({ id: "x" }) },
        { geometry: point, properties: minimal({ id: "no-kind", kind: undefined }) },
        { geometry: point, properties: minimal({ id: "no-type", type: "" }) },
        { geometry: point, properties: minimal({ id: "no-validity", validity: undefined }) },
        { geometry: point, properties: minimal({ id: "bad-validity", validity: { status: "x" } }) },
        { geometry: point, properties: minimal({ id: "kept" }) },
      ],
    } as never);
    const out = await fetchRoadConditions([0, 0, 1, 1]);
    expect(out.map((e) => e.id)).toEqual(["kept"]);
  });

  it("returns [] on transport error (never throws)", async () => {
    vi.spyOn(apiClient, "get").mockRejectedValue(new Error("network"));
    const out = await fetchRoadConditions([0, 0, 1, 1]);
    expect(out).toEqual([]);
  });
});

describe("roadConditionFeatureToEvent", () => {
  const read = (properties: Record<string, unknown>) =>
    roadConditionFeatureToEvent({ geometry: point, properties: minimal(properties) });

  it("reads unknown or missing enumerations conservatively", () => {
    expect(
      read({ severity: { label: "high" }, certainty: "sure", temporality: "soon", origin: "x" }),
    ).toMatchObject({
      severity: { label: "unknown" },
      certainty: "unknown",
      temporality: "live",
      planned: false,
      // An origin the host does not know never routes on its own.
      origin: "crowd",
      effects: [],
      attribution: { provider: "" },
      fetchedAt: "",
    });
  });

  it("carries timing, freshness, evidence and the publisher's texts through", () => {
    const event = read({
      source: "de-autobahn",
      temporality: "scheduled",
      planned: true,
      headline: [
        { lang: "de", text: "Baustelle" },
        { lang: "en", text: "Roadworks" },
        { lang: 3, text: "dropped" },
      ],
      validity: {
        status: "planned",
        start: "2026-10-05T06:00:00Z",
        end: "2026-10-09T18:00:00Z",
        periods: [{ startTime: "06:00", duration: "PT12H", scheduleTimezone: "Europe/Berlin" }],
      },
      origin: "crowd",
      evidence: { state: "corroborated", confidenceScore: 0.8, routingEligible: false },
      updatedAt: "2026-10-01T10:00:00Z",
      fetchedAt: "2026-10-01T10:01:00Z",
      expiresAt: "2026-10-01T10:11:00Z",
    });
    expect(event).toMatchObject({
      temporality: "scheduled",
      planned: true,
      headline: [
        { lang: "de", text: "Baustelle" },
        { lang: "en", text: "Roadworks" },
      ],
      validity: {
        status: "planned",
        start: "2026-10-05T06:00:00Z",
        periods: [{ startTime: "06:00", duration: "PT12H", scheduleTimezone: "Europe/Berlin" }],
      },
      origin: "crowd",
      evidence: { state: "corroborated", confidenceScore: 0.8, routingEligible: false },
      updatedAt: "2026-10-01T10:00:00Z",
      fetchedAt: "2026-10-01T10:01:00Z",
      expiresAt: "2026-10-01T10:11:00Z",
      // Attribution falls back to the source id when the provider gives no name.
      attribution: { provider: "de-autobahn" },
    });
  });

  it("validates effects one by one, keeping an unreadable one as unsupported evidence", () => {
    const event = read({
      effects: [
        {
          id: "r1/delay",
          kind: "delay",
          v: 1,
          applicability: { kind: "all" },
          compliance: "unknown",
          normalization: "complete",
          delay: { value: 900, unit: "s" },
        },
        { id: "r1/teleport", kind: "teleport", v: 1 },
        "garbage",
      ],
    });
    expect(event?.effects).toEqual([
      expect.objectContaining({ id: "r1/delay", kind: "delay", delay: { value: 900, unit: "s" } }),
      expect.objectContaining({
        id: "r1/teleport",
        kind: "unsupported",
        applicability: { kind: "unknown" },
        normalization: "unsupported",
      }),
      expect.objectContaining({ id: "effects[2]", kind: "unsupported" }),
    ]);
  });

  it("keeps only well-typed road and direction fields", () => {
    const event = read({
      roads: [
        { ref: "A1", name: [{ lang: "de", text: "Hansalinie" }], class: "motorway", from: 5 },
        { name: "not localized" },
        "A2",
      ],
      direction: { value: "positive", compass: "N", text: 7 },
    });
    expect(event?.roads).toEqual([
      { ref: "A1", name: [{ lang: "de", text: "Hansalinie" }], class: "motorway" },
    ]);
    expect(event?.direction).toEqual({ value: "positive", compass: "N" });
    expect(read({ roads: [{ name: "x" }], direction: { compass: "N" } })).not.toHaveProperty(
      "roads",
    );
    expect(read({ direction: { compass: "N" } })).not.toHaveProperty("direction");
  });

  it("carries routing evidence keyed by effect id, and nothing for display reads", () => {
    const evidence = { "r1/closure": { schema_version: 2, effect_id: "r1/closure" } };
    expect(read({ routingEvidence: evidence })?.routingEvidence).toEqual(evidence);
    expect(read({})).not.toHaveProperty("routingEvidence");
    expect(read({ routingEvidence: [] })).not.toHaveProperty("routingEvidence");
  });
});

describe("fetchRouteFlow", () => {
  it("keys the spans by the submitted route id", async () => {
    const post = vi.spyOn(apiClient, "post").mockResolvedValue({
      routes: [
        {
          id: "r0",
          spans: [{ startMeters: 10, endMeters: 90, los: "queuing", confidence: "measured" }],
        },
      ],
    });
    const result = await fetchRouteFlow([
      {
        id: "r0",
        geometry: [
          [8, 50],
          [8, 50.01],
        ],
      },
    ]);
    expect(result.r0[0].los).toBe("queuing");
    post.mockRestore();
  });

  it("returns an empty map on any failure — traffic must never break the route", async () => {
    const post = vi.spyOn(apiClient, "post").mockRejectedValue(new Error("boom"));
    expect(
      await fetchRouteFlow([
        {
          id: "r0",
          geometry: [
            [8, 50],
            [8, 50.01],
          ],
        },
      ]),
    ).toEqual({});
    post.mockRestore();
  });

  it("skips the request entirely when there is nothing to ask about", async () => {
    const post = vi.spyOn(apiClient, "post");
    expect(await fetchRouteFlow([])).toEqual({});
    expect(post).not.toHaveBeenCalled();
    post.mockRestore();
  });
});
