import {
  MOBILE_PROTOCOL_MAX,
  readRouteMatcherCounters,
  resetRouteMatcherCounters,
  setRouteMatcherCounting,
  type WebToNativeMessage,
} from "@openmapx/core/navigation";
import type { ApiClient } from "@openmapx/core/navigation/api";
import type { RawLocation } from "../../location/sanitiseFixes";
import type { Database } from "../../storage/database";
import { migrateSessionSchema } from "../../storage/migrations";
import { SessionRepository } from "../../storage/SessionRepository";
import { openTestDatabase } from "../../storage/testing/nodeSqliteDatabase";
import { createRemoteWork, type RemoteWork } from "../createRemoteWork";
import { EffectRunner } from "../effects";
import { type CoordinatorDeps, NavigationCoordinator } from "../NavigationCoordinator";
import { ProcessorRegistry } from "../processor";
import { createPublishPort } from "../snapshots/createPublishPort";
import { GroundNavigationProcessor } from "./GroundNavigationProcessor";
import { GroundRerouteService } from "./GroundRerouteService";

/**
 * A whole ground journey through the production boundaries.
 *
 * The point of this file is that nothing is stubbed except the outside world:
 * the real coordinator, the real repository over a real SQLite engine, the real
 * processor, the real effect runner and the real snapshot publisher. What is
 * faked is only what a device would provide — the clock, the location stream,
 * the speech synthesiser and the network.
 *
 * It exists to catch the failures that only appear when those pieces meet:
 * a cue spoken twice across a restart, progress that regresses, a session that
 * survives its own stop, a route lost because the network went away.
 */

const START = 1_700_000_100_000;
// The trace crosses the first turn at 10 km, exercising all three voice stages.
const EXPECTED_TURN_CUES = ["far", "near", "now"].map((stage) =>
  expect.stringMatching(new RegExp(`^journey-1:ground:.+:1:${stage}$`)),
);

/** A straight route long enough to drive along for several minutes. */
const GEOMETRY: Array<[number, number]> = Array.from({ length: 300 }, (_, index) => [
  8.68 + index * 0.001,
  50.11,
]);

const START_PACKAGE = {
  kind: "ground" as const,
  route: {
    distance: 21_000,
    duration: 1_200,
    geometry: GEOMETRY,
    mode: "driving",
    steps: [
      {
        instruction: "Head east on Beispielstraße",
        verbalSuccinct: "Head east",
        verbalAlert: "Head east now",
        distance: 10_000,
        duration: 600,
        name: "Beispielstraße",
      },
      {
        instruction: "Turn left onto Zweite Straße",
        verbalSuccinct: "Turn left",
        verbalAlert: "Turn left now",
        distance: 11_000,
        duration: 600,
        name: "Zweite Straße",
      },
    ],
  },
  alternatives: [],
  mode: "driving" as const,
  destinationWaypoints: [[8.68 + 299 * 0.001, 50.11]] as Array<[number, number]>,
  routeSelectionIntent: "automatic" as const,
  routeOptions: { avoidTolls: true },
  locale: "en" as const,
  units: "metric" as const,
  settings: { voiceEnabled: true, keepScreenOn: true, voiceTiming: "normal" as const },
};

interface Harness {
  coordinator: NavigationCoordinator;
  repository: SessionRepository;
  database: Database;
  spoken: string[];
  driverEvents: string[];
  sent: Array<{ type: string; payload: unknown }>;
  advance: (ms: number) => void;
  now: () => number;
  requests: unknown[][];
  remoteIdle: () => Promise<void>;
  /** Rebuilds the coordinator over the same database, as a process restart would. */
  restart: () => Harness;
}

