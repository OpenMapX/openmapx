import {
  MOBILE_PROTOCOL_MAX,
  type TransitMobileSession,
  type WebToNativeMessage,
} from "@openmapx/core/navigation";
import type { RawLocation } from "../../location/sanitiseFixes";
import type { Database } from "../../storage/database";
import { migrateSessionSchema } from "../../storage/migrations";
import { SessionRepository } from "../../storage/SessionRepository";
import { openTestDatabase } from "../../storage/testing/nodeSqliteDatabase";
import { EffectRunner } from "../effects";
import { type CoordinatorDeps, NavigationCoordinator } from "../NavigationCoordinator";
import { ProcessorRegistry } from "../processor";
import { createPublishPort } from "../snapshots/createPublishPort";
import { TransitNavigationProcessor } from "./TransitNavigationProcessor";
import { FIXTURE_TOKEN, transitStartPackageFixture } from "./testing/transitFixture";

/**
 * A whole transit journey through the production boundaries.
 *
 * The real coordinator, the real repository over a real SQLite engine, the real
 * processor, effect runner and snapshot publisher. Only the outside world is
 * faked: the clock, the location stream, speech and the network.
 *
 * The failures this is here to catch are the ones that only appear when those
 * meet — a token spent twice, a leg that jumps backwards, an alert surviving a
 * stop, an itinerary lost because the connection went away.
 */

const databases: Database[] = [];
afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.closeAsync()));
});

const START = new Date("2026-08-09T08:00:00Z").getTime();
const RIDE_START = new Date("2026-08-09T08:10:00Z").getTime();
const RIDE_END = new Date("2026-08-09T08:40:00Z").getTime();

interface Harness {
  coordinator: NavigationCoordinator;
  repository: SessionRepository;
  database: Database;
  spoken: string[];
  driverEvents: string[];
  sent: Array<{ type: string; payload: unknown }>;
  clock: { value: number };
  advance: (ms: number) => void;
  restart: () => Harness;
}

function build(
  database: Database,
  carried: {
    spoken: string[];
    driverEvents: string[];
    sent: Array<{ type: string; payload: unknown }>;
  },
  clock: { value: number },
): Harness {
  const repository = new SessionRepository(database);
  const processors = new ProcessorRegistry();
  processors.register(new TransitNavigationProcessor());

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
        updateProfile: async (profile) => {
          carried.driverEvents.push(`profile:${profile}`);
        },
        isRunning: async () => true,
      },
      audio: {
        speak: async (cueId) => {
          carried.spoken.push(cueId);
        },
        stop: async () => undefined,
      },
      alerts: { reconcile: async () => undefined, cancelSession: async () => undefined },
      publish: publish.port,
      remote: {
        reroute: async () => undefined,
        transitRefresh: async () => undefined,
      },
      diagnostics: { record: () => undefined },
    }),
    bridge: {
      send: (type, payload) => {
        carried.sent.push({ type, payload });
        return "sent";
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
    newSessionId: () => "journey-t1",
  };

  return {
    coordinator: new NavigationCoordinator(deps),
    repository,
    database,
    spoken: carried.spoken,
    driverEvents: carried.driverEvents,
    sent: carried.sent,
    clock,
    advance: (ms) => {
      clock.value += ms;
    },
    restart: () => build(database, carried, clock),
  };
}

async function harness(): Promise<Harness> {
  const database = openTestDatabase();
  databases.push(database);
  await migrateSessionSchema(database, 1_000);
  return build(database, { spoken: [], driverEvents: [], sent: [] }, { value: START });
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
    messageId: extra.messageId ?? `t-e2e-${messageCounter}`,
    channelNonce: "nonce",
    sentAtMs: START,
    payload,
    ...(extra.sessionId === undefined ? {} : { sessionId: extra.sessionId }),
    ...(extra.revision === undefined ? {} : { revision: extra.revision }),
  } as WebToNativeMessage;
}

function locationAt(timestampMs: number, longitude = 8.68): RawLocation {
  return {
    timestamp: timestampMs,
    coords: { latitude: 50.11, longitude, accuracy: 12, speed: 8 },
  };
}

function journeyPackage() {
  const result = transitStartPackageFixture();
  const endpoints = [
    [8.69, 8.68],
    [8.68, 8.64],
    [8.64, 8.63],
  ];
  result.itinerary.legs.forEach((leg, index) => {
    leg.from.lng = endpoints[index][0];
    leg.to.lng = endpoints[index][1];
    Object.assign(leg, {
      geometry: {
        type: "LineString",
        coordinates: [
          [endpoints[index][0], 50.11],
          [endpoints[index][1], 50.11],
        ],
      },
    });
  });
  return result;
}

async function begin(context: Harness) {
  await context.coordinator.dispatch(cmd("session.prepare", { startPackage: journeyPackage() }));
  await context.coordinator.dispatch(
    cmd("session.start", {}, { sessionId: "journey-t1", revision: 1 }),
  );
}

