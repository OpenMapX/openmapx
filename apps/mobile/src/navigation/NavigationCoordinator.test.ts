import {
  MOBILE_PROTOCOL_MAX,
  type MobileNavigationSession,
  type WebToNativeMessage,
} from "@openmapx/core/navigation";
import { migrateSessionSchema } from "../storage/migrations";
import { SessionRepository } from "../storage/SessionRepository";
import { openTestDatabase } from "../storage/testing/nodeSqliteDatabase";
import { groundSessionFixture } from "../storage/testing/sessionFixture";
import { EffectRunner } from "./effects";
import {
  type CommandResponse,
  type CoordinatorDeps,
  NavigationCoordinator,
} from "./NavigationCoordinator";
import { type NavigationProcessor, ProcessorRegistry } from "./processor";

const NOW = 1_700_000_100_000;

/**
 * A processor that does the minimum a real one must: advance exactly one
 * revision and record the newest fix. Ground and transit behaviour belongs to
 * their own plans; what is under test here is ordering, precondition and
 * persist-before-effect behaviour, which is identical for both.
 */
function fakeGroundProcessor(): NavigationProcessor<"ground"> {
  return {
    kind: "ground",
    needsScheduleTicks: false,
    prepare: (_startPackage, context) => ({
      ok: true,
      session: groundSessionFixture({
        sessionId: context.sessionId,
        permissionMode: context.permissionMode,
        startedAtMs: context.nowMs,
        updatedAtMs: context.nowMs,
        expiresAtMs: context.nowMs + 60 * 60_000,
      }),
    }),
    processFixes: (session, fixes, nowMs) => ({
      session: {
        ...session,
        revision: session.revision + 1,
        updatedAtMs: nowMs,
        lastAcceptedFix: {
          coords: fixes[fixes.length - 1].coords,
          accuracy: fixes[fixes.length - 1].accuracy,
          timestampMs: fixes[fixes.length - 1].timestampMs,
        },
      },
      effects: [{ kind: "publish-snapshot", immediate: false }],
    }),
    replace: (session, _replacement, nowMs) => ({
      session: { ...session, revision: session.revision + 1, updatedAtMs: nowMs },
      effects: [{ kind: "publish-snapshot", immediate: true }],
    }),
    onConnectivityRestored: async () => null,
  };
}

interface Harness {
  coordinator: NavigationCoordinator;
  repository: SessionRepository;
  sent: Array<{ type: string; payload: unknown; options: Record<string, unknown> }>;
  effectLog: string[];
  observedAtStart: Array<MobileNavigationSession | null>;
  deps: CoordinatorDeps;
  close: () => Promise<void>;
}

async function harness(
  overrides: {
    processor?: NavigationProcessor<"ground"> | null;
    permission?: "background" | "foreground-only" | "denied";
    appActive?: boolean;
    failEffect?: string;
  } = {},
): Promise<Harness> {
  const database = openTestDatabase();
  await migrateSessionSchema(database, 1_000);
  const repository = new SessionRepository(database);

  const processors = new ProcessorRegistry();
  const processor = overrides.processor === undefined ? fakeGroundProcessor() : overrides.processor;
  if (processor) processors.register(processor);

  const sent: Array<{ type: string; payload: unknown; options: Record<string, unknown> }> = [];
  const effectLog: string[] = [];
  const observedAtStart: Array<MobileNavigationSession | null> = [];
  const fail = (label: string) => async () => {
    if (label === "driver.start") observedAtStart.push(await repository.loadActive(NOW));
    effectLog.push(label);
    if (overrides.failEffect === label) throw new Error(`${label} failed`);
  };

  let sessionCounter = 0;
  const deps: CoordinatorDeps = {
    repository,
    processors,
    effects: new EffectRunner({
      driver: {
        start: fail("driver.start"),
        stop: fail("driver.stop"),
        updateProfile: fail("driver.updateProfile"),
        isRunning: async () => true,
      },
      audio: { speak: fail("audio.speak"), stop: fail("audio.stop") },
      alerts: { reconcile: fail("alerts.reconcile"), cancelSession: fail("alerts.cancelSession") },
      publish: { snapshot: fail("publish.snapshot"), event: fail("publish.event") },
      remote: {
        reroute: fail("remote.reroute"),
        transitRefresh: fail("remote.transitRefresh"),
      },
      diagnostics: { record: () => undefined },
    }),
    bridge: {
      send: (type, payload, options) => {
        sent.push({ type, payload, options: options ?? {} });
      },
    },
    permissions: {
      state: async () => "background",
      isAppActive: () => overrides.appActive !== false,
      requestForStart: async () => overrides.permission ?? "background",
    },
    driver: { isRunning: async () => true },
    diagnostics: { record: () => undefined },
    clock: () => NOW,
    newSessionId: () => {
      sessionCounter += 1;
      return `session-${sessionCounter}`;
    },
  };

  return {
    coordinator: new NavigationCoordinator(deps),
    repository,
    sent,
    effectLog,
    observedAtStart,
    deps,
    close: () => database.closeAsync(),
  };
}

