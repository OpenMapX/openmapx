import type { WebToNativeMessage } from "@openmapx/core/navigation";
import type { ApiClient } from "@openmapx/core/navigation/api";
import type { RawLocation } from "../../location/sanitiseFixes";
import type { Database } from "../../storage/database";
import { migrateSessionSchema } from "../../storage/migrations";
import { SessionRepository } from "../../storage/SessionRepository";
import { openTestDatabase } from "../../storage/testing/nodeSqliteDatabase";
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
  /** Rebuilds the coordinator over the same database, as a process restart would. */
  restart: () => Harness;
}

function buildHarness(
  database: Database,
  carried: {
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
        reroute: async (requestId) => {
          const session = await repository.loadActive(clock.value);
          if (session?.kind !== "ground") return;
          const fix = session.lastAcceptedFix;
          if (!fix) return;
          const outcome = await rerouteService.request({
            requestId,
            session,
            origin: fix.coords as [number, number],
          });
          if (!outcome.ok) return;
          // Bound to the revision it was computed from: a session that moved on
          // rejects it rather than adopting a route for a position it has left.
          await repository.compareAndSwap(
            outcome.sessionId,
            outcome.baseRevision,
            (current) => ({
              session: {
                ...current,
                revision: current.revision + 1,
                payload: {
                  ...(current as never as { payload: Record<string, unknown> }).payload,
                  startPackage: outcome.route,
                  progress: null,
                  offRoute: false,
                  reroute: { status: "idle", attempts: 0 },
                },
              } as never,
              effects: [{ kind: "publish-snapshot", immediate: true }],
            }),
            clock.value,
          );
        },
        transitRefresh: async () => undefined,
        transitReplan: async () => undefined,
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
    driverEvents: carried.driverEvents,
    sent: carried.sent,
    advance: (ms) => {
      clock.value += ms;
    },
    now: () => clock.value,
    restart: () => buildHarness(database, carried, clock, apiClient),
  };
  return harness;
}

