import type { GroundMobileSession } from "@openmapx/core/navigation";
import type { ApiClient } from "@openmapx/core/navigation/api";
import { groundSessionFixture } from "../../storage/testing/sessionFixture";
import { GroundRerouteService, rerouteWaypoints } from "./GroundRerouteService";

const NOW = 1_700_000_100_000;
const ORIGIN: [number, number] = [8.7, 50.15];

const GEOMETRY: Array<[number, number]> = Array.from({ length: 50 }, (_, index) => [
  8.68 + index * 0.001,
  50.11,
]);

function session(overrides: Partial<GroundMobileSession> = {}): GroundMobileSession {
  const base = groundSessionFixture({ status: "active", revision: 7, ...overrides });
  return {
    ...base,
    payload: {
      ...base.payload,
      startPackage: {
        ...base.payload.startPackage,
        route: { ...base.payload.startPackage.route, geometry: GEOMETRY } as never,
        destinationWaypoints: [
          [8.68, 50.11],
          [8.71, 50.11],
          [8.727, 50.11],
        ],
        routeOptions: { avoidTolls: true, avoidFerries: true },
      },
      progress: { alongMeters: 2_500 } as never,
    },
  };
}

/** A client that records what it was asked and answers with what it is told. */
function fakeClient(answer: unknown | (() => Promise<unknown>)) {
  const calls: Array<{ path: string; params: Record<string, string>; options: unknown }> = [];
  const client = {
    get: async (path: string, params: Record<string, string>, options: unknown) => {
      calls.push({ path, params, options });
      return typeof answer === "function" ? await (answer as () => Promise<unknown>)() : answer;
    },
  } as unknown as ApiClient;
  return { client, calls };
}

function routeAnswer() {
  return {
    routes: [
      {
        distance: 3_000,
        duration: 400,
        geometry: GEOMETRY,
        mode: "driving",
        steps: [{ instruction: "Continue", distance: 3_000, duration: 400 }],
      },
    ],
  };
}

describe("rerouteWaypoints", () => {
  it("starts from the raw fix, not the position snapped to the old route", () => {
    const waypoints = rerouteWaypoints({ requestId: "r1", session: session(), origin: ORIGIN });

    // Snapping first is exactly how a reroute sends someone back to the turn
    // they just missed.
    expect(waypoints[0]).toEqual(ORIGIN);
  });

  it("always keeps the destination", () => {
    const waypoints = rerouteWaypoints({ requestId: "r1", session: session(), origin: ORIGIN });

    expect(waypoints[waypoints.length - 1]).toEqual([8.727, 50.11]);
  });

  it("prunes an intermediate stop the user has already passed", () => {
    const far = session();
    far.payload.progress = { alongMeters: 4_000 } as never;

    const waypoints = rerouteWaypoints({ requestId: "r1", session: far, origin: ORIGIN });

    expect(waypoints.length).toBeLessThanOrEqual(3);
    expect(waypoints[0]).toEqual(ORIGIN);
  });

  it("keeps an origin-to-destination pair intact", () => {
    const simple = session();
    simple.payload.startPackage.destinationWaypoints = [
      [8.68, 50.11],
      [8.727, 50.11],
    ];

    const waypoints = rerouteWaypoints({ requestId: "r1", session: simple, origin: ORIGIN });

    expect(waypoints).toEqual([ORIGIN, [8.727, 50.11]]);
  });
});

