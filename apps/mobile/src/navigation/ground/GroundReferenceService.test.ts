import { type GroundMobileSession, routeFingerprint } from "@openmapx/core/navigation";
import type { ApiClient } from "@openmapx/core/navigation/api";
import { groundSessionFixture } from "../../storage/testing/sessionFixture";
import { GroundReferenceService } from "./GroundReferenceService";

// Eastbound along 50.11°N, ~143 m per vertex: right turns at vertices 4 and 8.
const GEOMETRY: Array<[number, number]> = Array.from({ length: 13 }, (_, i) => [
  8.68 + i * 0.002,
  50.11,
]);
const turn = (index: number) => ({
  instruction: "Turn right",
  distance: 572,
  duration: 60,
  coordinates: GEOMETRY.slice(index, index + 5),
  bearingBefore: 90,
  bearingAfter: 180,
  maneuver: { type: "turn", modifier: "right" },
});

function session(mode: "driving" | "walking" = "driving"): GroundMobileSession {
  const base = groundSessionFixture({ status: "active" });
  return {
    ...base,
    payload: {
      ...base.payload,
      startPackage: {
        ...base.payload.startPackage,
        mode,
        route: {
          ...base.payload.startPackage.route,
          distance: 1_716,
          geometry: GEOMETRY,
          steps: [
            {
              instruction: "Head east",
              distance: 572,
              duration: 60,
              coordinates: GEOMETRY.slice(0, 5),
              maneuver: { type: "depart" },
            },
            turn(4),
            turn(8),
            { instruction: "Arrive", distance: 0, duration: 0, coordinates: [GEOMETRY[12]] },
          ],
        } as never,
      },
    },
  };
}

/** A match answer with one signal node at vertex 3, ~429 m along. */
const MATCH = {
  geometry: GEOMETRY,
  points: GEOMETRY.map(() => ({})),
  edges: [{ endShapeIndex: 3, endNodeTrafficSignal: true, wayId: 1 }],
  mode: "driving",
};

/** A fuel station on the right corner of the turn at vertex 4. */
function landmarkAnswer(points: { lat: number; lon: number }[]) {
  return {
    results: points.map((point, i) =>
      i === 0
        ? {
            candidates: [
              { category: "fuel", brand: "Aral", lat: point.lat - 0.0001, lon: point.lon - 0.0001 },
            ],
          }
        : { candidates: [] },
    ),
  };
}

function fakeClient(
  answer: (path: string, body: { points?: { lat: number; lon: number }[] }) => unknown,
) {
  const calls: Array<{ path: string; body: unknown; options: unknown }> = [];
  const client = {
    post: async (path: string, body: never, options: unknown) => {
      calls.push({ path, body, options });
      const result = answer(path, body);
      if (result instanceof Error) throw result;
      return result;
    },
  } as unknown as ApiClient;
  return { client, calls };
}

const answerAll = (path: string, body: { points?: { lat: number; lon: number }[] }) =>
  path.endsWith("/match") ? MATCH : landmarkAnswer(body.points ?? []);

describe("GroundReferenceService", () => {
  it("fetches the first window and its landmarks", async () => {
    const { client, calls } = fakeClient(answerAll);
    const outcome = await new GroundReferenceService({ apiOrigin: "https://x", client }).request({
      requestId: "q1",
      session: session(),
    });

    expect(outcome).toMatchObject({
      ok: true,
      requestId: "q1",
      sessionId: "session-1",
      routeFingerprint: routeFingerprint(GEOMETRY),
      signalSpans: [{ from: 0, to: expect.closeTo(1_716, -1) }],
      landmarkReferences: [{ stepIndex: 1, category: "fuel", brand: "Aral" }],
    });
    if (!outcome.ok) return;
    expect(outcome.signalsAlong).toHaveLength(1);
    expect(outcome.signalsAlong?.[0]).toBeCloseTo(429, -1);
    expect(calls.map((call) => call.path).sort()).toEqual([
      "/api/integrations/routing/match",
      "/api/integrations/routing/navigation/landmarks",
    ]);
    const landmarkCall = calls.find((call) => call.path.endsWith("/landmarks"));
    expect((landmarkCall?.body as { points: unknown[] }).points).toHaveLength(2);
  });

  it("sends its requests with credentials omitted", async () => {
    const fetchMock = jest.fn(
      async (url: string) =>
        new Response(
          JSON.stringify(url.endsWith("/match") ? MATCH : landmarkAnswer([{ lat: 0, lon: 0 }])),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const original = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      await new GroundReferenceService({ apiOrigin: "https://openmapx.example" }).request({
        requestId: "q1",
        session: session(),
      });
    } finally {
      globalThis.fetch = original;
    }
    expect(fetchMock).toHaveBeenCalled();
    for (const [, init] of fetchMock.mock.calls as unknown as Array<[string, RequestInit]>) {
      expect(init.credentials).toBe("omit");
    }
  });

  it("keeps the landmarks when the match fails", async () => {
    const { client } = fakeClient((path, body) =>
      path.endsWith("/match") ? new Error("no matcher") : landmarkAnswer(body.points ?? []),
    );
    const outcome = await new GroundReferenceService({ apiOrigin: "https://x", client }).request({
      requestId: "q1",
      session: session(),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.signalsAlong).toBeUndefined();
    expect(outcome.signalSpans).toBeUndefined();
    expect(outcome.landmarkReferences).toHaveLength(1);
  });

  it("a failed native fetch gives plain prompts", async () => {
    const { client } = fakeClient(() => new Error("offline"));
    const outcome = await new GroundReferenceService({ apiOrigin: "https://x", client }).request({
      requestId: "q1",
      session: session(),
    });
    expect(outcome).toEqual({
      ok: false,
      requestId: "q1",
      sessionId: "session-1",
      code: "network",
    });
  });

  it("asks nothing for a walking session", async () => {
    const { client, calls } = fakeClient(answerAll);
    const outcome = await new GroundReferenceService({ apiOrigin: "https://x", client }).request({
      requestId: "q1",
      session: session("walking"),
    });
    expect(outcome).toMatchObject({ ok: false, code: "unsupported" });
    expect(calls).toHaveLength(0);
  });

  it("reports an aborted request", async () => {
    const pendingRequests: Array<() => void> = [];
    const { client } = fakeClient(
      () =>
        new Promise((_, reject) => {
          pendingRequests.push(() => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    const service = new GroundReferenceService({ apiOrigin: "https://x", client });
    const pending = service.request({ requestId: "q1", session: session() });
    service.abortAll();
    for (const reject of pendingRequests) reject();
    expect(await pending).toMatchObject({ ok: false, code: "aborted" });
  });
});