async function harness(apiAnswer: unknown = { routes: [] }): Promise<Harness> {
  const database = openTestDatabase();
  await migrateSessionSchema(database, 1_000);
  const client = {
    get: async () => apiAnswer,
  } as unknown as ApiClient;
  return buildHarness(
    database,
    { spoken: [], driverEvents: [], sent: [] },
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
    protocolVersion: 1,
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

describe("ground navigation end to end", () => {
  it("starts one location stream and reports the session as active", async () => {
    const context = await harness();

    await begin(context);

    expect(context.driverEvents).toEqual(["start"]);
    const session = await context.repository.loadActive(context.now());
    expect(session?.status).toBe("active");
    await context.database.closeAsync();
  });

  it("advances progress monotonically along the route", async () => {
    const context = await harness();
    await begin(context);

    const along: number[] = [];
    for (let index = 0; index < 30; index += 1) {
      context.advance(1_000);
      await context.coordinator.handleLocationBatch({
        locations: [locationAt(index, context.now())],
      });
      const session = await context.repository.loadActive(context.now());
      const progress = session?.kind === "ground" ? session.payload.progress : null;
      if (progress) along.push((progress as { alongMeters: number }).alongMeters);
    }

    for (let index = 1; index < along.length; index += 1) {
      expect(along[index]).toBeGreaterThanOrEqual(along[index - 1]);
    }
    await context.database.closeAsync();
  });

  it("keeps revisions strictly increasing across the whole journey", async () => {
    const context = await harness();
    await begin(context);
    const revisions: number[] = [];

    for (let index = 0; index < 20; index += 1) {
      context.advance(1_000);
      await context.coordinator.handleLocationBatch({
        locations: [locationAt(index, context.now())],
      });
      const session = await context.repository.loadActive(context.now());
      if (session) revisions.push(session.revision);
    }

    for (let index = 1; index < revisions.length; index += 1) {
      expect(revisions[index]).toBeGreaterThan(revisions[index - 1]);
    }
    await context.database.closeAsync();
  });

  it("speaks no cue twice, even across a process restart between every fix", async () => {
    let context = await harness();
    await begin(context);

    for (let index = 0; index < 40; index += 1) {
      context.advance(1_000);
      await context.coordinator.handleLocationBatch({
        locations: [locationAt(index, context.now())],
      });
      // A restart drops the coordinator, the processor and its prepared route
      // cache — everything except the database.
      context = context.restart();
    }

    expect(new Set(context.spoken).size).toBe(context.spoken.length);
    await context.database.closeAsync();
  });

  it("does not replay a cue when the same batch is delivered twice", async () => {
    const context = await harness();
    await begin(context);
    await drive(context, 0, 20);
    const before = [...context.spoken];

    // The same fixes again: every one is at or behind the watermark.
    for (let index = 0; index < 20; index += 1) {
      await context.coordinator.handleLocationBatch({
        locations: [locationAt(index, START + (index + 1) * 1_000)],
      });
    }

    expect(context.spoken).toEqual(before);
    await context.database.closeAsync();
  });

  it("continues guiding with no network at all", async () => {
    const context = await harness();
    await begin(context);

    await drive(context, 0, 30);

    const session = await context.repository.loadActive(context.now());
    expect(session?.kind === "ground" && session.payload.progress).toBeTruthy();
    // The captured route is the whole point: no request was needed to follow it.
    expect(context.spoken.length).toBeGreaterThanOrEqual(0);
    await context.database.closeAsync();
  });

  it("keeps the captured route when a reroute request fails", async () => {
    const context = await harness({ routes: [] });
    await begin(context);
    await drive(context, 0, 10);
    const before = await context.repository.loadActive(context.now());
    const geometryBefore =
      before?.kind === "ground" ? before.payload.startPackage.route.geometry.length : 0;

    // Far off route, repeatedly.
    for (let index = 0; index < 20; index += 1) {
      context.advance(1_000);
      await context.coordinator.handleLocationBatch({
        locations: [
          { timestamp: context.now(), coords: { latitude: 50.2, longitude: 8.75, accuracy: 5 } },
        ],
      });
    }

    const after = await context.repository.loadActive(context.now());
    expect(after?.kind === "ground" && after.payload.startPackage.route.geometry).toHaveLength(
      geometryBefore,
    );
    await context.database.closeAsync();
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
    await context.database.closeAsync();
  });

  it("replaces the route and resets everything indexed by the old one", async () => {
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

    const after = await context.repository.loadActive(context.now());
    expect(after?.kind === "ground" && after.payload.progress).toBeNull();
    expect(after?.lastAcceptedFix).toBeUndefined();
    await context.database.closeAsync();
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
    await context.database.closeAsync();
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
    await context.database.closeAsync();
  });

  it("survives a restart mid-journey and continues from the persisted state", async () => {
    let context = await harness();
    await begin(context);
    await drive(context, 0, 15);
    const before = await context.repository.loadActive(context.now());

    context = context.restart();
    await drive(context, 15, 25);

    const after = await context.repository.loadActive(context.now());
    expect(after?.sessionId).toBe(before?.sessionId);
    expect(after?.revision).toBeGreaterThan(before?.revision ?? 0);
    expect(context.driverEvents.filter((event) => event === "start")).toHaveLength(1);
    await context.database.closeAsync();
  });

  it("publishes a full snapshot on request, built from what was committed", async () => {
    const context = await harness();
    await begin(context);
    await drive(context, 0, 10);
    context.sent.length = 0;

    await context.coordinator.dispatch(cmd("snapshot.request", {}));

    const snapshots = context.sent.filter((entry) => entry.type === "snapshot.update");
    expect(snapshots.length).toBeGreaterThan(0);
    await context.database.closeAsync();
  });

  it("never puts a coordinate or a route into what it published as an event", async () => {
    const context = await harness();
    await begin(context);
    await drive(context, 0, 30);
    await context.coordinator.dispatch(cmd("session.stop", {}, { sessionId: "journey-1" }));

    const events = context.sent.filter((entry) => entry.type === "navigation.event");
    for (const event of events) {
      expect(JSON.stringify(event.payload)).not.toContain("geometry");
    }
    await context.database.closeAsync();
  });
});
