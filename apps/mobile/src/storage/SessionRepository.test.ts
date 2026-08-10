import type { MobileNavigationSession } from "@openmapx/core/navigation";
import type { Database } from "./database";
import { migrateSessionSchema } from "./migrations";
import {
  MAX_DIAGNOSTIC_ROWS,
  MAX_OUTBOX_EVENTS,
  MAX_PROCESSED_COMMANDS,
  MAX_QUARANTINE_RECORDS,
  PROCESSED_COMMAND_TTL_MS,
  type RepositoryMutation,
  SessionRepository,
} from "./SessionRepository";
import { UPSERT_ACTIVE } from "./sql";
import { openTestDatabase } from "./testing/nodeSqliteDatabase";
import { groundSessionFixture, nextRevision } from "./testing/sessionFixture";

const NOW = 1_700_000_100_000;

async function freshRepository(): Promise<{ database: Database; repository: SessionRepository }> {
  const database = openTestDatabase();
  await migrateSessionSchema(database, 1_000);
  return { database, repository: new SessionRepository(database) };
}

/** Bumps the revision and marks the session active, the common committed shape. */
const activate = (current: MobileNavigationSession): RepositoryMutation => ({
  session: nextRevision(current, { status: "active" }),
  effects: [{ kind: "publish-snapshot", immediate: true }],
});

