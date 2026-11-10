import type { GroundMobileSession } from "@openmapx/core/navigation";
import {
  driveStraightRoute,
  type ForegroundHarness,
  groundStartPackage,
  rawFix,
  STRAIGHT_ROUTE,
  startForegroundHarness,
} from "./testing/foregroundHarness";

/**
 * When the native session asks the server for a new route, and when it holds
 * back: one request at a time, a pause after repeated successful reroutes that
 * keep reading off route, and nothing sent while the phone is offline.
 */

let harness: ForegroundHarness;
afterEach(async () => {
  await harness?.shutdown();
});

const DIRECTIONS_PATH = "/api/integrations/routing/directions";
/** Well away from the followed road. */
const OFF_ROUTE: readonly [number, number] = [8.75, 50.2];
const DESTINATION = STRAIGHT_ROUTE[STRAIGHT_ROUTE.length - 1];

/** A route between two points, with one step. */
function routeBetween(from: readonly [number, number], to: readonly [number, number]) {
  const geometry = Array.from({ length: 40 }, (_, index) => [
    from[0] + ((to[0] - from[0]) * index) / 39,
    from[1] + ((to[1] - from[1]) * index) / 39,
  ]);
  return {
    distance: 22_000,
    duration: 1_300,
    geometry,
    mode: "driving",
    steps: [
      {
        instruction: "Head south-east",
        verbalSuccinct: "Head south-east",
        verbalAlert: "Head south-east now",
        distance: 22_000,
        duration: 1_300,
        name: "Umleitung",
      },
    ],
  };
}

function directionsRequests(): number {
  return harness.phone.network.requests.filter((url) => url.includes(DIRECTIONS_PATH)).length;
}

async function ground(): Promise<GroundMobileSession> {
  const session = await harness.session();
  if (session?.kind !== "ground") throw new Error("no ground session");
  return session;
}

/** Stands off route for `seconds`, one fix a second. */
async function offRouteFor(seconds: number, at: readonly [number, number] = OFF_ROUTE) {
  for (let second = 0; second < seconds; second += 1) {
    harness.phone.clock.advance(1_000);
    await harness.deliver([rawFix(harness.phone.clock, at, { speed: 10 })]);
  }
}

describe("reroute guards on the native session", () => {
  it("keeps one request open at a time while the answer is slow", async () => {
    harness = await startForegroundHarness();
    const held: Array<(response: Response) => void> = [];
    harness.phone.network.respond = (url) =>
      url.includes(DIRECTIONS_PATH)
        ? new Promise<Response>((resolve) => held.push(resolve))
        : Promise.reject(new TypeError("Network request failed"));
    await harness.start(groundStartPackage());
    await driveStraightRoute(harness, 0, 5);

    // Long enough for the engine to ask again several times, within the
    // request's own deadline.
    for (let second = 0; second < 12; second += 1) {
      harness.phone.clock.advance(1_000);
      await harness.navigation.coordinator.handleLocationBatch({
        locations: [rawFix(harness.phone.clock, OFF_ROUTE, { speed: 10 })],
      });
      await harness.navigation.coordinator.settle();
    }

    expect(directionsRequests()).toBe(1);
    expect((await ground()).payload.reroute.status).toBe("in-flight");

    held[0](Response.json({ routes: [routeBetween(OFF_ROUTE, DESTINATION)] }));
    await harness.settle();
    const rerouted = await ground();
    expect(rerouted.payload.reroute.status).toBe("idle");
    expect(rerouted.payload.startPackage.route.geometry[0]).toEqual([...OFF_ROUTE]);
  });

  it("pauses after three reroutes in two minutes that keep reading off route", async () => {
    harness = await startForegroundHarness();
    // Every answer starts somewhere the driver is not, so each new route reads
    // off route again: the churn the guard exists for.
    const elsewhere: readonly [number, number] = [8.6, 50.0];
    harness.phone.network.respond = async (url) =>
      url.includes(DIRECTIONS_PATH)
        ? Response.json({ routes: [routeBetween(elsewhere, DESTINATION)] })
        : Promise.reject(new TypeError("Network request failed"));
    await harness.start(groundStartPackage());
    await driveStraightRoute(harness, 0, 5);

    let seconds = 0;
    while (directionsRequests() < 3 && seconds < 110) {
      await offRouteFor(1);
      seconds += 1;
    }
    expect(directionsRequests()).toBe(3);
    const churned = await ground();
    expect(churned.payload.rerouteChurn?.cooldownUntilMs).toBeGreaterThan(
      harness.phone.clock.now(),
    );

    // Off route throughout the cooldown, and still no fourth request.
    await offRouteFor(25);
    expect(directionsRequests()).toBe(3);

    // Once it is over, a reroute that is still needed is asked for again.
    await offRouteFor(40);
    expect(directionsRequests()).toBeGreaterThan(3);
  });

  it("asks nothing while offline and asks once the connection is back", async () => {
    harness = await startForegroundHarness();
    harness.phone.network.respond = async (url) =>
      url.includes(DIRECTIONS_PATH)
        ? Response.json({ routes: [routeBetween(OFF_ROUTE, DESTINATION)] })
        : Promise.reject(new TypeError("Network request failed"));
    await harness.start(groundStartPackage());
    await driveStraightRoute(harness, 0, 5);
    harness.phone.connectivity.set("offline");
    await harness.elapse(4_000);

    await offRouteFor(20);

    expect(directionsRequests()).toBe(0);
    expect((await ground()).payload.reroute.status).toBe("unavailable");

    harness.phone.connectivity.set("online");
    await harness.elapse(4_000);

    expect(directionsRequests()).toBe(1);
    expect((await ground()).payload.startPackage.route.geometry[0]).toEqual([...OFF_ROUTE]);
  });

  it("asks again after a request whose answer never came back", async () => {
    harness = await startForegroundHarness();
    harness.phone.network.respond = (url) =>
      url.includes(DIRECTIONS_PATH)
        ? new Promise<Response>(() => {})
        : Promise.reject(new TypeError("Network request failed"));
    await harness.start(groundStartPackage());
    await driveStraightRoute(harness, 0, 5);
    for (let second = 0; second < 6; second += 1) {
      harness.phone.clock.advance(1_000);
      await harness.navigation.coordinator.handleLocationBatch({
        locations: [rawFix(harness.phone.clock, OFF_ROUTE, { speed: 10 })],
      });
      await harness.navigation.coordinator.settle();
    }
    expect(directionsRequests()).toBe(1);

    // The process that sent it died with the request open.
    harness = await harness.relaunch();
    harness.phone.network.respond = async (url) =>
      url.includes(DIRECTIONS_PATH)
        ? Response.json({ routes: [routeBetween(OFF_ROUTE, DESTINATION)] })
        : Promise.reject(new TypeError("Network request failed"));
    await offRouteFor(40);

    expect(directionsRequests()).toBe(2);
    expect((await ground()).payload.startPackage.route.geometry[0]).toEqual([...OFF_ROUTE]);
  });
});
