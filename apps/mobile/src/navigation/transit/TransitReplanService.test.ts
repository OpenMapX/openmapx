import type { TransitMobileSession } from "@openmapx/core/navigation";
import { type ApiClient, ApiRequestAbortedError } from "@openmapx/core/navigation/api";
import {
  MAX_CONSECUTIVE_FAILURES,
  RETRY_DELAYS_MS,
  replanDestination,
  replanParams,
  replanRetryDelayMs,
  TransitReplanService,
} from "./TransitReplanService";
import { transitItineraryFixture, transitSessionFixture } from "./testing/transitFixture";

const NOW = new Date("2026-08-09T08:20:00Z").getTime();
const ORIGIN: [number, number] = [8.7, 50.13];

const CAPTURED_OPTIONS = {
  wheelchair: true,
  maxTransfers: 2,
  transferBufferSeconds: 300,
  bikeTransport: "none",
  deutschlandticket: true,
  modes: ["rail", "subway"],
};

function session(overrides: Partial<TransitMobileSession> = {}): TransitMobileSession {
  const base = transitSessionFixture(overrides);
  return {
    ...base,
    payload: {
      ...base.payload,
      startPackage: {
        ...base.payload.startPackage,
        replanOptions: CAPTURED_OPTIONS,
      },
      ...(overrides.payload ?? {}),
    },
  } as TransitMobileSession;
}

function fakeClient(handlers: { plan?: () => Promise<unknown>; journey?: () => Promise<unknown> }) {
  const calls: Array<{ path: string; params: unknown }> = [];
  const client = {
    get: async (path: string, params: unknown) => {
      calls.push({ path, params });
      if (path.includes("journey") || path.includes("vehicle")) {
        if (!handlers.journey) return { data: { stops: [] } };
        return handlers.journey();
      }
      if (!handlers.plan) throw new Error("no plan handler");
      return handlers.plan();
    },
  } as unknown as ApiClient;
  return { client, calls };
}

const service = (client: ApiClient) =>
  new TransitReplanService({ apiOrigin: "https://openmapx.com", client });

const request = (overrides: Partial<Parameters<TransitReplanService["request"]>[0]> = {}) => ({
  requestId: "p1",
  generation: 2,
  session: session(),
  origin: ORIGIN,
  nowMs: NOW,
  ...overrides,
});

const planAnswer = async () => ({ data: { itineraries: [transitItineraryFixture()] } });

describe("replanDestination", () => {
  it("uses the last leg's destination", () => {
    expect(replanDestination(session())).toEqual([8.68, 50.11]);
  });

  it("has none when the plan ends nowhere locatable", () => {
    const vague = session();
    const legs = (vague.payload.startPackage.itinerary as { legs: Array<{ to: unknown }> }).legs;
    legs[legs.length - 1].to = { name: "Somewhere" };

    expect(replanDestination(vague)).toBeNull();
  });
});

describe("replanParams", () => {
  it("starts from the raw fix, not from where the plan said the rider would be", () => {
    expect(replanParams(request()).origin).toEqual(ORIGIN);
  });

  it("keeps the destination the rider was heading to", () => {
    expect(replanParams(request()).destination).toEqual([8.68, 50.11]);
  });

  it("carries every captured option forward", () => {
    // Dropping the wheelchair requirement would replan the trip as if the rider
    // had asked for something they did not.
    const params = replanParams(request());

    for (const [key, value] of Object.entries(CAPTURED_OPTIONS)) {
      expect(params[key]).toEqual(value);
    }
  });

  it("asks to depart now rather than at the original time", () => {
    expect(replanParams(request()).time).toBe(new Date(NOW).toISOString());
  });

  it("carries the session's locale", () => {
    expect(replanParams(request({ session: session({ locale: "de" }) })).lang).toBe("de");
  });
});

