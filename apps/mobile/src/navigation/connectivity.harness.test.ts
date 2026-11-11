import type { TransitMobileSession } from "@openmapx/core/navigation";
import { CONNECTIVITY_DEBOUNCE_MS } from "../connectivity/ConnectivityDriver";
import { type ForegroundHarness, startForegroundHarness } from "./testing/foregroundHarness";
import {
  transitItineraryFixture,
  transitStartPackageFixture,
} from "./transit/testing/transitFixture";

/**
 * A rider underground loses the network for a minute or more. The itinerary
 * refresh token is one-time and the server replays an ambiguous attempt only
 * for a short window, so requests that cannot arrive must not use it up.
 */

let harness: ForegroundHarness;
afterEach(async () => {
  await harness?.shutdown();
});

const REFRESH_PATH = "/api/integrations/transit/plan/refresh";

/** The server answers each refresh with the itinerary and a fresh token. */
function serverRotatesTokens(prefix = "tok_rotated"): string[] {
  const issued: string[] = [];
  harness.phone.network.respond = async (url) => {
    if (url.includes(REFRESH_PATH)) {
      const refreshToken = `${prefix}_${issued.length + 1}`;
      issued.push(refreshToken);
      return Response.json({ data: { itinerary: { ...transitItineraryFixture(), refreshToken } } });
    }
    return Response.json({ data: { stops: [] } });
  };
  return issued;
}

function networkUnreachable(): void {
  harness.phone.network.respond = async () => {
    throw new TypeError("Network request failed");
  };
}

async function transitSession(): Promise<TransitMobileSession> {
  const session = await harness.session();
  if (session?.kind !== "transit") throw new Error("no transit session");
  return session;
}

/** Schedule ticks with no position, as a rider underground produces them. */
async function rideWithoutFixes(ms: number, everyMs = 5_000): Promise<void> {
  for (let elapsed = 0; elapsed < ms; elapsed += everyMs) {
    harness.phone.clock.advance(everyMs);
    await harness.settle();
    await harness.deliver([]);
  }
}

function refreshRequests(): number {
  return harness.phone.network.requests.filter((url) => url.includes(REFRESH_PATH)).length;
}

describe("losing the network on a transit ride", () => {
  it("keeps the refresh token through more than a minute offline and refreshes when the network returns", async () => {
    harness = await startForegroundHarness();
    const issued = serverRotatesTokens();
    await harness.start(transitStartPackageFixture());
    await rideWithoutFixes(10_000);
    expect(issued).toHaveLength(1);
    const tokenBefore = (await transitSession()).payload.refreshToken;
    expect(tokenBefore).toBe(issued[0]);

    networkUnreachable();
    harness.phone.connectivity.set("offline");
    await harness.elapse(CONNECTIVITY_DEBOUNCE_MS);
    expect((await transitSession()).connectivity).toBe("offline");
    const requestsWhileOnline = refreshRequests();

    await rideWithoutFixes(100_000);

    const offline = await transitSession();
    expect(refreshRequests()).toBe(requestsWhileOnline);
    expect(offline.payload.refreshToken).toBe(tokenBefore);
    expect(offline.payload.refresh.status).not.toBe("broken");

    serverRotatesTokens("tok_after_outage");
    harness.phone.connectivity.set("online");
    await harness.elapse(CONNECTIVITY_DEBOUNCE_MS);

    const restored = await transitSession();
    expect(restored.connectivity).toBe("online");
    expect(refreshRequests()).toBe(requestsWhileOnline + 1);
    expect(restored.payload.refreshToken).toBe("tok_after_outage_1");
    expect(restored.payload.refresh.status).toBe("ready");
  });

  it("ignores a drop that recovers before it is confirmed", async () => {
    harness = await startForegroundHarness();
    serverRotatesTokens();
    await harness.start(transitStartPackageFixture());
    await harness.elapse(CONNECTIVITY_DEBOUNCE_MS);
    expect((await transitSession()).connectivity).toBe("online");
    const revision = (await transitSession()).revision;

    harness.phone.connectivity.set("offline");
    await harness.elapse(CONNECTIVITY_DEBOUNCE_MS - 1_000);
    harness.phone.connectivity.set("online");
    await harness.elapse(CONNECTIVITY_DEBOUNCE_MS * 2);

    const session = await transitSession();
    expect(session.connectivity).toBe("online");
    expect(session.revision).toBe(revision);
  });

  it("applies an outage on the next batch when the app's timers are paused", async () => {
    harness = await startForegroundHarness();
    serverRotatesTokens();
    await harness.start(transitStartPackageFixture());
    harness.phone.clock.timersPaused = true;

    networkUnreachable();
    harness.phone.connectivity.set("offline");
    harness.phone.clock.advance(CONNECTIVITY_DEBOUNCE_MS);
    await harness.settle();
    expect((await transitSession()).connectivity).toBe("unknown");

    await harness.deliver([]);
    expect((await transitSession()).connectivity).toBe("offline");
  });
});
