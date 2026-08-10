import {
  type MobileNavigationSession,
  type MobileTerminalAck,
  parseMobileSession,
} from "@openmapx/core/navigation";
import type { Database } from "./database";
import {
  COUNT_EVENTS,
  DELETE_ACTIVE,
  DELETE_ALL_DIAGNOSTICS,
  DELETE_EVENT,
  DELETE_EXPIRED_COMMANDS,
  DELETE_NON_CRITICAL_EVENTS,
  DELETE_OLDEST_DIAGNOSTICS,
  DELETE_SESSION_ALERTS,
  DELETE_SESSION_COMMANDS,
  DELETE_SESSION_EVENTS,
  DIAGNOSTIC_USAGE,
  INSERT_DIAGNOSTIC,
  INSERT_EVENT,
  INSERT_PROCESSED_COMMAND,
  INSERT_QUARANTINE,
  INSERT_SCHEDULED_ALERT,
  NEXT_EVENT_SEQUENCE,
  SELECT_ACTIVE,
  SELECT_DIAGNOSTICS,
  SELECT_EVENTS,
  SELECT_PROCESSED_COMMAND,
  SELECT_QUARANTINE,
  SELECT_SCHEDULED_ALERTS,
  SELECT_TERMINAL_ACK,
  SESSION_TABLES,
  TRIM_PROCESSED_COMMANDS,
  TRIM_QUARANTINE,
  UPDATE_ALERT_STATE,
  UPSERT_ACTIVE,
  UPSERT_TERMINAL_ACK,
} from "./sql";

/**
 * The single writer of native session authority.
 *
 * Two rules give everything above it its guarantees:
 *
 *  - **Compare and swap.** Every mutation names the revision it was computed
 *    from. A command derived from stale state loses instead of overwriting newer
 *    progress, which is what makes a late web command and a concurrent location
 *    callback safe to race.
 *  - **Persist before effects.** A mutation returns typed post-commit intents;
 *    it never speaks, notifies or publishes. If the process dies between commit
 *    and effect, a prompt is lost rather than repeated.
 */

/**
 * Post-commit intents. Data only — a serialised closure could not survive the
 * process recreation these records exist to tolerate.
 */
export type SessionEffect =
  | { kind: "start-location"; permissionMode: "background" | "foreground-only" }
  | { kind: "stop-location" }
  | { kind: "update-location-profile"; profile: string }
  | { kind: "speak"; cueId: string; text: string; locale: "en" | "de" }
  | { kind: "stop-audio" }
  | { kind: "reconcile-alerts"; sessionId: string }
  | { kind: "cancel-session-alerts"; sessionId: string }
  | { kind: "publish-snapshot"; immediate: boolean }
  | { kind: "publish-event"; eventId: string }
  | { kind: "request-reroute"; requestId: string }
  | { kind: "request-transit-refresh"; requestId: string }
  | { kind: "request-transit-replan"; requestId: string };

export interface OutboxEvent {
  eventId: string;
  sessionId: string;
  critical: boolean;
  createdAtMs: number;
  payload: unknown;
}

export type PendingEvent = OutboxEvent & { sequence: number };

export interface ScheduledAlertInput {
  alertId: string;
  legIndex: number;
  triggerAtMs: number;
}

export interface RepositoryMutation {
  session: MobileNavigationSession;
  effects?: SessionEffect[];
  /** Durable events, replayed until the web document acknowledges them. */
  enqueue?: ReadonlyArray<Omit<OutboxEvent, "sessionId" | "createdAtMs">>;
  /** Replaces the session's scheduled alert rows wholesale when present. */
  alerts?: readonly ScheduledAlertInput[];
}

export type CommitFailure =
  | "revision-conflict"
  | "no-active-session"
  | "session-active"
  | "corrupt-session";

export type CommitResult =
  | { ok: true; session: MobileNavigationSession; effects: SessionEffect[] }
  | { ok: false; code: CommitFailure };

export interface QuarantineRecord {
  quarantinedAtMs: number;
  reason: string;
  sessionId: string | null;
  schemaVersion: number | null;
}

export interface DiagnosticRow {
  id: number;
  createdAtMs: number;
  type: string;
  fields: Record<string, unknown>;
}

