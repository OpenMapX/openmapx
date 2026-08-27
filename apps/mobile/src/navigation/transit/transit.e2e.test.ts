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

async function begin(context: Harness) {
  await context.coordinator.dispatch(
    cmd("session.prepare", { startPackage: transitStartPackageFixture() }),
  );
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

describe("transit navigation end to end", () => {
  it("starts one location stream and reports the session as active", async () => {
    const context = await harness();

    await begin(context);

    expect(context.driverEvents.filter((event) => event === "start")).toHaveLength(1);
    expect((await context.repository.loadActive(context.clock.value))?.status).toBe("active");
    await context.database.closeAsync();
  });

  it("keeps revisions strictly increasing across the journey", async () => {
    const context = await harness();
    await begin(context);
    const revisions: number[] = [];

    for (let at = START; at <= RIDE_END; at += 5 * 60_000) {
      context.clock.value = at;
      await context.coordinator.handleLocationBatch({ locations: [locationAt(at)] });
      const session = await context.repository.loadActive(at);
      if (session) revisions.push(session.revision);
    }

    for (let index = 1; index < revisions.length; index += 1) {
      expect(revisions[index]).toBeGreaterThan(revisions[index - 1]);
    }
    await context.database.closeAsync();
  });

  it("never moves the leg backwards", async () => {
    const context = await harness();
    await begin(context);
    const legs: number[] = [];

    for (let at = START; at <= RIDE_END; at += 60_000) {
      context.clock.value = at;
      await context.coordinator.handleLocationBatch({ locations: [locationAt(at)] });
      const session = await context.repository.loadActive(at);
      if (session?.kind === "transit") legs.push(session.payload.tickState.currentLegIndex);
    }

    for (let index = 1; index < legs.length; index += 1) {
      expect(legs[index]).toBeGreaterThanOrEqual(legs[index - 1]);
    }
    await context.database.closeAsync();
  });

  it("advances from the schedule when no position arrives at all", async () => {
    // A rider underground produces nothing for twenty minutes; the banner must
    // not freeze on a stop the train left long ago.
    const context = await harness();
    await begin(context);
    // One real fix first: schedule fallback measures silence since the last
    // accepted position, so a session that never had one has nothing to fall
    // back from.
    context.clock.value = START;
    await context.coordinator.handleLocationBatch({ locations: [locationAt(START)] });

    for (let at = START + 60_000; at <= RIDE_END; at += 60_000) {
      context.clock.value = at;
      await context.coordinator.handleLocationBatch({ locations: [] });
    }

    const session = await context.repository.loadActive(RIDE_END);
    expect(
      session?.kind === "transit" && session.payload.tickState.currentLegIndex,
    ).toBeGreaterThan(0);
    await context.database.closeAsync();
  });

  it("labels schedule-driven progress honestly", async () => {
    const context = await harness();
    await begin(context);
    context.clock.value = START;
    await context.coordinator.handleLocationBatch({ locations: [locationAt(START)] });

    for (let at = START + 60_000; at <= RIDE_START + 10 * 60_000; at += 60_000) {
      context.clock.value = at;
      await context.coordinator.handleLocationBatch({ locations: [] });
    }

    const session = await context.repository.loadActive(context.clock.value);
    // Time alone never asserts a physical position.
    expect(session?.kind === "transit" && session.payload.confidence).not.toBe("gps");
    await context.database.closeAsync();
  });

  it("speaks no cue twice, even restarting between every tick", async () => {
    let context = await harness();
    await begin(context);

    for (let at = START; at <= RIDE_END; at += 60_000) {
      context.clock.value = at;
      await context.coordinator.handleLocationBatch({ locations: [locationAt(at)] });
      // A restart drops the coordinator, the processor and its prepared index.
      context = context.restart();
    }

    expect(new Set(context.spoken).size).toBe(context.spoken.length);
    await context.database.closeAsync();
  });

  it("does not replay events when the same batch is delivered twice", async () => {
    const context = await harness();
    await begin(context);
    await travel(context, START, RIDE_END);
    const before = [...context.spoken];

    for (let at = START; at <= RIDE_END; at += 60_000) {
      await context.coordinator.handleLocationBatch({ locations: [locationAt(at)] });
    }

    expect(context.spoken).toEqual(before);
    await context.database.closeAsync();
  });

  it("continues on the captured itinerary with no network at all", async () => {
    const context = await harness();
    await begin(context);

    await travel(context, START, RIDE_END);

    const session = await context.repository.loadActive(RIDE_END);
    expect(
      session?.kind === "transit" && session.payload.startPackage.captures[0].stops,
    ).toHaveLength(4);
    await context.database.closeAsync();
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
    await context.database.closeAsync();
  });

  it("never publishes the rotating token", async () => {
    const context = await harness();
    await begin(context);
    await travel(context, START, RIDE_END);
    await context.coordinator.dispatch(cmd("snapshot.request", {}));

    expect(JSON.stringify(context.sent)).not.toContain(FIXTURE_TOKEN);
    await context.database.closeAsync();
  });

  it("keeps the token in the session it belongs to", async () => {
    const context = await harness();
    await begin(context);

    const session = await context.repository.loadActive(context.clock.value);

    // Native is its exclusive consumer — it lives here and in a request body.
    expect(session?.kind === "transit" && session.payload.refreshToken).toBe(FIXTURE_TOKEN);
    await context.database.closeAsync();
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
    await context.database.closeAsync();
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
    await context.database.closeAsync();
  });

  it("leaves no token, stop name or coordinate anywhere in storage after a stop", async () => {
    const context = await harness();
    await begin(context);
    await travel(context, START, RIDE_END);
    await context.coordinator.dispatch(cmd("session.stop", {}, { sessionId: "journey-t1" }));

    const dumped = JSON.stringify(await context.database.getAllAsync("SELECT * FROM terminal_ack"));
    for (const secret of [FIXTURE_TOKEN, "Hauptbahnhof", "Messe", "50.11", "trip-1"]) {
      expect(dumped).not.toContain(secret);
    }
    await context.database.closeAsync();
  });

  it("refuses a batch that arrives after the stop", async () => {
    const context = await harness();
    await begin(context);
    await context.coordinator.dispatch(cmd("session.stop", {}, { sessionId: "journey-t1" }));

    await context.coordinator.handleLocationBatch({ locations: [locationAt(RIDE_END)] });

    expect(await context.repository.loadActive(RIDE_END)).toBeNull();
    await context.database.closeAsync();
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
    await context.database.closeAsync();
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
    await context.database.closeAsync();
  });

  it("answers a snapshot request from what was committed", async () => {
    const context = await harness();
    await begin(context);
    await travel(context, START, RIDE_START);
    context.sent.length = 0;

    await context.coordinator.dispatch(cmd("snapshot.request", {}));

    expect(context.sent.some((entry) => entry.type === "snapshot.update")).toBe(true);
    await context.database.closeAsync();
  });
});
