import type { TransitMobileSession } from "@openmapx/core/navigation";
import {
  type ApiClient,
  ApiClientError,
  ApiRequestAbortedError,
} from "@openmapx/core/navigation/api";
import { journeysToRefetch, TransitRefreshService } from "./TransitRefreshService";
import { FIXTURE_TOKEN, transitSessionFixture } from "./testing/transitFixture";

const NOW = 1_700_000_100_000;
const NEW_TOKEN = "tok_rotated_replacement";

function session(overrides: Partial<TransitMobileSession> = {}): TransitMobileSession {
  return transitSessionFixture(overrides);
}

interface FakeCall {
  kind: "post" | "get";
  path: string;
  body?: unknown;
  options: { signal?: AbortSignal; timeoutMs?: number };
}

/** A client that records what it was asked and answers with what it is told. */
function fakeClient(handlers: {
  refresh?: () => Promise<unknown>;
  journey?: (path: string) => Promise<unknown>;
}) {
  const calls: FakeCall[] = [];
  const client = {
    post: async (path: string, body: unknown, options: FakeCall["options"]) => {
      calls.push({ kind: "post", path, body, options });
      if (!handlers.refresh) throw new Error("no refresh handler");
      return handlers.refresh();
    },
    get: async (path: string, _query: unknown, options: FakeCall["options"]) => {
      calls.push({ kind: "get", path, options });
      if (!handlers.journey) throw new Error("no journey handler");
      return handlers.journey(path);
    },
  } as unknown as ApiClient;
  return { client, calls };
}

const refreshedItinerary = () => ({
  data: {
    itinerary: {
      refreshToken: NEW_TOKEN,
      legs: [{ mode: "rail", route: { shortName: "S1" }, tripId: "trip-1" }],
    },
  },
});

const service = (client: ApiClient) =>
  new TransitRefreshService({ apiOrigin: "https://openmapx.com", client, now: () => NOW });

const request = (overrides: Partial<Parameters<TransitRefreshService["request"]>[0]> = {}) => ({
  requestId: "r1",
  generation: 3,
  session: session(),
  ...overrides,
});

describe("journeysToRefetch", () => {
  it("refetches the ride being taken", () => {
    const riding = session();
    riding.payload.tickState.currentLegIndex = 1;

    expect(journeysToRefetch(riding)).toEqual(["trip-1"]);
  });

  it("skips rides already completed", () => {
    // A stop list nobody will read again is a request spent for nothing.
    const past = session();
    past.payload.tickState.currentLegIndex = 2;

    expect(journeysToRefetch(past)).toEqual([]);
  });

  it("skips walking legs, which have no ride to fetch", () => {
    const walking = session();
    walking.payload.tickState.currentLegIndex = 0;

    expect(journeysToRefetch(walking)).toEqual(["trip-1"]);
  });

  it("returns each trip once", () => {
    const duplicated = session();
    const legs = (duplicated.payload.startPackage.itinerary as { legs: unknown[] }).legs;
    legs.push({ mode: "rail", route: { shortName: "S1" }, tripId: "trip-1" });

    expect(journeysToRefetch(duplicated)).toEqual(["trip-1"]);
  });
});