/** Unacknowledged events beyond this are compacted, then refused. */
export const MAX_OUTBOX_EVENTS = 256;
export const MAX_PROCESSED_COMMANDS = 1_024;
export const PROCESSED_COMMAND_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_DIAGNOSTIC_ROWS = 5_000;
export const MAX_DIAGNOSTIC_BYTES = 1024 * 1024;
export const MAX_QUARANTINE_RECORDS = 3;
/** A quarantine reason is a short code; anything longer risks carrying content. */
const MAX_QUARANTINE_REASON_LENGTH = 64;

const TERMINAL_STATUSES = new Set(["arrived", "stopped", "expired", "error"]);

interface ActiveRow {
  session_id: string;
  revision: number;
  session_json: string;
}

export class SessionRepository {
  constructor(private readonly database: Database) {}

  /* ------------------------------------------------------------- reading --- */

  /**
   * Loads the active session, quarantining a record that cannot be parsed.
   *
   * Quarantine removes the row, so a corrupt record cannot crash-loop task
   * startup by failing identically on every background wake.
   */
  async loadActive(nowMs: number): Promise<MobileNavigationSession | null> {
    const row = await this.database.getFirstAsync<ActiveRow>(SELECT_ACTIVE);
    if (!row) return null;

    const parsed = parseMobileSession(row.session_json);
    if (parsed.ok) return parsed.session;

    await this.quarantineCorruptSession(row.session_id, parsed.code, nowMs);
    return null;
  }

  async readTerminalAck(sessionId: string): Promise<MobileTerminalAck | null> {
    const row = await this.database.getFirstAsync<{
      session_id: string;
      kind: MobileTerminalAck["kind"];
      final_status: MobileTerminalAck["finalStatus"];
      final_revision: number;
      completed_at_ms: number;
    }>(SELECT_TERMINAL_ACK, [sessionId]);
    if (!row) return null;
    return {
      sessionId: row.session_id,
      kind: row.kind,
      finalStatus: row.final_status,
      finalRevision: row.final_revision,
      completedAtMs: row.completed_at_ms,
    };
  }

  /* ------------------------------------------------------------- writing --- */

  /**
   * Writes the first revision of a session.
   *
   * A live session is never displaced implicitly — that would be a silent way to
   * lose an in-progress route. A finished one is cleared first, because leaving
   * it would block every subsequent start.
   */
  async createPreparing(session: MobileNavigationSession): Promise<CommitResult> {
    let result: CommitResult = { ok: false, code: "session-active" };
    await this.database.withExclusiveTransactionAsync(async (tx) => {
      const existing = await tx.getFirstAsync<ActiveRow>(SELECT_ACTIVE);
      if (existing) {
        const parsed = parseMobileSession(existing.session_json);
        if (parsed.ok && !TERMINAL_STATUSES.has(parsed.session.status)) {
          result = { ok: false, code: "session-active" };
          return;
        }
        await deleteSessionRows(tx, existing.session_id);
      }
      await writeActive(tx, session);
      result = { ok: true, session, effects: [] };
    });
    return result;
  }

  /**
   * Applies a mutation only if the caller's expected revision is still current.
   *
   * The mutation must advance the revision by exactly one. Anything else means
   * two writers derived state from the same point — precisely what this guards
   * against — so it throws rather than committing an ambiguous history.
   */
  async compareAndSwap(
    sessionId: string,
    expectedRevision: number,
    mutate: (current: MobileNavigationSession) => RepositoryMutation,
    nowMs: number,
  ): Promise<CommitResult> {
    let result: CommitResult = { ok: false, code: "no-active-session" };
    await this.database.withExclusiveTransactionAsync(async (tx) => {
      const row = await tx.getFirstAsync<ActiveRow>(SELECT_ACTIVE);
      if (!row) {
        result = { ok: false, code: "no-active-session" };
        return;
      }
      const parsed = parseMobileSession(row.session_json);
      if (!parsed.ok) {
        result = { ok: false, code: "corrupt-session" };
        return;
      }
      const current = parsed.session;
      if (current.sessionId !== sessionId || current.revision !== expectedRevision) {
        result = { ok: false, code: "revision-conflict" };
        return;
      }

      const mutation = mutate(current);
      if (mutation.session.sessionId !== sessionId) {
        throw new Error("a mutation must not change the session identity");
      }
      if (mutation.session.revision !== expectedRevision + 1) {
        throw new Error("a committed mutation must advance the revision by exactly one");
      }

      await writeActive(tx, mutation.session);
      for (const event of mutation.enqueue ?? []) {
        await enqueueEventIn(tx, { ...event, sessionId, createdAtMs: nowMs });
      }
      if (mutation.alerts) await replaceAlertsIn(tx, sessionId, mutation.alerts, nowMs);
      result = { ok: true, session: mutation.session, effects: mutation.effects ?? [] };
    });
    return result;
  }