function buildHarness(
  database: Database,
  carried: {
    requests: unknown[][];
    spoken: string[];
    driverEvents: string[];
    sent: Array<{ type: string; payload: unknown }>;
  },
  clock: { value: number },
  apiClient: ApiClient,
): Harness {
  const repository = new SessionRepository(database);
  const processors = new ProcessorRegistry();
  processors.register(new GroundNavigationProcessor());

  const rerouteService = new GroundRerouteService({
    apiOrigin: "https://openmapx.com",
    client: apiClient,
    now: () => clock.value,
  });

  const publish = createPublishPort({
    repository,
    send: (type, payload) => {
      carried.sent.push({ type, payload });
      return true;
    },
    now: () => clock.value,
  });

  let remote: RemoteWork;
  const deps: CoordinatorDeps = {
    repository,
    processors,
    effects: new EffectRunner({
      driver: {
        start: async () => {
          carried.driverEvents.push("start");
        },
        stop: async () => {
          carried.driverEvents.push("stop");
        },
        updateProfile: async () => undefined,
        isRunning: async () => true,
      },
      audio: {
        // The real module answers `skipped` for a cue it has already spoken;
        // this records every attempt so a duplicate would be visible.
        speak: async (cueId) => {
          carried.spoken.push(cueId);
        },
        stop: async () => undefined,
      },
      alerts: { reconcile: async () => undefined, cancelSession: async () => undefined },
      publish: publish.port,
      remote: {
        reroute: (requestId) => remote.port.reroute(requestId),
        transitRefresh: async () => undefined,
      },
      diagnostics: { record: () => undefined },
    }),
    bridge: {
      send: (type, payload) => {
        carried.sent.push({ type, payload });
      },
    },
    permissions: {
      state: async () => "background",
      isAppActive: () => true,
      requestForStart: async () => "background",
    },
    driver: { isRunning: async () => true },
    diagnostics: { record: () => undefined },
    clock: () => clock.value,
    newSessionId: () => "journey-1",
  };

  const harness: Harness = {
    coordinator: new NavigationCoordinator(deps),
    repository,
    database,
    spoken: carried.spoken,
    requests: carried.requests,
    remoteIdle: () => remote.idle(),
    driverEvents: carried.driverEvents,
    sent: carried.sent,
    advance: (ms) => {
      clock.value += ms;
    },
    now: () => clock.value,
    restart: () => buildHarness(database, carried, clock, apiClient),
  };
  remote = createRemoteWork({
    repository,
    reroute: rerouteService,
    applyReroute: (outcome) => harness.coordinator.applyReroute(outcome),
    now: () => clock.value,
    diagnostics: { record: () => undefined },
  });
  return harness;
}

const databases: Database[] = [];
afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.closeAsync()));
});

async function harness(apiAnswer: unknown = { routes: [] }): Promise<Harness> {
  const database = openTestDatabase();
  databases.push(database);
  await migrateSessionSchema(database, 1_000);
  const requests: unknown[][] = [];
  const client = {
    get: async (...args: unknown[]) => {
      requests.push(args);
      return apiAnswer;
    },
  } as unknown as ApiClient;
  return buildHarness(
    database,
    { spoken: [], driverEvents: [], sent: [], requests },
    { value: START },
    client,
  );
}

let messageCounter = 0;
function cmd(
  type: WebToNativeMessage["type"],
  payload: unknown,
  extra: { sessionId?: string; revision?: number; messageId?: string } = {},
): WebToNativeMessage {
  messageCounter += 1;
  return {
    protocolVersion: MOBILE_PROTOCOL_MAX,
    type,
    messageId: extra.messageId ?? `e2e-${messageCounter}`,
    channelNonce: "nonce",
    sentAtMs: START,
    payload,
    ...(extra.sessionId === undefined ? {} : { sessionId: extra.sessionId }),
    ...(extra.revision === undefined ? {} : { revision: extra.revision }),
  } as WebToNativeMessage;
}

function locationAt(index: number, timestampMs: number): RawLocation {
  return {
    timestamp: timestampMs,
    coords: { latitude: 50.11, longitude: 8.68 + index * 0.001, accuracy: 5, speed: 20 },
  };
}

/** Prepares and starts, the way the page would. */
async function begin(context: Harness) {
  await context.coordinator.dispatch(cmd("session.prepare", { startPackage: START_PACKAGE }));
  await context.coordinator.dispatch(
    cmd("session.start", {}, { sessionId: "journey-1", revision: 1 }),
  );
}

/** Drives the route from `from` to `to`, one fix per second. */
async function drive(context: Harness, from: number, to: number) {
  for (let index = from; index < to; index += 1) {
    context.advance(1_000);
    await context.coordinator.handleLocationBatch({
      locations: [locationAt(index, context.now())],
    });
  }
}

