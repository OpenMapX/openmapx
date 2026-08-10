/**
 * Every SQL statement the app issues, in one place.
 *
 * Keeping the text here rather than inline at each call site makes two things
 * checkable by reading a single file: that no statement interpolates a value
 * instead of binding it, and that the schema a migration creates is the schema
 * the queries actually use.
 *
 * Every value is bound; nothing here interpolates.
 */

/* ------------------------------------------------------------------ DDL --- */

/** Records which ordered migrations have been applied, and when. */
export const CREATE_SCHEMA_MIGRATIONS = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at_ms INTEGER NOT NULL
)`;

/**
 * Feasibility probe state from the qualification build.
 *
 * Deliberately has no latitude/longitude column: proving the background path
 * works must not create a location history.
 */
export const CREATE_FEASIBILITY_PROBE = `CREATE TABLE IF NOT EXISTS feasibility_probe (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  callback_count INTEGER NOT NULL,
  accepted_fix_count INTEGER NOT NULL,
  rejected_fix_count INTEGER NOT NULL,
  last_timestamp_ms INTEGER,
  last_accuracy_bucket TEXT,
  last_callback_gap_ms INTEGER,
  max_callback_gap_ms INTEGER,
  last_error_code TEXT,
  pending_audio_probe INTEGER NOT NULL DEFAULT 0,
  audio_result_code TEXT,
  updated_at_ms INTEGER NOT NULL
)`;

/**
 * The one active session.
 *
 * Singleton by primary key rather than by convention: two rows would mean two
 * authorities, and a `CHECK` catches that at the engine instead of in review.
 */
export const CREATE_ACTIVE_NAVIGATION = `CREATE TABLE IF NOT EXISTS active_navigation (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  session_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  kind TEXT NOT NULL CHECK (kind IN ('ground','transit')),
  status TEXT NOT NULL CHECK (status IN ('preparing','active','arrived','stopped','expired','error')),
  started_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  session_json TEXT NOT NULL
)`;

export const CREATE_ACTIVE_NAVIGATION_INDEX = `CREATE INDEX IF NOT EXISTS idx_active_navigation_session
  ON active_navigation (session_id)`;

/**
 * The only record that outlives a finished session. Carries no route, fix, stop
 * name, cue text or token, so it is safe to keep after cleanup.
 */
export const CREATE_TERMINAL_ACK = `CREATE TABLE IF NOT EXISTS terminal_ack (
  session_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('ground','transit')),
  final_status TEXT NOT NULL CHECK (final_status IN ('arrived','stopped','expired','error')),
  final_revision INTEGER NOT NULL CHECK (final_revision >= 0),
  completed_at_ms INTEGER NOT NULL
)`;

/** Durable outbox: events the web document has not acknowledged yet. */
export const CREATE_NAVIGATION_EVENTS = `CREATE TABLE IF NOT EXISTS navigation_events (
  event_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  critical INTEGER NOT NULL DEFAULT 0 CHECK (critical IN (0,1)),
  sequence INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  payload_json TEXT NOT NULL
)`;

export const CREATE_NAVIGATION_EVENTS_INDEX = `CREATE INDEX IF NOT EXISTS idx_navigation_events_session
  ON navigation_events (session_id, sequence)`;

/**
 * Command dedupe. Stores the message ID, the exact response envelope and an
 * expiry — never the command payload, which may carry a route.
 */
export const CREATE_PROCESSED_COMMANDS = `CREATE TABLE IF NOT EXISTS processed_commands (
  message_id TEXT PRIMARY KEY,
  session_id TEXT,
  response_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL
)`;

export const CREATE_PROCESSED_COMMANDS_INDEX = `CREATE INDEX IF NOT EXISTS idx_processed_commands_expiry
  ON processed_commands (expires_at_ms)`;

/**
 * Scheduled local alerts by stable identity, so a restart can reconcile the
 * rows against what the operating system actually still holds.
 */
export const CREATE_SCHEDULED_ALERTS = `CREATE TABLE IF NOT EXISTS scheduled_alerts (
  alert_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  leg_index INTEGER NOT NULL CHECK (leg_index >= 0),
  trigger_at_ms INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('scheduled','fired','cancelled')),
  updated_at_ms INTEGER NOT NULL
)`;

export const CREATE_SCHEDULED_ALERTS_INDEX = `CREATE INDEX IF NOT EXISTS idx_scheduled_alerts_session
  ON scheduled_alerts (session_id)`;

/** Bounded local ring of redacted events. Never uploaded; export is user-initiated. */
export const CREATE_DIAGNOSTIC_EVENTS = `CREATE TABLE IF NOT EXISTS diagnostic_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at_ms INTEGER NOT NULL,
  type TEXT NOT NULL,
  fields_json TEXT NOT NULL
)`;

export const CREATE_DIAGNOSTIC_EVENTS_INDEX = `CREATE INDEX IF NOT EXISTS idx_diagnostic_events_created
  ON diagnostic_events (created_at_ms)`;

/**
 * A record that could not be parsed. Stores a reason and identity only — never
 * the original session JSON, which may hold a route, a fix or a refresh token,
 * and which would otherwise outlive the session it came from.
 */
export const CREATE_QUARANTINED_SESSIONS = `CREATE TABLE IF NOT EXISTS quarantined_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quarantined_at_ms INTEGER NOT NULL,
  reason TEXT NOT NULL,
  session_id TEXT,
  schema_version INTEGER
)`;

/** Tables the session authority owns, used by migration tests and the dev dump. */
export const SESSION_TABLES = [
  "schema_migrations",
  "active_navigation",
  "terminal_ack",
  "navigation_events",
  "processed_commands",
  "scheduled_alerts",
  "diagnostic_events",
  "quarantined_sessions",
] as const;

/* -------------------------------------------------------------- queries --- */

export const SELECT_APPLIED_MIGRATIONS =
  "SELECT version FROM schema_migrations ORDER BY version ASC";
export const INSERT_APPLIED_MIGRATION =
  "INSERT INTO schema_migrations (version, applied_at_ms) VALUES (?, ?) ON CONFLICT(version) DO NOTHING";

export const SELECT_ACTIVE =
  "SELECT session_id, revision, session_json FROM active_navigation WHERE id = 1";

export const UPSERT_ACTIVE = `INSERT INTO active_navigation (
  id, session_id, revision, kind, status, started_at_ms, updated_at_ms, expires_at_ms, session_json
) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  session_id = excluded.session_id,
  revision = excluded.revision,
  kind = excluded.kind,
  status = excluded.status,
  started_at_ms = excluded.started_at_ms,
  updated_at_ms = excluded.updated_at_ms,
  expires_at_ms = excluded.expires_at_ms,
  session_json = excluded.session_json`;

export const DELETE_ACTIVE = "DELETE FROM active_navigation WHERE id = 1";

export const UPSERT_TERMINAL_ACK = `INSERT INTO terminal_ack (
  session_id, kind, final_status, final_revision, completed_at_ms
) VALUES (?, ?, ?, ?, ?)
ON CONFLICT(session_id) DO UPDATE SET
  final_status = excluded.final_status,
  final_revision = excluded.final_revision,
  completed_at_ms = excluded.completed_at_ms`;

export const SELECT_TERMINAL_ACK = "SELECT * FROM terminal_ack WHERE session_id = ?";

export const INSERT_EVENT = `INSERT INTO navigation_events (
  event_id, session_id, critical, sequence, created_at_ms, payload_json
) VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT(event_id) DO NOTHING`;

export const SELECT_EVENTS =
  "SELECT * FROM navigation_events WHERE session_id = ? ORDER BY sequence ASC";
export const COUNT_EVENTS = "SELECT COUNT(*) AS n FROM navigation_events WHERE session_id = ?";
export const NEXT_EVENT_SEQUENCE =
  "SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM navigation_events WHERE session_id = ?";
export const DELETE_EVENT = "DELETE FROM navigation_events WHERE event_id = ?";
export const DELETE_NON_CRITICAL_EVENTS =
  "DELETE FROM navigation_events WHERE session_id = ? AND critical = 0";
export const DELETE_SESSION_EVENTS = "DELETE FROM navigation_events WHERE session_id = ?";

export const INSERT_PROCESSED_COMMAND = `INSERT INTO processed_commands (
  message_id, session_id, response_json, created_at_ms, expires_at_ms
) VALUES (?, ?, ?, ?, ?)
ON CONFLICT(message_id) DO NOTHING`;

export const SELECT_PROCESSED_COMMAND =
  "SELECT response_json, expires_at_ms FROM processed_commands WHERE message_id = ?";
export const DELETE_EXPIRED_COMMANDS = "DELETE FROM processed_commands WHERE expires_at_ms <= ?";
export const TRIM_PROCESSED_COMMANDS = `DELETE FROM processed_commands WHERE message_id IN (
  SELECT message_id FROM processed_commands ORDER BY created_at_ms DESC, message_id DESC LIMIT -1 OFFSET ?
)`;
export const DELETE_SESSION_COMMANDS = "DELETE FROM processed_commands WHERE session_id = ?";

export const INSERT_SCHEDULED_ALERT = `INSERT INTO scheduled_alerts (
  alert_id, session_id, leg_index, trigger_at_ms, state, updated_at_ms
) VALUES (?, ?, ?, ?, 'scheduled', ?)
ON CONFLICT(alert_id) DO UPDATE SET
  leg_index = excluded.leg_index,
  trigger_at_ms = excluded.trigger_at_ms,
  state = 'scheduled',
  updated_at_ms = excluded.updated_at_ms`;

export const SELECT_SCHEDULED_ALERTS =
  "SELECT * FROM scheduled_alerts WHERE session_id = ? ORDER BY trigger_at_ms ASC, alert_id ASC";
export const UPDATE_ALERT_STATE =
  "UPDATE scheduled_alerts SET state = ?, updated_at_ms = ? WHERE alert_id = ?";
export const DELETE_SESSION_ALERTS = "DELETE FROM scheduled_alerts WHERE session_id = ?";

export const INSERT_DIAGNOSTIC =
  "INSERT INTO diagnostic_events (created_at_ms, type, fields_json) VALUES (?, ?, ?)";
export const SELECT_DIAGNOSTICS =
  "SELECT id, created_at_ms, type, fields_json FROM diagnostic_events ORDER BY id ASC";
export const DIAGNOSTIC_USAGE =
  "SELECT COUNT(*) AS rows_used, COALESCE(SUM(LENGTH(fields_json) + LENGTH(type) + 32), 0) AS bytes_used FROM diagnostic_events";
export const DELETE_OLDEST_DIAGNOSTICS =
  "DELETE FROM diagnostic_events WHERE id IN (SELECT id FROM diagnostic_events ORDER BY id ASC LIMIT ?)";
export const DELETE_ALL_DIAGNOSTICS = "DELETE FROM diagnostic_events";

export const INSERT_QUARANTINE = `INSERT INTO quarantined_sessions (
  quarantined_at_ms, reason, session_id, schema_version
) VALUES (?, ?, ?, ?)`;

export const SELECT_QUARANTINE =
  "SELECT * FROM quarantined_sessions ORDER BY quarantined_at_ms DESC, id DESC";
export const TRIM_QUARANTINE = `DELETE FROM quarantined_sessions WHERE id NOT IN (
  SELECT id FROM quarantined_sessions ORDER BY quarantined_at_ms DESC, id DESC LIMIT ?
)`;