describe("SessionRepository", () => {
  describe("createPreparing", () => {
    it("writes the first revision when nothing is active", async () => {
      const { repository, database } = await freshRepository();
      const session = groundSessionFixture();

      const result = await repository.createPreparing(session);

      expect(result.ok).toBe(true);
      const loaded = await repository.loadActive(NOW);
      expect(loaded?.sessionId).toBe("session-1");
      expect(loaded?.revision).toBe(1);
      await database.closeAsync();
    });

    it("refuses to displace a live session", async () => {
      const { repository, database } = await freshRepository();
      await repository.createPreparing(groundSessionFixture({ status: "active" }));

      const result = await repository.createPreparing(
        groundSessionFixture({ sessionId: "session-2" }),
      );

      expect(result).toEqual({ ok: false, code: "session-active" });
      expect((await repository.loadActive(NOW))?.sessionId).toBe("session-1");
      await database.closeAsync();
    });

    it("replaces a finished session and clears its rows", async () => {
      const { repository, database } = await freshRepository();
      await repository.createPreparing(groundSessionFixture({ status: "stopped" }));
      await repository.enqueueEvent({
        eventId: "e1",
        sessionId: "session-1",
        critical: true,
        createdAtMs: NOW,
        payload: { type: "arrived" },
      });

      const result = await repository.createPreparing(
        groundSessionFixture({ sessionId: "session-2" }),
      );

      expect(result.ok).toBe(true);
      expect(await repository.listPendingEvents("session-1")).toEqual([]);
      await database.closeAsync();
    });
  });

  describe("compareAndSwap", () => {
    it("commits when the expected revision is current", async () => {
      const { repository, database } = await freshRepository();
      await repository.createPreparing(groundSessionFixture());

      const result = await repository.compareAndSwap("session-1", 1, activate, NOW);

      expect(result.ok && result.session.revision).toBe(2);
      expect(result.ok && result.effects).toEqual([{ kind: "publish-snapshot", immediate: true }]);
      await database.closeAsync();
    });

    it("lets exactly one of two competing writers win", async () => {
      const { repository, database } = await freshRepository();
      await repository.createPreparing(groundSessionFixture());

      const [first, second] = await Promise.all([
        repository.compareAndSwap(
          "session-1",
          1,
          (current) => ({
            session: nextRevision(current, { status: "active" }),
            enqueue: [{ eventId: "winner", critical: true, payload: { from: "first" } }],
          }),
          NOW,
        ),
        repository.compareAndSwap(
          "session-1",
          1,
          (current) => ({
            session: nextRevision(current, { status: "error" }),
            enqueue: [{ eventId: "loser", critical: true, payload: { from: "second" } }],
          }),
          NOW,
        ),
      ]);

      const outcomes = [first, second];
      expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
      expect(outcomes.filter((outcome) => !outcome.ok)).toEqual([
        { ok: false, code: "revision-conflict" },
      ]);

      const loaded = await repository.loadActive(NOW);
      expect(loaded?.revision).toBe(2);

      // The loser must leave nothing behind: no half-written outbox row.
      const events = await repository.listPendingEvents("session-1");
      expect(events).toHaveLength(1);
      expect(events[0].eventId).toBe("winner");
      await database.closeAsync();
    });

    it("reports a conflict for a stale revision", async () => {
      const { repository, database } = await freshRepository();
      await repository.createPreparing(groundSessionFixture());
      await repository.compareAndSwap("session-1", 1, activate, NOW);

      const stale = await repository.compareAndSwap("session-1", 1, activate, NOW);

      expect(stale).toEqual({ ok: false, code: "revision-conflict" });
      await database.closeAsync();
    });

    it("reports a conflict for another session's revision", async () => {
      const { repository, database } = await freshRepository();
      await repository.createPreparing(groundSessionFixture());

      const other = await repository.compareAndSwap("session-9", 1, activate, NOW);

      expect(other).toEqual({ ok: false, code: "revision-conflict" });
      await database.closeAsync();
    });

    it("reports no active session when authority is empty", async () => {
      const { repository, database } = await freshRepository();

      const result = await repository.compareAndSwap("session-1", 1, activate, NOW);

      expect(result).toEqual({ ok: false, code: "no-active-session" });
      await database.closeAsync();
    });

    it("refuses a mutation that skips or repeats a revision", async () => {
      const { repository, database } = await freshRepository();
      await repository.createPreparing(groundSessionFixture());

      await expect(
        repository.compareAndSwap(
          "session-1",
          1,
          (current) => ({ session: { ...current, revision: 5 } }),
          NOW,
        ),
      ).rejects.toThrow(/exactly one/);
      expect((await repository.loadActive(NOW))?.revision).toBe(1);
      await database.closeAsync();
    });

    it("refuses a mutation that changes the session identity", async () => {
      const { repository, database } = await freshRepository();
      await repository.createPreparing(groundSessionFixture());

      await expect(
        repository.compareAndSwap(
          "session-1",
          1,
          (current) => ({ session: nextRevision(current, { sessionId: "hijacked" }) }),
          NOW,
        ),
      ).rejects.toThrow(/session identity/);
      expect((await repository.loadActive(NOW))?.sessionId).toBe("session-1");
      await database.closeAsync();
    });
  });

  describe("crash boundaries", () => {
    it("rolls back completely when the mutation throws mid-transaction", async () => {
      const { repository, database } = await freshRepository();
      await repository.createPreparing(groundSessionFixture());

      await expect(
        repository.compareAndSwap(
          "session-1",
          1,
          () => {
            throw new Error("processor exploded");
          },
          NOW,
        ),
      ).rejects.toThrow("processor exploded");

      const loaded = await repository.loadActive(NOW);
      expect(loaded?.revision).toBe(1);
      expect(loaded?.status).toBe("preparing");
      expect(await repository.listPendingEvents("session-1")).toEqual([]);
      await database.closeAsync();
    });

    it("keeps the whole commit when the caller dies after it returns", async () => {
      const { database, repository } = await freshRepository();
      await repository.createPreparing(groundSessionFixture());

      const committed = await repository.compareAndSwap(
        "session-1",
        1,
        (current) => ({
          session: nextRevision(current, { status: "active" }),
          enqueue: [{ eventId: "e1", critical: true, payload: { type: "started" } }],
          alerts: [{ alertId: "a1", legIndex: 0, triggerAtMs: NOW + 60_000 }],
          effects: [{ kind: "start-location", permissionMode: "background" }],
        }),
        NOW,
      );
      expect(committed.ok).toBe(true);

      // Nothing runs the effects: this models the process dying between commit
      // and side effect. A restart must still see the complete new state.
      const restarted = new SessionRepository(database);
      expect((await restarted.loadActive(NOW))?.status).toBe("active");
      expect(await restarted.listPendingEvents("session-1")).toHaveLength(1);
      expect(await restarted.listScheduledAlerts("session-1")).toHaveLength(1);
      await database.closeAsync();
    });

    it("commits the session, its events and its alerts atomically", async () => {
      const { repository, database } = await freshRepository();
      await repository.createPreparing(groundSessionFixture());

      await expect(
        repository.compareAndSwap(
          "session-1",
          1,
          (current) => ({
            session: nextRevision(current, { status: "active" }),
            enqueue: [{ eventId: "e1", critical: true, payload: { type: "started" } }],
            // The second alert violates the non-negative leg constraint, so the
            // failure lands after the session row and the event have been
            // written inside this same transaction.
            alerts: [
              { alertId: "a1", legIndex: 0, triggerAtMs: NOW },
              { alertId: "a1", legIndex: -1, triggerAtMs: NOW },
            ],
          }),
          NOW,
        ),
      ).rejects.toThrow();

      const loaded = await repository.loadActive(NOW);
      expect(loaded?.status).toBe("preparing");
      expect(await repository.listPendingEvents("session-1")).toEqual([]);
      expect(await repository.listScheduledAlerts("session-1")).toEqual([]);
      await database.closeAsync();
    });
  });

  describe("corruption", () => {
    async function withCorruptRow(json: string) {
      const { database, repository } = await freshRepository();
      await database.runAsync(UPSERT_ACTIVE, ["session-1", 3, "ground", "active", 1, 1, 2, json]);
      return { database, repository };
    }

    it("quarantines malformed JSON once and clears authority", async () => {
      const { database, repository } = await withCorruptRow("{not json");

      expect(await repository.loadActive(NOW)).toBeNull();

      const quarantined = await repository.listQuarantined();
      expect(quarantined).toHaveLength(1);
      expect(quarantined[0].sessionId).toBe("session-1");
      expect(quarantined[0].reason).toBe("invalid-session");

      // The second load finds nothing to quarantine, so it cannot crash-loop.
      expect(await repository.loadActive(NOW)).toBeNull();
      expect(await repository.listQuarantined()).toHaveLength(1);
      await database.closeAsync();
    });

    it("quarantines an unsupported schema version separately", async () => {
      const { database, repository } = await withCorruptRow(
        JSON.stringify({ ...groundSessionFixture(), schemaVersion: 99 }),
      );

      expect(await repository.loadActive(NOW)).toBeNull();
      expect((await repository.listQuarantined())[0].reason).toBe("unsupported-schema");
      await database.closeAsync();
    });

    it("never stores the original session JSON", async () => {
      const secret = JSON.stringify({
        schemaVersion: 1,
        sessionId: "session-1",
        refreshToken: "tok_should_never_persist",
        coords: [8.68, 50.11],
      });
      const { database, repository } = await withCorruptRow(secret);

      await repository.loadActive(NOW);

      const rows = await database.getAllAsync<Record<string, unknown>>(
        "SELECT * FROM quarantined_sessions",
      );
      expect(JSON.stringify(rows)).not.toContain("tok_should_never_persist");
      expect(JSON.stringify(rows)).not.toContain("50.11");
      await database.closeAsync();
    });

    it("keeps at most three quarantine records", async () => {
      const { database, repository } = await freshRepository();
      for (let index = 0; index < MAX_QUARANTINE_RECORDS + 3; index += 1) {
        await repository.quarantineCorruptSession(`s${index}`, "invalid-session", NOW + index);
      }

      const quarantined = await repository.listQuarantined();
      expect(quarantined).toHaveLength(MAX_QUARANTINE_RECORDS);
      expect(quarantined.map((record) => record.sessionId)).toEqual(["s5", "s4", "s3"]);
      await database.closeAsync();
    });

    it("truncates an over-long quarantine reason", async () => {
      const { database, repository } = await freshRepository();
      await repository.quarantineCorruptSession("s", "x".repeat(500), NOW);

      expect((await repository.listQuarantined())[0].reason).toHaveLength(64);
      await database.closeAsync();
    });
  });

  describe("outbox", () => {
    it("preserves enqueue order and survives acknowledgement of a subset", async () => {
      const { database, repository } = await freshRepository();
      for (const id of ["a", "b", "c"]) {
        await repository.enqueueEvent({
          eventId: id,
          sessionId: "session-1",
          critical: false,
          createdAtMs: NOW,
          payload: { id },
        });
      }

      await repository.ackEvents(["a", "c"]);

      expect((await repository.listPendingEvents("session-1")).map((e) => e.eventId)).toEqual([
        "b",
      ]);
      await database.closeAsync();
    });

    it("ignores a duplicate event id", async () => {
      const { database, repository } = await freshRepository();
      const event = {
        eventId: "a",
        sessionId: "session-1",
        critical: true,
        createdAtMs: NOW,
        payload: { n: 1 },
      };
      await repository.enqueueEvent(event);
      await repository.enqueueEvent({ ...event, payload: { n: 2 } });

      const pending = await repository.listPendingEvents("session-1");
      expect(pending).toHaveLength(1);
      expect(pending[0].payload).toEqual({ n: 1 });
      await database.closeAsync();
    });

    it("compacts non-critical events to make room rather than dropping a critical one", async () => {
      const { database, repository } = await freshRepository();
      for (let index = 0; index < MAX_OUTBOX_EVENTS; index += 1) {
        await repository.enqueueEvent({
          eventId: `snapshot-${index}`,
          sessionId: "session-1",
          // One critical event among the filler, to prove compaction spares it.
          critical: index === 0,
          createdAtMs: NOW + index,
          payload: { index },
        });
      }

      await repository.enqueueEvent({
        eventId: "critical",
        sessionId: "session-1",
        critical: true,
        createdAtMs: NOW + 1_000,
        payload: { type: "missed-connection" },
      });

      const pending = await repository.listPendingEvents("session-1");
      expect(pending.map((event) => event.eventId)).toEqual(["snapshot-0", "critical"]);
      await database.closeAsync();
    });

    it("refuses a new event when the queue is full of critical ones", async () => {
      const { database, repository } = await freshRepository();
      for (let index = 0; index < MAX_OUTBOX_EVENTS; index += 1) {
        await repository.enqueueEvent({
          eventId: `critical-${index}`,
          sessionId: "session-1",
          critical: true,
          createdAtMs: NOW + index,
          payload: { index },
        });
      }

      await repository.enqueueEvent({
        eventId: "overflow",
        sessionId: "session-1",
        critical: true,
        createdAtMs: NOW + 1_000,
        payload: {},
      });

      const pending = await repository.listPendingEvents("session-1");
      expect(pending).toHaveLength(MAX_OUTBOX_EVENTS);
      expect(pending.map((event) => event.eventId)).not.toContain("overflow");
      await database.closeAsync();
    });
  });

  describe("command dedupe", () => {
    it("returns the exact prior response for a replayed message", async () => {
      const { database, repository } = await freshRepository();
      const response = { type: "native.ack", status: "accepted", revision: 2 };
      await repository.rememberCommand("m1", "session-1", response, NOW);

      expect(await repository.lookupCommand("m1", NOW + 1_000)).toEqual(response);
      await database.closeAsync();
    });

    it("does not overwrite a remembered response on replay", async () => {
      const { database, repository } = await freshRepository();
      await repository.rememberCommand("m1", "session-1", { first: true }, NOW);
      await repository.rememberCommand("m1", "session-1", { first: false }, NOW + 10);

      expect(await repository.lookupCommand("m1", NOW + 20)).toEqual({ first: true });
      await database.closeAsync();
    });

    it("forgets a response once it expires", async () => {
      const { database, repository } = await freshRepository();
      await repository.rememberCommand("m1", "session-1", { ok: true }, NOW);

      expect(await repository.lookupCommand("m1", NOW + PROCESSED_COMMAND_TTL_MS)).toBeNull();
      await database.closeAsync();
    });

    it("evicts expired rows and caps the table by count", async () => {
      const { database, repository } = await freshRepository();
      await repository.rememberCommand("old", "session-1", {}, NOW - PROCESSED_COMMAND_TTL_MS * 2);
      for (let index = 0; index < MAX_PROCESSED_COMMANDS + 5; index += 1) {
        await repository.rememberCommand(`m${index}`, "session-1", { index }, NOW + index);
      }

      const count = await database.getFirstAsync<{ n: number }>(
        "SELECT COUNT(*) AS n FROM processed_commands",
      );
      expect(count?.n).toBe(MAX_PROCESSED_COMMANDS);
      expect(await repository.lookupCommand("old", NOW)).toBeNull();
      // The oldest survivors are evicted before the newest.
      expect(await repository.lookupCommand("m0", NOW + 10_000)).toBeNull();
      expect(await repository.lookupCommand(`m${MAX_PROCESSED_COMMANDS + 4}`, NOW)).toEqual({
        index: MAX_PROCESSED_COMMANDS + 4,
      });
      await database.closeAsync();
    });
  });

  describe("scheduled alerts", () => {
    it("replaces the whole set for a session", async () => {
      const { database, repository } = await freshRepository();
      await repository.replaceScheduledAlerts(
        "session-1",
        [
          { alertId: "a1", legIndex: 0, triggerAtMs: NOW + 1_000 },
          { alertId: "a2", legIndex: 1, triggerAtMs: NOW + 2_000 },
        ],
        NOW,
      );

      await repository.replaceScheduledAlerts(
        "session-1",
        [{ alertId: "a3", legIndex: 2, triggerAtMs: NOW + 3_000 }],
        NOW,
      );

      expect((await repository.listScheduledAlerts("session-1")).map((a) => a.alertId)).toEqual([
        "a3",
      ]);
      await database.closeAsync();
    });

    it("records a fired alert without deleting its identity", async () => {
      const { database, repository } = await freshRepository();
      await repository.replaceScheduledAlerts(
        "session-1",
        [{ alertId: "a1", legIndex: 0, triggerAtMs: NOW }],
        NOW,
      );

      await repository.markAlert("a1", "fired", NOW + 100);

      expect((await repository.listScheduledAlerts("session-1"))[0].state).toBe("fired");
      await database.closeAsync();
    });
  });

  describe("terminate", () => {
    it("writes a non-sensitive acknowledgement and removes everything else", async () => {
      const { database, repository } = await freshRepository();
      await repository.createPreparing(groundSessionFixture({ status: "active", revision: 4 }));
      await repository.enqueueEvent({
        eventId: "e1",
        sessionId: "session-1",
        critical: true,
        createdAtMs: NOW,
        payload: { coords: [8.68, 50.11] },
      });
      await repository.replaceScheduledAlerts(
        "session-1",
        [{ alertId: "a1", legIndex: 0, triggerAtMs: NOW }],
        NOW,
      );
      await repository.rememberCommand("m1", "session-1", { ok: true }, NOW);

      const { ack, effects } = await repository.terminate("session-1", "arrived", NOW);

      expect(ack).toEqual({
        sessionId: "session-1",
        kind: "ground",
        finalStatus: "arrived",
        finalRevision: 4,
        completedAtMs: NOW,
      });
      expect(effects).toEqual([
        { kind: "stop-location" },
        { kind: "stop-audio" },
        { kind: "cancel-session-alerts", sessionId: "session-1" },
      ]);
      expect(await repository.loadActive(NOW)).toBeNull();
      expect(await repository.listPendingEvents("session-1")).toEqual([]);
      expect(await repository.listScheduledAlerts("session-1")).toEqual([]);
      expect(await repository.lookupCommand("m1", NOW)).toBeNull();
      await database.closeAsync();
    });

    it("leaves nothing location-bearing in the database", async () => {
      const { database, repository } = await freshRepository();
      await repository.createPreparing(groundSessionFixture({ status: "active" }));
      await repository.terminate("session-1", "stopped", NOW);

      const dump = await database.getAllAsync<Record<string, unknown>>(
        "SELECT * FROM terminal_ack",
      );
      const serialised = JSON.stringify(dump);
      for (const forbidden of ["50.1", "8.6", "geometry", "refreshToken", "instruction"]) {
        expect(serialised).not.toContain(forbidden);
      }
      await database.closeAsync();
    });

    it("is idempotent and ignores an unknown session", async () => {
      const { database, repository } = await freshRepository();
      await repository.createPreparing(groundSessionFixture({ status: "active" }));
      await repository.terminate("session-1", "stopped", NOW);

      const second = await repository.terminate("session-1", "stopped", NOW + 10);
      const other = await repository.terminate("session-9", "stopped", NOW + 10);

      expect(second.ack).toBeNull();
      expect(second.effects).toEqual([]);
      expect(other.ack).toBeNull();
      // The first acknowledgement is preserved rather than overwritten by a retry.
      expect((await repository.readTerminalAck("session-1"))?.completedAtMs).toBe(NOW);
      await database.closeAsync();
    });

    it("allows a new session after termination", async () => {
      const { database, repository } = await freshRepository();
      await repository.createPreparing(groundSessionFixture({ status: "active" }));
      await repository.terminate("session-1", "arrived", NOW);

      const result = await repository.createPreparing(
        groundSessionFixture({ sessionId: "session-2" }),
      );

      expect(result.ok).toBe(true);
      await database.closeAsync();
    });
  });

  describe("diagnostics", () => {
    it("keeps the ring under the row ceiling", async () => {
      const { database, repository } = await freshRepository();
      for (let index = 0; index < MAX_DIAGNOSTIC_ROWS + 50; index += 1) {
        await repository.recordDiagnostic("engine.timing", { bucket: index % 5 }, NOW + index);
      }

      const rows = await repository.listDiagnostics();
      expect(rows.length).toBeLessThanOrEqual(MAX_DIAGNOSTIC_ROWS);
      // Trimming takes the oldest, so the newest event must still be present.
      expect(rows.at(-1)?.fields).toEqual({ bucket: (MAX_DIAGNOSTIC_ROWS + 49) % 5 });
      await database.closeAsync();
    });

    it("keeps the ring under the byte ceiling even with few rows", async () => {
      const { database, repository } = await freshRepository();
      const large = { blob: "d".repeat(200_000) };
      for (let index = 0; index < 12; index += 1) {
        await repository.recordDiagnostic("typed.error", large, NOW + index);
      }

      const usage = await database.getFirstAsync<{ bytes: number }>(
        "SELECT SUM(LENGTH(fields_json)) AS bytes FROM diagnostic_events",
      );
      expect(usage?.bytes ?? 0).toBeLessThanOrEqual(1024 * 1024);
      await database.closeAsync();
    });
  });

  describe("describeContents", () => {
    it("reports counts and column names without any values", async () => {
      const { database, repository } = await freshRepository();
      await repository.createPreparing(groundSessionFixture());

      const described = await repository.describeContents();
      const active = described.find((entry) => entry.table === "active_navigation");

      expect(active?.rows).toBe(1);
      expect(active?.columns).toContain("session_json");
      expect(JSON.stringify(described)).not.toContain("50.11");
      await database.closeAsync();
    });
  });
});