  /**
   * Ends a session in one transaction: writes the non-sensitive acknowledgement
   * and removes everything location-bearing.
   *
   * Terminating an already-terminated or unknown session is a no-op rather than
   * an error, because stop must stay idempotent under retry.
   */
  async terminate(
    sessionId: string,
    finalStatus: MobileTerminalAck["finalStatus"],
    nowMs: number,
  ): Promise<{ ack: MobileTerminalAck | null; effects: SessionEffect[] }> {
    let ack: MobileTerminalAck | null = null;
    await this.database.withExclusiveTransactionAsync(async (tx) => {
      const row = await tx.getFirstAsync<ActiveRow>(SELECT_ACTIVE);
      if (!row || row.session_id !== sessionId) return;

      const parsed = parseMobileSession(row.session_json);
      const next: MobileTerminalAck = {
        sessionId,
        // An unparseable record still deserves an acknowledgement; `kind` is the
        // only field that cannot be recovered from the row, and the column
        // constraint forbids inventing a third value.
        kind: parsed.ok ? parsed.session.kind : "ground",
        finalStatus,
        finalRevision: row.revision,
        completedAtMs: nowMs,
      };
      await tx.runAsync(UPSERT_TERMINAL_ACK, [
        next.sessionId,
        next.kind,
        next.finalStatus,
        next.finalRevision,
        next.completedAtMs,
      ]);
      await deleteSessionRows(tx, sessionId);
      ack = next;
    });

    return {
      ack,
      effects: ack
        ? [
            { kind: "stop-location" },
            { kind: "stop-audio" },
            { kind: "cancel-session-alerts", sessionId },
          ]
        : [],
    };
  }

  /* -------------------------------------------------------------- outbox --- */

  async enqueueEvent(event: OutboxEvent): Promise<void> {
    await this.database.withExclusiveTransactionAsync((tx) => enqueueEventIn(tx, event));
  }

  async listPendingEvents(sessionId: string): Promise<PendingEvent[]> {
    const rows = await this.database.getAllAsync<{
      event_id: string;
      session_id: string;
      critical: number;
      sequence: number;
      created_at_ms: number;
      payload_json: string;
    }>(SELECT_EVENTS, [sessionId]);
    return rows.map((row) => ({
      eventId: row.event_id,
      sessionId: row.session_id,
      critical: row.critical === 1,
      sequence: row.sequence,
      createdAtMs: row.created_at_ms,
      payload: JSON.parse(row.payload_json),
    }));
  }

  async ackEvents(eventIds: readonly string[]): Promise<void> {
    if (eventIds.length === 0) return;
    await this.database.withExclusiveTransactionAsync(async (tx) => {
      for (const id of eventIds) await tx.runAsync(DELETE_EVENT, [id]);
    });
  }

  /* ----------------------------------------------------- command dedupe --- */

  /**
   * Remembers a mutating command's response so a replayed message returns the
   * same answer instead of running the mutation twice.
   */
  async rememberCommand(
    messageId: string,
    sessionId: string | null,
    response: unknown,
    nowMs: number,
  ): Promise<void> {
    await this.database.withExclusiveTransactionAsync(async (tx) => {
      await tx.runAsync(INSERT_PROCESSED_COMMAND, [
        messageId,
        sessionId,
        JSON.stringify(response),
        nowMs,
        nowMs + PROCESSED_COMMAND_TTL_MS,
      ]);
      await tx.runAsync(DELETE_EXPIRED_COMMANDS, [nowMs]);
      await tx.runAsync(TRIM_PROCESSED_COMMANDS, [MAX_PROCESSED_COMMANDS]);
    });
  }

  async lookupCommand(messageId: string, nowMs: number): Promise<unknown | null> {
    const row = await this.database.getFirstAsync<{
      response_json: string;
      expires_at_ms: number;
    }>(SELECT_PROCESSED_COMMAND, [messageId]);
    if (!row || row.expires_at_ms <= nowMs) return null;
    return JSON.parse(row.response_json);
  }