let messageCounter = 0;
function cmd<T extends WebToNativeMessage["type"]>(
  type: T,
  payload: unknown,
  extra: { sessionId?: string; revision?: number; messageId?: string } = {},
): WebToNativeMessage {
  messageCounter += 1;
  return {
    protocolVersion: MOBILE_PROTOCOL_MAX,
    type,
    messageId: extra.messageId ?? `m${messageCounter}`,
    channelNonce: "nonce",
    sentAtMs: NOW,
    payload,
    ...(extra.sessionId === undefined ? {} : { sessionId: extra.sessionId }),
    ...(extra.revision === undefined ? {} : { revision: extra.revision }),
  } as WebToNativeMessage;
}

const START_PACKAGE = groundSessionFixture().payload.startPackage;

function code(response: CommandResponse | null): string {
  if (!response) return "none";
  if (response.type !== "native.error") return response.type;
  return (response.payload as { code: string }).code;
}

/** Prepares and starts a session, the usual precondition for later commands. */
async function running(context: Harness) {
  const prepared = await context.coordinator.dispatch(
    cmd("session.prepare", { startPackage: START_PACKAGE }),
  );
  const sessionId = prepared?.sessionId ?? "";
  const started = await context.coordinator.dispatch(
    cmd("session.start", {}, { sessionId, revision: 1 }),
  );
  return { sessionId, started };
}

