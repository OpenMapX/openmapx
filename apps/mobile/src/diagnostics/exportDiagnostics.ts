import type { DiagnosticRow } from "../storage/SessionRepository";
import { DIAGNOSTIC_FIELDS, type DiagnosticType } from "./DiagnosticRepository";

/**
 * The user-initiated diagnostic export.
 *
 * Three rules, in order of how easily they are broken:
 *
 *  - **Only on a direct user action.** Nothing here runs on a schedule, on an
 *    error, or on app start. There is no upload path at all; the file goes to
 *    the platform share sheet and nowhere else.
 *  - **Allowlisted twice.** Rows were filtered when written, and are filtered
 *    again here against the same declaration — because a schema change or an old
 *    row from a previous version must not slip through on the way out.
 *  - **No stable identity.** The export carries a random identifier generated
 *    for that one file, not a device id, an install id, or a session id. Two
 *    exports from one device cannot be linked to each other.
 *
 * The temporary file is deleted after sharing completes *or* is cancelled, so a
 * declined share does not leave a log sitting in the cache directory.
 */

export const DIAGNOSTIC_EXPORT_SCHEMA_VERSION = 1;

export interface ExportEnvironment {
  appVersion: string;
  buildNumber: string;
  shellProtocolMin: number;
  shellProtocolMax: number;
  platform: "ios" | "android";
  osVersion: string;
  deviceModelBucket: string;
}

export interface DiagnosticExport {
  schemaVersion: number;
  exportId: string;
  createdAtMs: number;
  environment: ExportEnvironment;
  events: Array<{ atMs: number; type: string; fields: Record<string, unknown> }>;
  /** How many stored rows were refused on the way out, and why it matters. */
  droppedRowCount: number;
}

export interface ExportPorts {
  read(): Promise<DiagnosticRow[]>;
  environment(): ExportEnvironment;
  now(): number;
  randomId(): string;
  /** Writes to the cache directory and returns the file URI. */
  writeTempFile(name: string, contents: string): Promise<string>;
  deleteTempFile(uri: string): Promise<void>;
  /** Resolves when the share sheet closes, whether or not anything was shared. */
  share(uri: string): Promise<void>;
  isSharingAvailable(): Promise<boolean>;
}

/**
 * Filters stored rows against the current declaration.
 *
 * A row whose type is no longer declared is dropped whole rather than partially
 * exported: an unknown type means unknown field semantics.
 */
export function buildDiagnosticExport(
  rows: readonly DiagnosticRow[],
  environment: ExportEnvironment,
  exportId: string,
  nowMs: number,
): DiagnosticExport {
  const events: DiagnosticExport["events"] = [];
  let droppedRowCount = 0;

  for (const row of rows) {
    const allowed = DIAGNOSTIC_FIELDS[row.type as DiagnosticType];
    if (!allowed) {
      droppedRowCount += 1;
      continue;
    }
    const fields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row.fields ?? {})) {
      if (key === "droppedFieldCount" || allowed.includes(key)) fields[key] = value;
    }
    events.push({ atMs: row.createdAtMs, type: row.type, fields });
  }

  return {
    schemaVersion: DIAGNOSTIC_EXPORT_SCHEMA_VERSION,
    exportId,
    createdAtMs: nowMs,
    environment,
    events,
    droppedRowCount,
  };
}

export type ExportResult =
  | { ok: true; eventCount: number }
  | { ok: false; reason: "sharing-unavailable" | "write-failed" | "share-failed" };

/**
 * Writes the export and hands it to the share sheet.
 *
 * Called only from a control the user pressed. The temporary file is removed in
 * a `finally`, so it is gone whether the share succeeded, failed, or was
 * dismissed.
 */
export async function exportDiagnostics(ports: ExportPorts): Promise<ExportResult> {
  if (!(await ports.isSharingAvailable())) return { ok: false, reason: "sharing-unavailable" };

  const exportId = ports.randomId();
  const document = buildDiagnosticExport(
    await ports.read(),
    ports.environment(),
    exportId,
    ports.now(),
  );

  let uri: string;
  try {
    uri = await ports.writeTempFile(
      `openmapx-diagnostics-${exportId}.json`,
      JSON.stringify(document, null, 2),
    );
  } catch {
    return { ok: false, reason: "write-failed" };
  }

  try {
    await ports.share(uri);
    return { ok: true, eventCount: document.events.length };
  } catch {
    return { ok: false, reason: "share-failed" };
  } finally {
    await ports.deleteTempFile(uri).catch(() => undefined);
  }
}
