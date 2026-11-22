import { type MobileNavigationSession, routeFingerprint } from "@openmapx/core/navigation";
import { groundSessionFixture } from "../storage/testing/sessionFixture";
import { createRemoteWork, type RemoteWorkDeps } from "./createRemoteWork";
import type { RerouteOutcome } from "./ground/GroundRerouteService";
import { transitSessionFixture } from "./transit/testing/transitFixture";

const NOW = 1_700_000_100_000;

function activeGround(requestId: string | undefined, withFix = true): MobileNavigationSession {
  const base = groundSessionFixture({ status: "active" });
  return {
    ...base,
    ...(withFix
      ? { lastAcceptedFix: { coords: [8.685, 50.115], accuracy: 5, timestampMs: NOW } }
      : {}),
    payload: {
      ...base.payload,
      reroute: { status: "pending", attempts: 0, ...(requestId ? { requestId } : {}) },
    },
  } as MobileNavigationSession;
}

function harness(session: MobileNavigationSession | null) {
  const requests: Array<{ requestId: string; origin: [number, number] }> = [];
  const applied: RerouteOutcome[] = [];
  let aborts = 0;
  const deps: RemoteWorkDeps = {
    repository: { loadActive: async () => session },
    reroute: {
      request: async (request) => {
        requests.push({ requestId: request.requestId, origin: request.origin });
        return {
          ok: true,
          requestId: request.requestId,
          sessionId: request.session.sessionId,
          baseRevision: request.session.revision,
          route: {},
        };
      },
      abortAll: () => {
        aborts += 1;
      },
    },
    applyReroute: async (outcome) => {
      applied.push(outcome);
    },
    now: () => NOW,
    diagnostics: { record: () => undefined },
  };
  return { work: createRemoteWork(deps), requests, applied, aborts: () => aborts };
}

describe("createRemoteWork reroute", () => {
  it("requests from the raw last fix and hands the answer back", async () => {
    const { work, requests, applied, aborts } = harness(activeGround("r1"));

    await work.port.reroute("r1");
    await work.idle();

    expect(requests).toEqual([{ requestId: "r1", origin: [8.685, 50.115] }]);
    expect(applied.map((outcome) => outcome.requestId)).toEqual(["r1"]);
    // A newer request always supersedes whatever was still in flight.
    expect(aborts()).toBe(1);
  });

  it("does not start a request the session no longer wants", async () => {
    const { work, requests } = harness(activeGround("r2"));

    await work.port.reroute("r1");
    await work.idle();

    expect(requests).toEqual([]);
  });

  it("cannot reroute without a position to route from", async () => {
    const { work, requests } = harness(activeGround("r1", false));

    await work.port.reroute("r1");

    expect(requests).toEqual([]);
  });

  it("does nothing without an active session", async () => {
    const { work, requests } = harness(null);

    await work.port.reroute("r1");

    expect(requests).toEqual([]);
  });
});
it("runs native transit refresh through the remote-work production port", async () => {
  const session = transitSessionFixture();
  session.payload.refresh = { status: "in-flight", generation: 2, requestId: "r1", attempts: 0 };
  const request = jest.fn(async () => ({
    ok: false as const,
    sessionId: session.sessionId,
    requestId: "r1",
    generation: 2,
    failure: "ambiguous" as const,
  }));
  const apply = jest.fn();
  const work = createRemoteWork({
    repository: { loadActive: async () => session },
    reroute: { request: jest.fn(), abortAll: jest.fn() },
    applyReroute: jest.fn(),
    now: () => NOW,
    diagnostics: { record: jest.fn() },
    transitRefresh: { request },
    applyTransitRefresh: apply,
  });
  await work.port.transitRefresh("r1");
  await work.idle();
  expect(request).toHaveBeenCalledTimes(1);
  expect(apply).toHaveBeenCalledTimes(1);
});

describe("createRemoteWork voice references", () => {
  function referenceHarness(session: MobileNavigationSession | null) {
    const request = jest.fn(async ({ requestId }: { requestId: string }) => ({
      ok: false as const,
      requestId,
      sessionId: "session-1",
      code: "network" as const,
    }));
    const apply = jest.fn(async () => undefined);
    const work = createRemoteWork({
      repository: { loadActive: async () => session },
      reroute: { request: jest.fn(), abortAll: jest.fn() },
      applyReroute: jest.fn(),
      now: () => NOW,
      diagnostics: { record: jest.fn() },
      references: { request, abortAll: jest.fn() },
      applyReferences: apply,
    });
    return { work, request, apply };
  }

  it("asks for the references of the route the session still follows", async () => {
    const session = activeGround(undefined);
    if (session.kind !== "ground") throw new Error("not ground");
    const fingerprint = routeFingerprint(session.payload.startPackage.route.geometry);
    const { work, request, apply } = referenceHarness(session);

    await work.port.references?.(fingerprint);
    await work.idle();

    expect(request).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("does not ask for a route the session no longer follows", async () => {
    const { work, request } = referenceHarness(activeGround(undefined));

    await work.port.references?.("another-route");
    await work.idle();

    expect(request).not.toHaveBeenCalled();
  });
});