describe("ground navigation route index reuse across durable reloads", () => {
  beforeEach(() => {
    resetRouteMatcherCounters();
    setRouteMatcherCounting(true);
  });
  afterEach(() => {
    setRouteMatcherCounting(false);
    resetRouteMatcherCounters();
  });

  const preparations = () => readRouteMatcherCounters().preparations;

  async function progressAlong(context: Harness): Promise<number> {
    const session = await context.repository.loadActive(context.now());
    const progress = session?.kind === "ground" ? session.payload.progress : null;
    return (progress as { alongMeters: number } | null)?.alongMeters ?? Number.NaN;
  }

  it("prepares the route index once across separately persisted callbacks", async () => {
    const context = await harness();
    await begin(context);
    const startRevision = (await context.repository.loadActive(context.now()))?.revision ?? 0;
    resetRouteMatcherCounters();

    expect(context.driverEvents).toEqual(["start"]);
    let previous = -1;
    for (let index = 0; index < 30; index += 1) {
      context.advance(1_000);
      await context.coordinator.handleLocationBatch({
        locations: [locationAt(index, context.now())],
      });
      // Every callback reloads the session from SQLite and commits through the
      // revision check; reuse must not skip either.
      const session = await context.repository.loadActive(context.now());
      expect(session?.status).toBe("active");
      expect(session?.revision).toBe(startRevision + index + 1);
      const along = await progressAlong(context);
      if (index === 0) expect(along).toBeCloseTo(0);
      expect(along).toBeGreaterThanOrEqual(previous);
      previous = along;
    }

    expect(previous).toBeGreaterThan(2_000);
    expect(previous).toBeLessThan(2_100);
    expect(preparations()).toBe(1);
  });

  it("prepares afresh after a process restart and keeps guiding correctly", async () => {
    let context = await harness();
    await begin(context);
    resetRouteMatcherCounters();
    await drive(context, 0, 5);
    expect(preparations()).toBe(1);
    const before = await progressAlong(context);
    const persisted = await context.repository.loadActive(context.now());

    context = context.restart();
    await drive(context, 5, 10);

    expect(preparations()).toBe(2);
    expect(await progressAlong(context)).toBeGreaterThan(before);
    const restored = await context.repository.loadActive(context.now());
    expect(restored?.sessionId).toBe(persisted?.sessionId);
    expect(restored?.revision).toBeGreaterThan(persisted?.revision ?? 0);
    expect(context.driverEvents).toEqual(["start"]);
  });

  it("prepares afresh after a route replacement and resets progress to the new road", async () => {
    const context = await harness();
    await begin(context);
    await drive(context, 0, 20);

    const shorter = {
      ...START_PACKAGE,
      route: { ...START_PACKAGE.route, geometry: GEOMETRY.slice(0, 100) },
    };
    await context.coordinator.dispatch(
      cmd("session.replace", { startPackage: shorter }, { sessionId: "journey-1" }),
    );
    const replaced = await context.repository.loadActive(context.now());
    expect(replaced?.kind === "ground" && replaced.payload.progress).toBeNull();
    expect(replaced?.lastAcceptedFix).toBeUndefined();
    resetRouteMatcherCounters();

    await drive(context, 20, 25);

    expect(preparations()).toBe(1);
    const session = await context.repository.loadActive(context.now());
    expect(session?.kind === "ground" && session.payload.startPackage.route.geometry).toHaveLength(
      100,
    );
    expect(await progressAlong(context)).toBeGreaterThan(1_500);
  });
});