describe("TransitReplanService.request", () => {
  it("returns a complete validated replacement package", async () => {
    const { client } = fakeClient({ plan: planAnswer });

    const outcome = await service(client).request(request());

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const built = outcome.startPackage as { kind: string; itineraryFingerprint: string };
    expect(built.kind).toBe("transit");
    expect(built.itineraryFingerprint).toEqual(expect.any(String));
  });

  it("binds the result to the generation and request that asked for it", async () => {
    const { client } = fakeClient({ plan: planAnswer });

    const outcome = await service(client).request(request({ generation: 7, requestId: "p7" }));

    expect(outcome.generation).toBe(7);
    expect(outcome.requestId).toBe("p7");
    expect(outcome.sessionId).toBe("session-t1");
  });

  it("keeps the captured trip when the server has nothing to offer", async () => {
    const { client } = fakeClient({ plan: async () => ({ data: { itineraries: [] } }) });

    expect(await service(client).request(request())).toMatchObject({
      ok: false,
      code: "no-result",
    });
  });

  it("keeps the captured trip when the result cannot be built into a package", async () => {
    const { client } = fakeClient({
      plan: async () => ({ data: { itineraries: [{ legs: [] }] } }),
    });

    expect(await service(client).request(request())).toMatchObject({
      ok: false,
      code: "invalid-result",
    });
  });

  it("does not ask at all when the plan has no locatable destination", async () => {
    const { client, calls } = fakeClient({ plan: planAnswer });
    const vague = session();
    const legs = (vague.payload.startPackage.itinerary as { legs: Array<{ to: unknown }> }).legs;
    legs[legs.length - 1].to = { name: "Somewhere" };

    const outcome = await service(client).request(request({ session: vague }));

    expect(outcome).toMatchObject({ ok: false, code: "invalid-result" });
    expect(calls).toEqual([]);
  });

  it.each([
    ["timeout", "timeout"],
    ["aborted", "aborted"],
  ] as const)("reports a %s as its own outcome", async (code, expected) => {
    const { client } = fakeClient({
      plan: async () => {
        throw new ApiRequestAbortedError(code);
      },
    });

    expect(await service(client).request(request())).toMatchObject({ ok: false, code: expected });
  });

  it("reports a network failure without leaking the request", async () => {
    const { client } = fakeClient({
      plan: async () => {
        throw new Error("fetch failed for https://openmapx.com/transit/plan?from=8.7,50.13");
      },
    });

    const outcome = await service(client).request(request());

    expect(outcome).toMatchObject({ ok: false, code: "network" });
    expect(JSON.stringify(outcome)).not.toContain("50.13");
  });

  it("builds a package even when a ridden stop list could not be fetched", async () => {
    // A missing stop list becomes an explicit missing capture, not a failed
    // replan: the rider still needs the new plan.
    const { client } = fakeClient({
      plan: planAnswer,
      journey: async () => {
        throw new Error("journey unavailable");
      },
    });

    const outcome = await service(client).request(request());

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const captures = (outcome.startPackage as { captures: Array<{ status: string }> }).captures;
    expect(captures.some((capture) => capture.status === "missing")).toBe(true);
  });

  it("aborts a request whose session moved on", async () => {
    let observed: AbortSignal | undefined;
    const instance = service({
      get: async (_path: string, _params: unknown, options: { signal?: AbortSignal }) => {
        observed = options.signal;
        return new Promise((_resolve, reject) => {
          options.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      },
    } as unknown as ApiClient);

    const pending = instance.request(request());
    instance.abort("p1");
    await pending;

    expect(observed?.aborted).toBe(true);
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

    const first = instance.request(request({ requestId: "p1" }));
    const second = instance.request(request({ requestId: "p2" }));
    instance.abortAll();
    await Promise.all([first, second]);

    expect(signals).toHaveLength(2);
    for (const signal of signals) expect(signal.aborted).toBe(true);
  });
});

describe("replanRetryDelayMs", () => {
  it.each(RETRY_DELAYS_MS.map((delay, index) => [index + 1, delay]))(
    "waits the declared delay on attempt %i",
    (attempts, expected) => {
      expect(replanRetryDelayMs(attempts as number)).toBe(expected);
    },
  );

  it("grows with each attempt", () => {
    const delays = RETRY_DELAYS_MS.map((_, index) => replanRetryDelayMs(index + 1));

    for (let index = 1; index < delays.length; index += 1) {
      expect(delays[index]).toBeGreaterThan(delays[index - 1]);
    }
  });

  it("repeats the longest delay rather than growing without bound", () => {
    expect(replanRetryDelayMs(MAX_CONSECUTIVE_FAILURES + 20)).toBe(
      RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1],
    );
  });
});