describe("TransitRefreshService.request", () => {
  it("sends the rotating token and returns the replacement itinerary", async () => {
    const { client, calls } = fakeClient({
      refresh: async () => refreshedItinerary(),
      journey: async () => ({ data: { stops: [{ stopId: "stop-a" }] } }),
    });

    const outcome = await service(client).request(request({ generation: 9, requestId: "r9" }));

    expect(outcome).toMatchObject({
      ok: true,
      generation: 9,
      requestId: "r9",
      sessionId: "session-t1",
      itinerary: refreshedItinerary().data.itinerary,
    });
    expect((calls[0].body as { token: string }).token).toBe(FIXTURE_TOKEN);
    expect(calls[0].options.timeoutMs).toBe(15_000);
    // Never abandoned by this side: only the answer carries the rotated token.
    expect(calls[0].options.signal).toBeUndefined();
  });

  it("retains captures when a hosted journey lookup fails", async () => {
    const { client, calls } = fakeClient({ refresh: async () => refreshedItinerary() });
    const tokenless = session();
    tokenless.payload.refreshToken = null;

    const outcome = await service(client).request(request({ session: tokenless }));

    expect(outcome).toMatchObject({ ok: false, failure: "retryable" });
    expect(calls.map((call) => call.kind)).toEqual(["get"]);
  });

  describe("failure classification", () => {
    it("treats a timeout as ambiguous, because the token may have been spent", async () => {
      const { client } = fakeClient({
        refresh: async () => {
          throw new ApiRequestAbortedError("timeout");
        },
      });

      const outcome = await service(client).request(request());

      // Retrying blindly is a coin flip that silently ends live data when it
      // loses.
      expect(outcome).toMatchObject({ ok: false, failure: "ambiguous" });
    });

    it("treats cancellation after dispatch as ambiguous because the server may have consumed the token", async () => {
      const { client } = fakeClient({
        refresh: async () => {
          throw new ApiRequestAbortedError("aborted");
        },
      });

      const outcome = await service(client).request(request());

      expect(outcome).toMatchObject({ ok: false, failure: "ambiguous" });
    });

    it("treats an answer with no replacement token as a rejection", async () => {
      const { client } = fakeClient({ refresh: async () => ({ data: {} }) });

      expect(await service(client).request(request())).toMatchObject({
        ok: false,
        failure: "rejected",
      });
    });

    it("treats an unexplained error as ambiguous", async () => {
      const { client } = fakeClient({
        refresh: async () => {
          throw new Error(`socket hang up for token ${FIXTURE_TOKEN}`);
        },
      });

      const outcome = await service(client).request(request());
      expect(outcome).toMatchObject({ ok: false, failure: "ambiguous" });
      expect(JSON.stringify(outcome)).not.toContain(FIXTURE_TOKEN);
    });
  });

  describe("ridden stop lists", () => {
    it("keeps the rotating token when a journey fetch fails", async () => {
      // The itinerary call already spent the token; failing here would throw
      // away its replacement for a stale stop list we already have.
      const { client } = fakeClient({
        refresh: async () => refreshedItinerary(),
        journey: async () => {
          throw new Error("journey unavailable");
        },
      });

      const outcome = await service(client).request(request());

      expect(outcome.ok).toBe(true);
      expect(outcome.ok && outcome.journeys["trip-1"]).toBeUndefined();
    });
  });
});

it.each([400, 409, 503])(
  "classifies HTTP %s without discarding a retryable handle",
  async (status) => {
    const { client } = fakeClient({
      refresh: async () => {
        throw new ApiClientError(status, null, null);
      },
    });
    expect(await service(client).request(request())).toMatchObject({
      ok: false,
      failure: status === 503 ? "retryable" : "rejected",
    });
  },
);
it("does not apply a fallback replan returned by the server", async () => {
  const { client } = fakeClient({
    refresh: async () => ({ data: { ...refreshedItinerary().data, fallbackOccurred: true } }),
  });
  expect(await service(client).request(request())).toMatchObject({
    ok: false,
    failure: "rejected",
  });
});

it("refreshes hosted journey captures without an itinerary token or a second owner", async () => {
  const hosted = session();
  hosted.payload.refreshToken = null;
  const { client, calls } = fakeClient({
    journey: async () => ({
      data: {
        stops: [
          {
            stopId: "stop-a",
            departurePlatform: { code: "3", kind: "correction", sourceId: "siri" },
          },
        ],
      },
    }),
  });
  const outcome = await service(client).request(request({ session: hosted }));
  expect(calls.some((call) => call.kind === "post")).toBe(false);
  expect(outcome).toMatchObject({
    ok: true,
    journeys: { "trip-1": [{ departurePlatform: { code: "3" } }] },
  });
});