describe("NavigationCoordinator commands", () => {
  it("prepares a session at revision 1 without starting the driver", async () => {
    const context = await harness();

    const response = await context.coordinator.dispatch(
      cmd("session.prepare", { startPackage: START_PACKAGE }),
    );

    expect(code(response)).toBe("session.prepared");
    expect(response?.revision).toBe(1);
    expect((await context.repository.loadActive(NOW))?.status).toBe("preparing");
    expect(context.effectLog).toEqual([]);
    await context.close();
  });

  it("refuses to prepare a mode with no processor", async () => {
    const context = await harness({ processor: null });

    const response = await context.coordinator.dispatch(
      cmd("session.prepare", { startPackage: START_PACKAGE }),
    );

    expect(code(response)).toBe("mode-unsupported");
    await context.close();
  });

  it("refuses to prepare over a live session", async () => {
    const context = await harness();
    await running(context);

    const response = await context.coordinator.dispatch(
      cmd("session.prepare", { startPackage: START_PACKAGE }),
    );

    expect(code(response)).toBe("session-active");
    await context.close();
  });

  it("starts only after consent, and persists before the driver runs", async () => {
    const context = await harness({ permission: "foreground-only" });

    const { started } = await running(context);

    expect(code(started)).toBe("session.started");
    expect(context.observedAtStart).toEqual([
      expect.objectContaining({ status: "active", revision: 2, permissionMode: "foreground-only" }),
    ]);
    expect((await context.repository.loadActive(NOW))?.status).toBe("active");
    expect(context.effectLog).toEqual(["driver.start", "publish.snapshot"]);
    await context.close();
  });

  it("clears the session when consent is refused", async () => {
    const context = await harness({ permission: "denied" });

    const { started } = await running(context);

    expect(code(started)).toBe("permission-denied");
    expect(await context.repository.loadActive(NOW)).toBeNull();
    await context.close();
  });

  it("refuses to start while the app is not visible", async () => {
    const context = await harness({ appActive: false });

    const { started } = await running(context);

    expect(code(started)).toBe("app-not-visible");
    expect((await context.repository.loadActive(NOW))?.status).toBe("preparing");
    await context.close();
  });

  it("terminalises the session when the driver cannot start", async () => {
    const context = await harness({ failEffect: "driver.start" });

    const { started, sessionId } = await running(context);

    expect(code(started)).toBe("driver-start-failed");
    expect(await context.repository.loadActive(NOW)).toBeNull();
    expect((await context.repository.readTerminalAck(sessionId))?.finalStatus).toBe("error");
    await context.close();
  });

  it("rejects a start whose revision is stale", async () => {
    const context = await harness();
    const prepared = await context.coordinator.dispatch(
      cmd("session.prepare", { startPackage: START_PACKAGE }),
    );

    const response = await context.coordinator.dispatch(
      cmd("session.start", {}, { sessionId: prepared?.sessionId, revision: 7 }),
    );

    expect(code(response)).toBe("revision-conflict");
    await context.close();
  });

  it("rejects a command for another session", async () => {
    const context = await harness();
    await running(context);

    const response = await context.coordinator.dispatch(
      cmd("session.replace", { startPackage: START_PACKAGE }, { sessionId: "someone-else" }),
    );

    expect(code(response)).toBe("revision-conflict");
    await context.close();
  });

  it("advances exactly one revision per replace", async () => {
    const context = await harness();
    const { sessionId } = await running(context);

    const response = await context.coordinator.dispatch(
      cmd("session.replace", { startPackage: START_PACKAGE }, { sessionId, revision: 2 }),
    );

    expect(code(response)).toBe("session.replaced");
    expect(response?.revision).toBe(3);
    expect((await context.repository.loadActive(NOW))?.revision).toBe(3);
    await context.close();
  });

  it("answers a snapshot request without mutating anything", async () => {
    const context = await harness();
    const { sessionId } = await running(context);

    const response = await context.coordinator.dispatch(cmd("snapshot.request", {}));

    expect(code(response)).toBe("snapshot.update");
    expect((await context.repository.loadActive(NOW))?.revision).toBe(2);
    expect(response?.sessionId).toBe(sessionId);
    await context.close();
  });

  it("answers a snapshot request with an empty snapshot when nothing is active", async () => {
    const context = await harness();

    const response = await context.coordinator.dispatch(cmd("snapshot.request", {}));

    expect(response?.payload).toEqual({ snapshot: {} });
    await context.close();
  });

  it("stops once and treats a repeat as success", async () => {
    const context = await harness();
    const { sessionId } = await running(context);

    await context.coordinator.handleLocationBatch({
      locations: [{ timestamp: NOW, coords: { latitude: 50.11, longitude: 8.68, accuracy: 5 } }],
    });
    const first = await context.coordinator.dispatch(cmd("session.stop", {}, { sessionId }));
    const second = await context.coordinator.dispatch(cmd("session.stop", {}, { sessionId }));

    expect(code(first)).toBe("session.stopped");
    expect(code(second)).toBe("session.stopped");
    expect(await context.repository.loadActive(NOW)).toBeNull();
    expect(context.effectLog.filter((entry) => entry === "driver.stop")).toHaveLength(1);
    expect(context.effectLog.filter((entry) => entry === "driver.start")).toHaveLength(1);
    await context.close();
  });

  it("acknowledges durable events without a reply", async () => {
    const context = await harness();
    const { sessionId } = await running(context);
    await context.repository.enqueueEvent({
      eventId: "e1",
      sessionId,
      critical: true,
      createdAtMs: NOW,
      payload: {},
    });

    const response = await context.coordinator.dispatch(
      cmd("event.ack", { eventIds: ["e1"] }, { sessionId }),
    );

    expect(response).toBeNull();
    expect(await context.repository.listPendingEvents(sessionId)).toEqual([]);
    await context.close();
  });
});

describe("NavigationCoordinator command replay", () => {
  it("returns the cached response instead of running a mutation twice", async () => {
    const context = await harness();
    const prepared = await context.coordinator.dispatch(
      cmd("session.prepare", { startPackage: START_PACKAGE }, { messageId: "prepare-1" }),
    );

    const replay = await context.coordinator.dispatch(
      cmd("session.prepare", { startPackage: START_PACKAGE }, { messageId: "prepare-1" }),
    );

    expect(replay).toEqual(prepared);
    // A second prepare would have minted a second session id.
    expect((await context.repository.loadActive(NOW))?.sessionId).toBe(prepared?.sessionId);
    await context.close();
  });

  it("replays a cached stop without a second driver stop", async () => {
    const context = await harness();
    const { sessionId } = await running(context);
    await context.coordinator.dispatch(cmd("session.stop", {}, { sessionId, messageId: "stop-1" }));
    const before = context.effectLog.length;

    await context.coordinator.dispatch(cmd("session.stop", {}, { sessionId, messageId: "stop-1" }));

    expect(context.effectLog).toHaveLength(before);
    await context.close();
  });

  it("does not cache a read-only request", async () => {
    const context = await harness();
    await running(context);

    const first = await context.coordinator.dispatch(
      cmd("snapshot.request", {}, { messageId: "snap-1" }),
    );
    await context.coordinator.dispatch(cmd("session.replace", { startPackage: START_PACKAGE }));
    const second = await context.coordinator.dispatch(
      cmd("snapshot.request", {}, { messageId: "snap-1" }),
    );

    expect(second?.revision).not.toBe(first?.revision);
    await context.close();
  });
});