/** Ticks the coordinator once a minute between two instants. */
async function travel(context: Harness, fromMs: number, toMs: number, longitude = 8.68) {
  for (let at = fromMs; at <= toMs; at += 60_000) {
    context.clock.value = at;
    await context.coordinator.handleLocationBatch({ locations: [locationAt(at, longitude)] });
  }
}

async function riderAction(context: Harness, type: "board" | "alight") {
  const session = (await context.repository.loadActive(
    context.clock.value,
  )) as TransitMobileSession;
  const response = await context.coordinator.dispatch(
    cmd(
      "transit.action",
      {
        actionId: type + ":confirmed",
        itineraryFingerprint: session.payload.startPackage.itineraryFingerprint,
        expectedPhase: session.payload.tickState.phase,
        type,
        legIndex: 1,
      },
      { sessionId: session.sessionId },
    ),
  );
  expect(response?.type).toBe("snapshot.update");
}

describe("transit navigation end to end", () => {
  it("persists a moving journey across processor restarts, deduplicates its cues, and redacts published snapshots", async () => {
    let context = await harness();
    await begin(context);
    const initial = (await context.repository.loadActive(
      context.clock.value,
    )) as TransitMobileSession;
    expect(initial.payload.refreshToken).toBe(FIXTURE_TOKEN);
    const states: TransitMobileSession[] = [];
    const tick = async (at: number, longitude: number) => {
      context.clock.value = at;
      await context.coordinator.handleLocationBatch({ locations: [locationAt(at, longitude)] });
      const stored = await context.repository.loadActive(at);
      expect(stored?.kind).toBe("transit");
      states.push(stored as TransitMobileSession);
      context = context.restart();
    };
    await tick(START, 8.69);
    await tick(RIDE_START, 8.68);
    await riderAction(context, "board");
    for (let step = 1; step <= 4; step++)
      await tick(RIDE_START + step * 450_000, 8.68 - step * 0.01);
    expect(states.map((session) => session.payload.tickState.currentLegIndex)).toEqual([
      0, 1, 1, 1, 1, 1,
    ]);
    for (let index = 1; index < states.length; index++)
      expect(states[index].revision).toBeGreaterThan(states[index - 1].revision);
    expect(context.spoken.length).toBeGreaterThan(0);
    expect(new Set(context.spoken).size).toBe(context.spoken.length);
    const beforeReplay = [...context.spoken];
    await context.coordinator.handleLocationBatch({ locations: [locationAt(RIDE_END, 8.64)] });
    expect(context.spoken).toEqual(beforeReplay);
    await riderAction(context, "alight");
    const final = (await context.repository.loadActive(
      context.clock.value,
    )) as TransitMobileSession;
    expect(final.payload.tickState.currentLegIndex).toBe(2);
    expect(final.payload.tickState.phase).toBe("walking");
    expect(final.payload.startPackage.captures[0].stops).toHaveLength(4);
    // The stubbed refresh never replies; the expired handle may be retired while the captured trip survives.
    expect(final.payload.startPackage.itineraryFingerprint).toBe(
      initial.payload.startPackage.itineraryFingerprint,
    );
    expect(context.driverEvents.filter((event) => event === "start")).toHaveLength(1);
    context.sent.length = 0;
    await context.coordinator.dispatch(cmd("snapshot.request", {}));
    expect(context.sent).toHaveLength(1);
    expect(context.sent[0]).toMatchObject({
      type: "snapshot.update",
      payload: {
        snapshot: {
          kind: "transit",
          sessionId: "journey-t1",
          revision: final.revision,
          currentLegIndex: 2,
        },
      },
    });
    expect(JSON.stringify(context.sent)).not.toContain(FIXTURE_TOKEN);
  });
  it("starts one location stream and reports the session as active", async () => {
    const context = await harness();

    await begin(context);

    expect(context.driverEvents.filter((event) => event === "start")).toHaveLength(1);
    expect((await context.repository.loadActive(context.clock.value))?.status).toBe("active");
  });

  it("labels position-free progress as estimated while retaining the rider-confirmed ride", async () => {
    // A rider underground produces nothing for twenty minutes; the banner must
    // not freeze on a stop the train left long ago.
    const context = await harness();
    await begin(context);
    // One real fix first: schedule fallback measures silence since the last
    // accepted position, so a session that never had one has nothing to fall
    // back from.
    context.clock.value = RIDE_START;
    await context.coordinator.handleLocationBatch({ locations: [locationAt(RIDE_START)] });
    await riderAction(context, "board");

    for (let at = RIDE_START + 60_000; at <= RIDE_END; at += 60_000) {
      context.clock.value = at;
      await context.coordinator.handleLocationBatch({ locations: [] });
    }

    const session = await context.repository.loadActive(RIDE_END);
    expect(session?.kind === "transit" && session.payload.tickState.currentLegIndex).toBe(1);
    expect(session?.kind === "transit" && session.payload.tickState.phase).toBe("riding");
    expect(session?.kind === "transit" && session.payload.confidence).not.toBe("gps");
  });

  it("survives a restart mid-journey and continues from what was persisted", async () => {
    let context = await harness();
    await begin(context);
    await travel(context, START, RIDE_START);
    const before = await context.repository.loadActive(context.clock.value);

    context = context.restart();
    await travel(context, RIDE_START, RIDE_END);

    const after = await context.repository.loadActive(context.clock.value);
    expect(after?.sessionId).toBe(before?.sessionId);
    expect(after?.revision).toBeGreaterThan(before?.revision ?? 0);
    expect(context.driverEvents.filter((event) => event === "start")).toHaveLength(1);
  });

  it("adopts a replacement itinerary whole, with its own token", async () => {
    const context = await harness();
    await begin(context);
    await travel(context, START, RIDE_START);

    const replacement = transitStartPackageFixture({
      itineraryFingerprint: "it-replacement-3",
      itinerary: { ...transitStartPackageFixture().itinerary, refreshToken: "tok_new_journey" },
    });
    await context.coordinator.dispatch(
      cmd("session.replace", { startPackage: replacement }, { sessionId: "journey-t1" }),
    );

    const session = (await context.repository.loadActive(
      context.clock.value,
    )) as TransitMobileSession | null;
    expect(session?.payload.startPackage.itineraryFingerprint).toBe("it-replacement-3");
    expect(session?.payload.refreshToken).toBe("tok_new_journey");
    // Combining a new itinerary with an old capture set would describe a journey
    // that never existed.
    expect(session?.payload.tickState.currentLegIndex).toBe(0);
  });

  it("stops the stream and leaves nothing location-bearing behind", async () => {
    const context = await harness();
    await begin(context);
    await travel(context, START, RIDE_END);

    await context.coordinator.dispatch(cmd("session.stop", {}, { sessionId: "journey-t1" }));

    expect(context.driverEvents.filter((event) => event === "stop")).toHaveLength(1);
    const rows = Object.fromEntries(
      (await context.repository.describeContents()).map((entry) => [entry.table, entry.rows]),
    );
    expect(rows.active_navigation).toBe(0);
    expect(rows.navigation_events).toBe(0);
    expect(rows.scheduled_alerts).toBe(0);
    expect(rows.terminal_ack).toBe(1);
    const acknowledgment = await context.database.getAllAsync("SELECT * FROM terminal_ack");
    expect(acknowledgment).toHaveLength(1);
    expect(JSON.stringify(acknowledgment)).not.toMatch(
      /tok_transit|Hauptbahnhof|Messe|50\.11|trip-1/,
    );
  });

  it("refuses a batch that arrives after the stop", async () => {
    const context = await harness();
    await begin(context);
    await context.coordinator.dispatch(cmd("session.stop", {}, { sessionId: "journey-t1" }));

    await context.coordinator.handleLocationBatch({ locations: [locationAt(RIDE_END)] });

    expect(await context.repository.loadActive(RIDE_END)).toBeNull();
  });

  it("refuses a replacement after the session ended", async () => {
    const context = await harness();
    await begin(context);
    await context.coordinator.dispatch(cmd("session.stop", {}, { sessionId: "journey-t1" }));

    const response = await context.coordinator.dispatch(
      cmd(
        "session.replace",
        { startPackage: transitStartPackageFixture() },
        {
          sessionId: "journey-t1",
        },
      ),
    );

    expect(response?.type).toBe("native.error");
  });

  it("applies a settings change without disturbing the leg", async () => {
    const context = await harness();
    await begin(context);
    await travel(context, START, RIDE_START);
    const before = (await context.repository.loadActive(
      context.clock.value,
    )) as TransitMobileSession;

    await context.coordinator.dispatch(
      cmd("settings.update", { locale: "de" }, { sessionId: "journey-t1" }),
    );

    const after = (await context.repository.loadActive(
      context.clock.value,
    )) as TransitMobileSession;
    expect(after.locale).toBe("de");
    expect(after.payload.tickState.currentLegIndex).toBe(before.payload.tickState.currentLegIndex);
  });

  it("answers a snapshot request from what was committed", async () => {
    const context = await harness();
    await begin(context);
    await travel(context, START, RIDE_START);
    context.sent.length = 0;

    await context.coordinator.dispatch(cmd("snapshot.request", {}));

    const session = (await context.repository.loadActive(
      context.clock.value,
    )) as TransitMobileSession;
    expect(context.sent).toHaveLength(1);
    expect(context.sent[0]).toMatchObject({
      type: "snapshot.update",
      payload: {
        snapshot: {
          kind: "transit",
          sessionId: session.sessionId,
          revision: session.revision,
          currentLegIndex: session.payload.tickState.currentLegIndex,
        },
      },
    });
    expect(JSON.stringify(context.sent)).not.toContain(FIXTURE_TOKEN);
  });
});
