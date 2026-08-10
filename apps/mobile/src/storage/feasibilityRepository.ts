import type { Database } from "./database";

/**
 * Persistence for the feasibility probe.
 *
 * The probe exists to prove one thing: a globally-registered TaskManager
 * callback can commit to SQLite while the app is backgrounded. It therefore
 * stores counters, timestamps and coarse accuracy buckets — never coordinates.
 * That restriction is enforced by the schema, which has no latitude/longitude
 * column, and asserted by tests.
 */

export type AccuracyBucket = "excellent" | "good" | "fair" | "poor" | "unusable";

export interface FeasibilityProbeState {
  callbackCount: number;
  acceptedFixCount: number;
  rejectedFixCount: number;
  lastTimestampMs: number | null;
  lastAccuracyBucket: AccuracyBucket | null;
  lastCallbackGapMs: number | null;
  maxCallbackGapMs: number | null;
  lastErrorCode: string | null;
  pendingAudioProbe: boolean;
  audioResultCode: string | null;
  updatedAtMs: number;
}

export const EMPTY_PROBE_STATE: FeasibilityProbeState = Object.freeze({
  callbackCount: 0,
  acceptedFixCount: 0,
  rejectedFixCount: 0,
  lastTimestampMs: null,
  lastAccuracyBucket: null,
  lastCallbackGapMs: null,
  maxCallbackGapMs: null,
  lastErrorCode: null,
  pendingAudioProbe: false,
  audioResultCode: null,
  updatedAtMs: 0,
});

/**
 * Buckets exist so a diagnostic report can describe signal quality without
 * carrying a measurement precise enough to help reconstruct a route.
 */
export function accuracyBucket(accuracyMeters: number): AccuracyBucket {
  if (!Number.isFinite(accuracyMeters) || accuracyMeters < 0) return "unusable";
  if (accuracyMeters <= 5) return "excellent";
  if (accuracyMeters <= 15) return "good";
  if (accuracyMeters <= 40) return "fair";
  if (accuracyMeters <= 100) return "poor";
  return "unusable";
}

interface ProbeRow {
  callback_count: number;
  accepted_fix_count: number;
  rejected_fix_count: number;
  last_timestamp_ms: number | null;
  last_accuracy_bucket: string | null;
  last_callback_gap_ms: number | null;
  max_callback_gap_ms: number | null;
  last_error_code: string | null;
  pending_audio_probe: number;
  audio_result_code: string | null;
  updated_at_ms: number;
}

function fromRow(row: ProbeRow): FeasibilityProbeState {
  return {
    callbackCount: row.callback_count,
    acceptedFixCount: row.accepted_fix_count,
    rejectedFixCount: row.rejected_fix_count,
    lastTimestampMs: row.last_timestamp_ms,
    lastAccuracyBucket: (row.last_accuracy_bucket as AccuracyBucket | null) ?? null,
    lastCallbackGapMs: row.last_callback_gap_ms,
    maxCallbackGapMs: row.max_callback_gap_ms,
    lastErrorCode: row.last_error_code,
    pendingAudioProbe: row.pending_audio_probe === 1,
    audioResultCode: row.audio_result_code,
    updatedAtMs: row.updated_at_ms,
  };
}

export class FeasibilityRepository {
  constructor(private readonly database: Database) {}

  async read(): Promise<FeasibilityProbeState> {
    const row = await this.database.getFirstAsync<ProbeRow>(
      "SELECT * FROM feasibility_probe WHERE id = 1",
    );
    return row ? fromRow(row) : { ...EMPTY_PROBE_STATE };
  }

  /**
   * Applies a change inside one exclusive transaction, so a process killed
   * mid-callback leaves either the complete previous state or the complete new
   * one — never a half-counted batch.
   */
  async commit(
    mutate: (current: FeasibilityProbeState) => FeasibilityProbeState,
  ): Promise<FeasibilityProbeState> {
    let committed: FeasibilityProbeState = { ...EMPTY_PROBE_STATE };
    await this.database.withExclusiveTransactionAsync(async (tx) => {
      const row = await tx.getFirstAsync<ProbeRow>("SELECT * FROM feasibility_probe WHERE id = 1");
      const current = row ? fromRow(row) : { ...EMPTY_PROBE_STATE };
      const next = mutate(current);
      // Counters are monotonic by construction; a regression would mean a lost
      // update, which is exactly what this probe is meant to detect.
      if (next.callbackCount < current.callbackCount) {
        throw new Error("feasibility counters must not regress");
      }
      await tx.runAsync(
        `INSERT INTO feasibility_probe (
           id, callback_count, accepted_fix_count, rejected_fix_count,
           last_timestamp_ms, last_accuracy_bucket, last_callback_gap_ms,
           max_callback_gap_ms, last_error_code, pending_audio_probe,
           audio_result_code, updated_at_ms
         ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           callback_count = excluded.callback_count,
           accepted_fix_count = excluded.accepted_fix_count,
           rejected_fix_count = excluded.rejected_fix_count,
           last_timestamp_ms = excluded.last_timestamp_ms,
           last_accuracy_bucket = excluded.last_accuracy_bucket,
           last_callback_gap_ms = excluded.last_callback_gap_ms,
           max_callback_gap_ms = excluded.max_callback_gap_ms,
           last_error_code = excluded.last_error_code,
           pending_audio_probe = excluded.pending_audio_probe,
           audio_result_code = excluded.audio_result_code,
           updated_at_ms = excluded.updated_at_ms`,
        [
          next.callbackCount,
          next.acceptedFixCount,
          next.rejectedFixCount,
          next.lastTimestampMs,
          next.lastAccuracyBucket,
          next.lastCallbackGapMs,
          next.maxCallbackGapMs,
          next.lastErrorCode,
          next.pendingAudioProbe ? 1 : 0,
          next.audioResultCode,
          next.updatedAtMs,
        ],
      );
      committed = next;
    });
    return committed;
  }

  async reset(): Promise<void> {
    await this.database.runAsync("DELETE FROM feasibility_probe");
  }
}