describe("NavigationCoordinator location batches", () => {
  const fix = (timestamp: number, longitude = 8.68) => ({
    timestamp,
    coords: { latitude: 50.11, longitude, accuracy: 5 },
  });

  it("ignores a batch when no session is active", async () => {
    const context = await harness();

    await context.coordinator.handleLocationBatch({ locations: [fix(NOW)] });

    expect(context.effectLog).toEqual([]);
    await context.close();
  });

  it("ignores a batch for a session that is only preparing", async () => {
    const context = await harness();
    await context.coordinator.dispatch(cmd("session.prepare", { startPackage: START_PACKAGE }));

    await context.coordinator.handleLocationBatch({ locations: [fix(NOW)] });

    expect((await context.repository.loadActive(NOW))?.revision).toBe(1);
    await context.close();
  });

  it("commits one revision per batch and publishes afterwards", async () => {
    const context = await harness();
    await running(context);

    await context.coordinator.handleLocationBatch({ locations: [fix(NOW - 1_000), fix(NOW)] });

    const session = await context.repository.loadActive(NOW);
    expect(session?.revision).toBe(3);
    expect(session?.lastAcceptedFix?.timestampMs).toBe(NOW);
    expect(context.effectLog.at(-1)).toBe("publish.snapshot");
    await context.close();
  });

  it("sorts, deduplicates and clips a batch to the newest accepted fix", async () => {
    const context = await harness();
    await running(context);
    await context.coordinator.handleLocationBatch({ locations: [fix(NOW)] });
    const revisionAfterFirst = (await context.repository.loadActive(NOW))?.revision;

    // Every fix here is older than or equal to the watermark.
    await context.coordinator.handleLocationBatch({
      locations: [fix(NOW - 5_000), fix(NOW), fix(NOW - 1_000)],
    });

    expect((await context.repository.loadActive(NOW))?.revision).toBe(revisionAfterFirst);
    await context.close();
  });

  it("drops structurally invalid fixes rather than the whole batch", async () => {
    const context = await harness();
    await running(context);

    await context.coordinator.handleLocationBatch({
      locations: [
        { timestamp: NOW, coords: { latitude: 999, longitude: 0, accuracy: 5 } },
        fix(NOW + 1_000),
      ] as never,
    });

    expect((await context.repository.loadActive(NOW))?.lastAcceptedFix?.timestampMs).toBe(
      NOW + 1_000,
    );
    await context.close();
  });

  it("expires a session that outlived its lifetime instead of advancing it", async () => {
    const context = await harness();
    const { sessionId } = await running(context);
    const stale = groundSessionFixture({
      sessionId,
      status: "active",
      revision: 5,
      startedAtMs: NOW - 60_000,
      updatedAtMs: NOW - 60_000,
      expiresAtMs: NOW - 1_000,
    });
    await context.repository.terminate(sessionId, "stopped", NOW);
    await context.repository.createPreparing(stale as MobileNavigationSession);
    await context.repository.enqueueEvent({
      eventId: "expired-event",
      sessionId,
      critical: true,
      createdAtMs: NOW - 10,
      payload: { coords: [8.68, 50.11] },
    });
    await context.repository.replaceScheduledAlerts(
      sessionId,
      [{ alertId: "expired-alert", legIndex: 0, triggerAtMs: NOW + 1000 }],
      NOW,
    );

    await context.coordinator.handleLocationBatch({ locations: [fix(NOW)] });

    expect(await context.repository.loadActive(NOW)).toBeNull();
    expect((await context.repository.readTerminalAck(sessionId))?.finalStatus).toBe("expired");
    const rows = Object.fromEntries(
      (await context.repository.describeContents()).map((row) => [row.table, row.rows]),
    );
    expect(rows.navigation_events).toBe(0);
    expect(rows.scheduled_alerts).toBe(0);
    await context.close();
  });

  it("never rejects, whatever the batch contains", async () => {
    const context = await harness();
    await running(context);

    await expect(
      context.coordinator.handleLocationBatch({ locations: undefined as never }),
    ).resolves.toBeUndefined();
    await context.close();
  });
});