describe("ground navigation end to end", () => {
  it("speaks no cue twice, even across a process restart between every fix", async () => {
    let context = await harness();
    await begin(context);

    for (let index = 0; index < 150; index += 1) {
      context.advance(1_000);
      await context.coordinator.handleLocationBatch({
        locations: [locationAt(index, context.now())],
      });
      // A restart drops the coordinator, the processor and its prepared route
      // cache — everything except the database.
      context = context.restart();
    }

    expect(context.spoken).toEqual(EXPECTED_TURN_CUES);
    expect(new Set(context.spoken).size).toBe(context.spoken.length);
  });

  it("does not replay a cue when the same batch is delivered twice", async () => {
    const context = await harness();
    await begin(context);
    await drive(context, 0, 150);
    expect(context.requests).toEqual([]);
    const guided = await context.repository.loadActive(context.now());
    expect(guided?.kind === "ground" && guided.payload.progress).toMatchObject({
      alongMeters: expect.any(Number),
    });
    const before = [...context.spoken];
    expect(before).toEqual(EXPECTED_TURN_CUES);

    // The same fixes again: every one is at or behind the watermark.
    for (let index = 0; index < 150; index += 1) {
      await context.coordinator.handleLocationBatch({
        locations: [locationAt(index, START + (index + 1) * 1_000)],
      });
    }

    expect(context.spoken).toEqual(before);
  });

  it("keeps the captured route when a reroute request fails", async () => {
    const context = await harness({ routes: [] });
    await begin(context);
    await drive(context, 0, 10);
    const before = await context.repository.loadActive(context.now());
    const geometryBefore =
      before?.kind === "ground" ? before.payload.startPackage.route.geometry : undefined;

    // Far off route, repeatedly.
    for (let index = 0; index < 20; index += 1) {
      context.advance(1_000);
      await context.coordinator.handleLocationBatch({
        locations: [
          { timestamp: context.now(), coords: { latitude: 50.2, longitude: 8.75, accuracy: 5 } },
        ],
      });
    }

    await context.remoteIdle();
    expect(context.requests.length).toBeGreaterThan(0);
    const after = await context.repository.loadActive(context.now());
    expect(after?.kind === "ground" && after.payload.startPackage.route.geometry).toEqual(
      geometryBefore,
    );
    expect(after?.kind === "ground" && after.payload.reroute).toMatchObject({
      lastFailureCode: "no-route",
    });
    expect(after?.kind === "ground" && after.payload.reroute.attempts).toBeGreaterThan(0);
    const events = await context.repository.listPendingEvents("journey-1");
    expect(events.map((event) => event.payload)).toEqual([{ type: "off-route" }]);
  });

  it("applies a settings change without disturbing progress", async () => {
    const context = await harness();
    await begin(context);
    await drive(context, 0, 10);
    const before = await context.repository.loadActive(context.now());

    await context.coordinator.dispatch(
      cmd("settings.update", { locale: "de", units: "imperial" }, { sessionId: "journey-1" }),
    );

    const after = await context.repository.loadActive(context.now());
    expect(after?.locale).toBe("de");
    expect(after?.units).toBe("imperial");
    expect(after?.kind === "ground" && after.payload.progress).toEqual(
      before?.kind === "ground" ? before.payload.progress : null,
    );
  });

  it("stops the stream and leaves nothing location-bearing behind", async () => {
    const context = await harness();
    await begin(context);
    await drive(context, 0, 20);

    await context.coordinator.dispatch(cmd("session.stop", {}, { sessionId: "journey-1" }));

    expect(context.driverEvents).toEqual(["start", "stop"]);
    expect(await context.repository.loadActive(context.now())).toBeNull();
    const rows = Object.fromEntries(
      (await context.repository.describeContents()).map((entry) => [entry.table, entry.rows]),
    );
    expect(rows.active_navigation).toBe(0);
    expect(rows.navigation_events).toBe(0);
    expect(rows.terminal_ack).toBe(1);
  });

  it("refuses a command that arrives after the stop", async () => {
    const context = await harness();
    await begin(context);
    await context.coordinator.dispatch(cmd("session.stop", {}, { sessionId: "journey-1" }));

    await context.coordinator.handleLocationBatch({
      locations: [locationAt(50, context.now())],
    });

    // A late batch must not resurrect a session the user ended.
    expect(await context.repository.loadActive(context.now())).toBeNull();
  });

  it("publishes a full snapshot on request, built from what was committed", async () => {
    const context = await harness();
    await begin(context);
    await drive(context, 0, 10);
    context.sent.length = 0;

    await context.coordinator.dispatch(cmd("snapshot.request", {}));

    const snapshots = context.sent.filter((entry) => entry.type === "snapshot.update");
    const stored = await context.repository.loadActive(context.now());
    expect(stored?.kind).toBe("ground");
    expect(snapshots).toEqual([
      {
        type: "snapshot.update",
        payload: {
          snapshot: expect.objectContaining({
            version: 1,
            type: "full",
            sessionId: stored?.sessionId,
            revision: stored?.revision,
            status: "active",
            route: stored?.kind === "ground" ? stored.payload.startPackage.route : undefined,
            progress: stored?.kind === "ground" ? stored.payload.progress : undefined,
            locale: stored?.locale,
          }),
        },
      },
    ]);
  });
});