  /* -------------------------------------------------------------- alerts --- */

  /** Replaces a session's scheduled alerts with exactly the given set. */
  async replaceScheduledAlerts(
    sessionId: string,
    alerts: readonly ScheduledAlertInput[],
    nowMs: number,
  ): Promise<void> {
    await this.database.withExclusiveTransactionAsync((tx) =>
      replaceAlertsIn(tx, sessionId, alerts, nowMs),
    );
  }

  async listScheduledAlerts(sessionId: string) {
    const rows = await this.database.getAllAsync<{
      alert_id: string;
      leg_index: number;
      trigger_at_ms: number;
      state: "scheduled" | "fired" | "cancelled";
    }>(SELECT_SCHEDULED_ALERTS, [sessionId]);
    return rows.map((row) => ({
      alertId: row.alert_id,
      legIndex: row.leg_index,
      triggerAtMs: row.trigger_at_ms,
      state: row.state,
    }));
  }

  async markAlert(
    alertId: string,
    state: "scheduled" | "fired" | "cancelled",
    nowMs: number,
  ): Promise<void> {
    await this.database.runAsync(UPDATE_ALERT_STATE, [state, nowMs, alertId]);
  }

  /* --------------------------------------------------------- diagnostics --- */

  /**
   * Appends one redacted diagnostic row, then trims the ring back under both
   * ceilings. The byte ceiling matters as much as the row count: a few large
   * rows could otherwise grow the file well past what a user would expect a
   * local log to cost them.
   */
  async recordDiagnostic(
    type: string,
    fields: Record<string, unknown>,
    nowMs: number,
  ): Promise<void> {
    await this.database.withExclusiveTransactionAsync(async (tx) => {
      await tx.runAsync(INSERT_DIAGNOSTIC, [nowMs, type, JSON.stringify(fields)]);
      let usage = await readDiagnosticUsage(tx);
      while (usage.rows > MAX_DIAGNOSTIC_ROWS || usage.bytes > MAX_DIAGNOSTIC_BYTES) {
        // Trim proportionally rather than one row at a time, so a burst of large
        // rows does not turn into thousands of delete statements.
        const excessRows = Math.max(0, usage.rows - MAX_DIAGNOSTIC_ROWS);
        const trim = Math.min(usage.rows, Math.max(1, excessRows, Math.ceil(usage.rows * 0.1)));
        await tx.runAsync(DELETE_OLDEST_DIAGNOSTICS, [trim]);
        const next = await readDiagnosticUsage(tx);
        if (next.rows === usage.rows) break;
        usage = next;
      }
    });
  }

  async listDiagnostics(): Promise<DiagnosticRow[]> {
    const rows = await this.database.getAllAsync<{
      id: number;
      created_at_ms: number;
      type: string;
      fields_json: string;
    }>(SELECT_DIAGNOSTICS);
    return rows.map((row) => ({
      id: row.id,
      createdAtMs: row.created_at_ms,
      type: row.type,
      fields: JSON.parse(row.fields_json) as Record<string, unknown>,
    }));
  }

  async clearDiagnostics(): Promise<void> {
    await this.database.runAsync(DELETE_ALL_DIAGNOSTICS);
  }

  /* ---------------------------------------------------------- quarantine --- */

  /**
   * Records that a session could not be read, and clears the authority it came
   * from.
   *
   * The original JSON is deliberately not stored: it may contain a route, a last
   * fix or a refresh token, and this table outlives the session it describes.
   */
  async quarantineCorruptSession(
    sessionId: string | null,
    reason: string,
    nowMs: number,
  ): Promise<void> {
    await this.database.withExclusiveTransactionAsync(async (tx) => {
      await tx.runAsync(INSERT_QUARANTINE, [
        nowMs,
        reason.slice(0, MAX_QUARANTINE_REASON_LENGTH),
        sessionId,
        null,
      ]);
      await tx.runAsync(DELETE_ACTIVE);
      if (sessionId) {
        await tx.runAsync(DELETE_SESSION_EVENTS, [sessionId]);
        await tx.runAsync(DELETE_SESSION_ALERTS, [sessionId]);
        await tx.runAsync(DELETE_SESSION_COMMANDS, [sessionId]);
      }
      await tx.runAsync(TRIM_QUARANTINE, [MAX_QUARANTINE_RECORDS]);
    });
  }