describe("NavigationCoordinator serialization", () => {
  const fix = (timestamp: number) => ({
    timestamp,
    coords: { latitude: 50.11, longitude: 8.68, accuracy: 5 },
  });

  it("keeps revisions monotonic when a command and a batch race", async () => {
    const context = await harness();
    const { sessionId } = await running(context);

    await Promise.all([
      context.coordinator.handleLocationBatch({ locations: [fix(NOW - 2_000)] }),
      context.coordinator.dispatch(cmd("session.replace", { startPackage: START_PACKAGE })),
      context.coordinator.handleLocationBatch({ locations: [fix(NOW - 1_000)] }),
    ]);

    expect((await context.repository.loadActive(NOW))?.revision).toBe(5);
    await context.close();
  });

  it("does not resurrect a session with a batch that arrives after the stop", async () => {
    const context = await harness();
    const { sessionId } = await running(context);

    await Promise.all([
      context.coordinator.dispatch(cmd("session.stop", {}, { sessionId })),
      context.coordinator.handleLocationBatch({ locations: [fix(NOW)] }),
    ]);

    expect(await context.repository.loadActive(NOW)).toBeNull();
    await context.close();
  });

  it("retries a background batch once when another writer wins the revision", async () => {
    const context = await harness();
    const { sessionId } = await running(context);

    // The foreground app and the headless task are separate coordinators over
    // one database, so a conflict is genuinely reachable — unlike within a
    // single instance, where the serial queue prevents it. This stands in for
    // that second writer by committing between the batch's read and its swap.
    let intercepted = false;
    const original = context.repository.compareAndSwap.bind(context.repository);
    jest
      .spyOn(context.repository, "compareAndSwap")
      .mockImplementation(async (id, expected, mutate, nowMs) => {
        if (!intercepted) {
          intercepted = true;
          await original(
            id,
            expected,
            (session) => ({ session: { ...session, revision: session.revision + 1 } }),
            nowMs,
          );
        }
        return original(id, expected, mutate, nowMs);
      });

    await context.coordinator.handleLocationBatch({ locations: [fix(NOW)] });

    // Revision 3 came from the competing writer, 4 from the retried batch.
    const session = await context.repository.loadActive(NOW);
    expect(session?.revision).toBe(4);
    expect(session?.lastAcceptedFix?.timestampMs).toBe(NOW);
    expect(sessionId).toBeTruthy();
    await context.close();
  });

  it("gives up rather than retrying a batch forever", async () => {
    const context = await harness();
    await running(context);
    const original = context.repository.compareAndSwap.bind(context.repository);
    jest
      .spyOn(context.repository, "compareAndSwap")
      .mockImplementation(async (id, expected, mutate, nowMs) => {
        await original(
          id,
          expected,
          (session) => ({ session: { ...session, revision: session.revision + 1 } }),
          nowMs,
        );
        return original(id, expected, mutate, nowMs);
      });

    await context.coordinator.handleLocationBatch({ locations: [fix(NOW)] });

    // Two competing commits, no batch commit: the batch stops trying instead of
    // spinning against a writer it can never beat.
    expect((await context.repository.loadActive(NOW))?.revision).toBe(4);
    expect((await context.repository.loadActive(NOW))?.lastAcceptedFix).toBeUndefined();
    await context.close();
  });
});

describe("NavigationCoordinator storage cleanup", () => {
  const fix = (timestamp: number) => ({
    timestamp,
    coords: { latitude: 50.11, longitude: 8.68, accuracy: 5 },
  });

  /** The developer-only dump: row counts and column names, never values. */
  async function dump(context: Harness) {
    return context.repository.describeContents();
  }

  it.each(["session.stop", "session.complete"] as const)(
    "leaves nothing location-bearing after %s",
    async (command) => {
      const context = await harness();
      const { sessionId } = await running(context);
      await context.coordinator.handleLocationBatch({ locations: [fix(NOW)] });
      await context.repository.enqueueEvent({
        eventId: "e1",
        sessionId,
        critical: true,
        createdAtMs: NOW,
        payload: { coords: [8.68, 50.11] },
      });
      await context.repository.replaceScheduledAlerts(
        sessionId,
        [{ alertId: "a1", legIndex: 0, triggerAtMs: NOW }],
        NOW,
      );

      await context.coordinator.dispatch(cmd(command, {}, { sessionId }));

      const rows = Object.fromEntries((await dump(context)).map((e) => [e.table, e.rows]));
      expect(rows.active_navigation).toBe(0);
      expect(rows.navigation_events).toBe(0);
      expect(rows.scheduled_alerts).toBe(0);
      // The acknowledgement survives, because a reloaded page needs an outcome.
      expect(rows.terminal_ack).toBe(1);
      const ack = await context.repository.readTerminalAck(sessionId);
      expect(ack).toEqual({
        sessionId,
        kind: "ground",
        finalStatus: command === "session.complete" ? "arrived" : "stopped",
        finalRevision: expect.any(Number),
        completedAtMs: NOW,
      });

      // One command response also survives: the stop's own, written after the
      // cleanup so a retried stop returns the same answer instead of running
      // again. It holds the same non-sensitive envelope as the acknowledgement.
      expect(rows.processed_commands).toBe(1);
      await context.close();
    },
  );

  it("stores nothing location-bearing in the surviving stop response", async () => {
    const context = await harness();
    const { sessionId } = await running(context);
    await context.coordinator.handleLocationBatch({ locations: [fix(NOW)] });

    await context.coordinator.dispatch(
      cmd("session.stop", {}, { sessionId, messageId: "stop-final" }),
    );

    const cached = JSON.stringify(await context.repository.lookupCommand("stop-final", NOW));
    expect(cached).toContain("session.stopped");
    for (const forbidden of [
      "50.11",
      "8.68",
      "geometry",
      "refreshToken",
      "instruction",
      "coords",
    ]) {
      expect(cached).not.toContain(forbidden);
    }
    await context.close();
  });
});