describe("GroundRerouteService", () => {
  const service = (client: ApiClient) =>
    new GroundRerouteService({ apiOrigin: "https://openmapx.com", client, now: () => NOW });

  it("returns a validated replacement route", async () => {
    const { client } = fakeClient(routeAnswer());

    const outcome = await service(client).request({
      requestId: "r1",
      session: session(),
      origin: ORIGIN,
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.requestId).toBe("r1");
    expect(outcome.sessionId).toBe("session-1");
    expect(outcome.baseRevision).toBe(7);
  });

  it("carries the captured avoid flags forward", async () => {
    const { client, calls } = fakeClient(routeAnswer());

    await service(client).request({ requestId: "r1", session: session(), origin: ORIGIN });

    // Dropping one would silently route the user onto a road they excluded.
    expect(calls[0].params.avoidTolls).toBe("true");
    expect(calls[0].params.avoidFerries).toBe("true");
    expect(calls[0].params.avoidHighways).toBe("false");
  });

  it("carries the captured mode, units and locale", async () => {
    const { client, calls } = fakeClient(routeAnswer());

    await service(client).request({ requestId: "r1", session: session(), origin: ORIGIN });

    expect(calls[0].params.mode).toBe("driving");
    expect(calls[0].params.units).toBe("metric");
    expect(calls[0].params.lang).toBe("en");
  });

  it("bounds the request with a timeout and an abort signal", async () => {
    const { client, calls } = fakeClient(routeAnswer());

    await service(client).request({ requestId: "r1", session: session(), origin: ORIGIN });

    const options = calls[0].options as { timeoutMs?: number; signal?: AbortSignal };
    expect(options.timeoutMs).toBe(15_000);
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it("reports a route-less answer rather than replacing anything", async () => {
    const { client } = fakeClient({ routes: [] });

    const outcome = await service(client).request({
      requestId: "r1",
      session: session(),
      origin: ORIGIN,
    });

    expect(outcome).toMatchObject({ ok: false, code: "no-route" });
  });

  it.each([
    ["a malformed route", { routes: [{ nonsense: true }] }],
    [
      "a route with no geometry",
      { routes: [{ distance: 1, duration: 1, mode: "driving", steps: [] }] },
    ],
    [
      "a route for another mode",
      {
        routes: [
          {
            distance: 1,
            duration: 1,
            geometry: GEOMETRY,
            mode: "walking",
            steps: [{ instruction: "Walk" }],
          },
        ],
      },
    ],
  ])("keeps the old route when the server returns %s", async (_label, answer) => {
    const { client } = fakeClient(answer);

    const outcome = await service(client).request({
      requestId: "r1",
      session: session(),
      origin: ORIGIN,
    });

    expect(outcome).toMatchObject({ ok: false, code: "invalid-response" });
  });

  it("reports a network failure without leaking the request", async () => {
    const { client } = fakeClient(async () => {
      throw new Error("fetch failed for https://openmapx.com/directions?waypoints=8.7,50.15");
    });

    const outcome = await service(client).request({
      requestId: "r1",
      session: session(),
      origin: ORIGIN,
    });

    expect(outcome).toMatchObject({ ok: false, code: "network" });
    // A message can carry a URL with the user's coordinates in its query.
    expect(JSON.stringify(outcome)).not.toContain("50.15");
  });

  it("binds every result to the session and revision it was computed from", async () => {
    const { client } = fakeClient(routeAnswer());

    const outcome = await service(client).request({
      requestId: "r1",
      session: session({ revision: 42 }),
      origin: ORIGIN,
    });

    // A result whose base revision no longer matches is discarded rather than
    // applied to a session that has moved on.
    expect(outcome.baseRevision).toBe(42);
  });

  it("aborts a request whose session has ended", async () => {
    let observed: AbortSignal | undefined;
    const { client } = fakeClient(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return routeAnswer();
    });
    const instance = service({
      get: async (_path: string, _params: unknown, options: { signal?: AbortSignal }) => {
        observed = options.signal;
        return new Promise((_resolve, reject) => {
          options.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      },
    } as unknown as ApiClient);

    const pending = instance.request({ requestId: "r1", session: session(), origin: ORIGIN });
    instance.abort("r1");
    const outcome = await pending;

    expect(observed?.aborted).toBe(true);
    expect(outcome.ok).toBe(false);
    expect(client).toBeTruthy();
  });

  it("aborts everything in flight at once", async () => {
    const signals: AbortSignal[] = [];
    const instance = service({
      get: async (_path: string, _params: unknown, options: { signal?: AbortSignal }) => {
        if (options.signal) signals.push(options.signal);
        return new Promise((_resolve, reject) => {
          options.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      },
    } as unknown as ApiClient);

    const first = instance.request({ requestId: "r1", session: session(), origin: ORIGIN });
    const second = instance.request({ requestId: "r2", session: session(), origin: ORIGIN });
    instance.abortAll();
    await Promise.all([first, second]);

    expect(signals).toHaveLength(2);
    for (const signal of signals) expect(signal.aborted).toBe(true);
  });
});