  async listQuarantined(): Promise<QuarantineRecord[]> {
    const rows = await this.database.getAllAsync<{
      quarantined_at_ms: number;
      reason: string;
      session_id: string | null;
      schema_version: number | null;
    }>(SELECT_QUARANTINE);
    return rows.map((row) => ({
      quarantinedAtMs: row.quarantined_at_ms,
      reason: row.reason,
      sessionId: row.session_id,
      schemaVersion: row.schema_version,
    }));
  }

  /**
   * Row counts and column names only.
   *
   * Used by the developer-only storage dump to show that a stopped session left
   * nothing behind, without printing anything it might have left behind.
   */
  async describeContents(): Promise<Array<{ table: string; rows: number; columns: string[] }>> {
    const described: Array<{ table: string; rows: number; columns: string[] }> = [];
    for (const table of SESSION_TABLES) {
      // Table names come from this module's own constant list, never from input.
      const count = await this.database.getFirstAsync<{ n: number }>(
        `SELECT COUNT(*) AS n FROM ${table}`,
      );
      const columns = await this.database.getAllAsync<{ name: string }>(
        `PRAGMA table_info(${table})`,
      );
      described.push({ table, rows: count?.n ?? 0, columns: columns.map((c) => c.name) });
    }
    return described;
  }
}

/* ------------------------------------------------------------- internals --- */

async function writeActive(tx: Database, session: MobileNavigationSession): Promise<void> {
  await tx.runAsync(UPSERT_ACTIVE, [
    session.sessionId,
    session.revision,
    session.kind,
    session.status,
    session.startedAtMs,
    session.updatedAtMs,
    session.expiresAtMs,
    JSON.stringify(session),
  ]);
}

/** Removes every location-bearing row belonging to a session. */
async function deleteSessionRows(tx: Database, sessionId: string): Promise<void> {
  await tx.runAsync(DELETE_ACTIVE);
  await tx.runAsync(DELETE_SESSION_EVENTS, [sessionId]);
  await tx.runAsync(DELETE_SESSION_ALERTS, [sessionId]);
  await tx.runAsync(DELETE_SESSION_COMMANDS, [sessionId]);
}

async function enqueueEventIn(tx: Database, event: OutboxEvent): Promise<void> {
  const count = await tx.getFirstAsync<{ n: number }>(COUNT_EVENTS, [event.sessionId]);
  if ((count?.n ?? 0) >= MAX_OUTBOX_EVENTS) {
    // Superseded snapshot updates are the compressible part of the queue; a
    // critical event is never dropped to make room for another one.
    await tx.runAsync(DELETE_NON_CRITICAL_EVENTS, [event.sessionId]);
    const after = await tx.getFirstAsync<{ n: number }>(COUNT_EVENTS, [event.sessionId]);
    if ((after?.n ?? 0) >= MAX_OUTBOX_EVENTS) return;
  }
  const next = await tx.getFirstAsync<{ next: number }>(NEXT_EVENT_SEQUENCE, [event.sessionId]);
  await tx.runAsync(INSERT_EVENT, [
    event.eventId,
    event.sessionId,
    event.critical ? 1 : 0,
    next?.next ?? 1,
    event.createdAtMs,
    JSON.stringify(event.payload),
  ]);
}

async function replaceAlertsIn(
  tx: Database,
  sessionId: string,
  alerts: readonly ScheduledAlertInput[],
  nowMs: number,
): Promise<void> {
  await tx.runAsync(DELETE_SESSION_ALERTS, [sessionId]);
  for (const alert of alerts) {
    await tx.runAsync(INSERT_SCHEDULED_ALERT, [
      alert.alertId,
      sessionId,
      alert.legIndex,
      alert.triggerAtMs,
      nowMs,
    ]);
  }
}

async function readDiagnosticUsage(tx: Database): Promise<{ rows: number; bytes: number }> {
  const row = await tx.getFirstAsync<{ rows_used: number; bytes_used: number }>(DIAGNOSTIC_USAGE);
  return { rows: row?.rows_used ?? 0, bytes: row?.bytes_used ?? 0 };
}