describe("NavigationCoordinator effects", () => {
  it("continues cleanup when one effect fails", async () => {
    const context = await harness({ failEffect: "audio.stop" });
    const { sessionId } = await running(context);
    context.effectLog.length = 0;

    await context.coordinator.dispatch(cmd("session.stop", {}, { sessionId }));

    expect(context.effectLog).toEqual([
      "driver.stop",
      "alerts.cancelSession",
      "audio.stop",
      "publish.snapshot",
    ]);
    await context.close();
  });

  it("strips captured transit refresh material from the requested snapshot", async () => {
    const context = await harness();
    const { transitSessionFixture } = require("./transit/testing/transitFixture");
    const transit = transitSessionFixture();
    transit.payload.refreshToken = "private-refresh-material";
    await context.repository.createPreparing(transit);

    const response = await context.coordinator.dispatch(cmd("snapshot.request", {}));

    expect(response?.payload).toMatchObject({
      snapshot: { kind: "transit", sessionId: transit.sessionId, type: "full" },
    });
    expect(JSON.stringify(response?.payload)).not.toContain("private-refresh-material");
    expect(JSON.stringify(response?.payload)).not.toContain("refreshToken");
    await context.close();
  });

  it("names the command each direct response answers", async () => {
    const context = await harness();
    const prepared = await context.coordinator.dispatch(
      cmd("session.prepare", { startPackage: START_PACKAGE }, { messageId: "prepare-command" }),
    );
    await context.coordinator.dispatch(
      cmd(
        "session.start",
        {},
        {
          messageId: "start-command",
          sessionId: prepared?.sessionId,
          revision: 1,
        },
      ),
    );

    expect(context.sent.map((entry) => entry.type)).toEqual([
      "session.prepared",
      "session.started",
    ]);
    expect(context.sent.map((entry) => entry.options.forMessageId)).toEqual([
      "prepare-command",
      "start-command",
    ]);
    await context.close();
  });
});

describe("NavigationCoordinator reroute answers", () => {
  /** A running session whose engine has asked for reroute `requestId`. */
  async function awaitingReroute(context: Harness, requestId = "reroute-1") {
    const { sessionId } = await running(context);
    const current = await context.repository.loadActive(NOW);
    if (current?.kind !== "ground") throw new Error("no ground session");
    await context.repository.compareAndSwap(
      sessionId,
      current.revision,
      (session) => ({
        session: {
          ...session,
          revision: session.revision + 1,
          payload: {
            ...(session as typeof current).payload,
            reroute: { status: "pending", requestId, attempts: 2 },
          },
        } as MobileNavigationSession,
        effects: [],
      }),
      NOW,
    );
    const pending = await context.repository.loadActive(NOW);
    return { sessionId, revision: pending?.revision ?? 0 };
  }

  const groundOf = async (context: Harness) => {
    const session = await context.repository.loadActive(NOW);
    if (session?.kind !== "ground") throw new Error("no ground session");
    return session;
  };

  it("replaces the route and clears the failure history for the current request", async () => {
    const context = await harness();
    const { sessionId, revision } = await awaitingReroute(context);

    await context.coordinator.applyReroute({
      ok: true,
      requestId: "reroute-1",
      sessionId,
      baseRevision: revision,
      route: START_PACKAGE,
    });

    const session = await groundOf(context);
    expect(session.revision).toBe(revision + 1);
    expect(session.payload.reroute).toEqual({ status: "idle", attempts: 0 });
    expect(context.effectLog).toContain("publish.snapshot");
    await context.close();
  });

  it("drops an answer to a request the session no longer waits for", async () => {
    const context = await harness();
    const { sessionId, revision } = await awaitingReroute(context, "reroute-2");

    await context.coordinator.applyReroute({
      ok: true,
      requestId: "reroute-1",
      sessionId,
      baseRevision: revision,
      route: START_PACKAGE,
    });

    expect((await groundOf(context)).revision).toBe(revision);
    await context.close();
  });

  it("records a failure with a backoff so the engine can ask again later", async () => {
    const context = await harness();
    const { sessionId, revision } = await awaitingReroute(context);

    await context.coordinator.applyReroute({
      ok: false,
      requestId: "reroute-1",
      sessionId,
      baseRevision: revision,
      code: "network",
    });

    const { reroute } = (await groundOf(context)).payload;
    expect(reroute.status).toBe("pending");
    expect(reroute.attempts).toBe(3);
    expect(reroute.lastFailureCode).toBe("network");
    expect(reroute.nextAttemptAtMs).toBeGreaterThan(NOW);
    await context.close();
  });

  it("ignores a request this side aborted", async () => {
    const context = await harness();
    const { sessionId, revision } = await awaitingReroute(context);

    await context.coordinator.applyReroute({
      ok: false,
      requestId: "reroute-1",
      sessionId,
      baseRevision: revision,
      code: "aborted",
    });

    expect((await groundOf(context)).revision).toBe(revision);
    await context.close();
  });

  it("does nothing once the session has stopped", async () => {
    const context = await harness();
    const { sessionId, revision } = await awaitingReroute(context);
    await context.coordinator.dispatch(cmd("session.stop", {}, { sessionId }));

    await context.coordinator.applyReroute({
      ok: true,
      requestId: "reroute-1",
      sessionId,
      baseRevision: revision,
      route: START_PACKAGE,
    });

    expect(await context.repository.loadActive(NOW)).toBeNull();
    await context.close();
  });
});

describe("native rider action authority", () => {
  it.each(["walking", "waiting-to-board"] as const)(
    "commits against journey identity despite intervening revisions/phase %s, and deduplicates retries",
    async (phase) => {
      const context = await harness();
      const { TransitNavigationProcessor } = require("./transit/TransitNavigationProcessor");
      const { transitSessionFixture } = require("./transit/testing/transitFixture");
      context.deps.processors.register(new TransitNavigationProcessor());
      const s = transitSessionFixture({ revision: 9 });
      if (phase === "waiting-to-board") {
        s.payload.tickState.currentLegIndex = 1;
        s.payload.tickState.phase = phase;
      }
      await context.repository.createPreparing(s);
      const payload = {
        actionId: "board-1",
        itineraryFingerprint: s.payload.startPackage.itineraryFingerprint,
        expectedPhase: "walking",
        type: "board",
        legIndex: 1,
      };
      const response = await context.coordinator.dispatch(
        cmd("transit.action", payload, { sessionId: s.sessionId, revision: 1 }),
      );
      expect(code(response)).toBe("snapshot.update");
      const saved = await context.repository.loadActive(NOW);
      expect(saved?.kind === "transit" && saved.payload.tickState.phase).toBe("riding");
      expect(saved?.revision).toBe(10);
      const duplicate = await context.coordinator.dispatch(
        cmd("transit.action", payload, { sessionId: s.sessionId }),
      );
      expect(code(duplicate)).toBe("snapshot.update");
      expect((await context.repository.loadActive(NOW))?.revision).toBe(10);
      const wrong = await context.coordinator.dispatch(
        cmd(
          "transit.action",
          { ...payload, actionId: "wrong", itineraryFingerprint: "other" },
          { sessionId: s.sessionId },
        ),
      );
      expect(code(wrong)).toBe("revision-conflict");
      await context.close();
    },
  );
});

describe("native surface stop", () => {
  it("uses durable teardown and emits an unsolicited matching stopped event", async () => {
    const h = await harness();
    try {
      await h.repository.createPreparing(groundSessionFixture({ status: "active" }));
      expect(await h.coordinator.stopFromSurface("old-session")).toBe(false);
      expect((await h.repository.loadActive(NOW))?.sessionId).toBe("session-1");
      expect(await h.coordinator.stopFromSurface("session-1")).toBe(true);
      expect(await h.repository.loadActive(NOW)).toBeNull();
      expect(
        h.sent.some((m) => m.type === "session.stopped" && !("forMessageId" in m.options)),
      ).toBe(true);
      expect(h.effectLog).toContain("driver.stop");
      expect(await h.coordinator.stopFromSurface("session-1")).toBe(false);
    } finally {
      await h.close();
    }
  });
});

it("refuses intake routed to an uncomposed navigation coordinator without changing a trip", async () => {
  const h = await harness();
  try {
    const response = await h.coordinator.dispatch({
      protocolVersion: MOBILE_PROTOCOL_MAX,
      type: "intake.list",
      messageId: "intake-uncomposed",
      channelNonce: "nonce",
      sentAtMs: NOW,
      payload: {},
    });
    expect(response).toMatchObject({
      type: "native.error",
      payload: { code: "unsupported-capability" },
    });
    expect(await h.repository.loadActive(NOW)).toBeNull();
    expect(h.effectLog).toEqual([]);
  } finally {
    await h.close();
  }
});

describe("car starts share the coordinator authority", () => {
  const context = () =>
    ({ kind: "car", hostAuthorized: true, locationServiceStartAllowed: true }) as const;
  it("starts while the phone is invisible with a typed authorized car context", async () => {
    const h = await harness({ appActive: false, permission: "background" });
    try {
      const result = await h.coordinator.startCarTrip(
        groundSessionFixture().payload.startPackage,
        context,
        () => true,
      );
      expect(result?.type).toBe("session.started");
      expect(h.effectLog.filter((entry) => entry === "driver.start")).toHaveLength(1);
      expect(h.sent.some((entry) => entry.type === "session.started")).toBe(true);
    } finally {
      await h.close();
    }
  });
  it("rejects expired command generations and unconfirmed replacements", async () => {
    const h = await harness({ appActive: false, permission: "background" });
    try {
      const startPackage = groundSessionFixture().payload.startPackage;
      const cancelled = await h.coordinator.startCarTrip(startPackage, context, () => false);
      expect(cancelled?.type).toBe("native.error");
      expect(h.effectLog).toEqual([]);
      const first = await h.coordinator.startCarTrip(startPackage, context, () => true);
      const unconfirmed = await h.coordinator.startCarTrip(startPackage, context, () => true);
      expect(unconfirmed?.payload).toMatchObject({ code: "session-active" });
      expect((await h.repository.loadActive(NOW))?.sessionId).toBe(first?.sessionId);
      const replacement = await h.coordinator.startCarTrip(
        startPackage,
        context,
        () => true,
        first?.sessionId,
      );
      expect(replacement?.type).toBe("session.started");
      expect(h.effectLog.filter((entry) => entry === "driver.stop")).toHaveLength(1);
    } finally {
      await h.close();
    }
  });
  it("requires the background grant even when a host is connected", async () => {
    const h = await harness({ appActive: false, permission: "foreground-only" });
    h.deps.permissions.state = async () => "foreground";
    try {
      const result = await h.coordinator.startCarTrip(
        groundSessionFixture().payload.startPackage,
        context,
        () => true,
      );
      expect(result?.payload).toMatchObject({ code: "app-not-visible" });
      expect(h.effectLog).toEqual([]);
    } finally {
      await h.close();
    }
  });
});

it("updates hosted captures without resurrecting an itinerary refresh handle", async () => {
  const context = await harness();
  const { transitSessionFixture } = require("./transit/testing/transitFixture");
  const s = transitSessionFixture();
  s.payload.refreshToken = null;
  s.payload.refresh = {
    status: "in-flight",
    generation: 2,
    requestId: "captures-only",
    attempts: 0,
  };
  await context.repository.createPreparing(s);
  await context.coordinator.applyTransitRefresh({
    ok: true,
    sessionId: s.sessionId,
    requestId: "captures-only",
    generation: 2,
    capturesOnly: true,
    itinerary: s.payload.startPackage.itinerary,
    journeys: {},
  });
  const updated = await context.repository.loadActive(NOW);
  expect(updated?.kind).toBe("transit");
  if (updated?.kind !== "transit") throw new Error("Missing session");
  expect(updated.payload.refreshToken).toBeNull();
  expect(updated.payload.refresh.status).toBe("ready");
  await context.close();
});

describe("NavigationCoordinator settings changes", () => {
  it("applies the patch on top of a revision committed by a writer outside the queue", async () => {
    const context = await harness();
    const { sessionId } = await running(context);
    const swap = context.repository.compareAndSwap.bind(context.repository);
    let interleaved = false;
    jest.spyOn(context.repository, "compareAndSwap").mockImplementation(async (...args) => {
      if (!interleaved) {
        interleaved = true;
        // Another writer commits progress between the read and the swap.
        const current = await context.repository.loadActive(NOW);
        if (!current) throw new Error("Missing session");
        await swap(
          current.sessionId,
          current.revision,
          (session) => ({ session: { ...session, revision: session.revision + 1 } }),
          NOW,
        );
      }
      return swap(...args);
    });

    const response = await context.coordinator.dispatch(
      cmd("settings.update", { voiceEnabled: false, keepScreenOn: false }, { sessionId }),
    );

    expect(code(response)).toBe("snapshot.update");
    const session = await context.repository.loadActive(NOW);
    if (session?.kind !== "ground") throw new Error("Missing session");
    expect(session.revision).toBe(4);
    expect(session.payload.startPackage.settings).toMatchObject({
      voiceEnabled: false,
      keepScreenOn: false,
    });
    expect(context.effectLog).toContain("audio.stop");
    await context.close();
  });
});
