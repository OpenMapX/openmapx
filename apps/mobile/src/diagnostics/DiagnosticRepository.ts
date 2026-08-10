import type { DiagnosticRow, SessionRepository } from "../storage/SessionRepository";

/**
 * The only way a diagnostic gets recorded.
 *
 * The design decision that matters: this **rejects unknown fields** rather than
 * trying to redact arbitrary objects. Redaction is a losing game — a new field
 * on some upstream type, a nested object, a stringified error containing a URL,
 * and a coordinate is in the log. An allowlist fails closed instead: a field
 * nobody declared is simply not written, and the omission is itself recorded.
 *
 * Everything here stays on the device. There is no upload path, and export
 * happens only when the user asks for it.
 */

export type DiagnosticType =
  | "session.lifecycle"
  | "permission.transition"
  | "location.batch"
  | "engine.timing"
  | "bridge.version"
  | "audio.result"
  | "notification.operation"
  | "network.transition"
  | "typed.error";

/**
 * Field names permitted per type.
 *
 * Every one of these is a count, a bucket, a code, a version or a duration.
 * None can reconstruct a position, a route or an identity.
 */
export const DIAGNOSTIC_FIELDS: Record<DiagnosticType, readonly string[]> = {
  "session.lifecycle": ["kind", "status", "revision", "ageMs", "connectivity", "permissionMode"],
  "permission.transition": ["from", "to", "platform", "reason", "canAskAgain"],
  "location.batch": ["accepted", "rejected", "errorCode", "accuracyBucket", "gapBucketMs"],
  "engine.timing": ["stage", "durationBucketMs", "iterations"],
  "bridge.version": ["selected", "min", "max", "outcome"],
  "audio.result": ["result", "durationBucketMs"],
  "notification.operation": ["operation", "scheduled", "cancelled", "orphans", "result"],
  "network.transition": ["from", "to", "confirmed"],
  "typed.error": ["scope", "code", "kind", "type"],
};

/** Values are bounded too: a long string is a place for content to hide. */
export const MAX_DIAGNOSTIC_VALUE_LENGTH = 64;

export interface RecordOutcome {
  written: boolean;
  /** Field names that were refused, so a mistake is visible rather than silent. */
  rejected: string[];
}

function sanitiseValue(value: unknown): string | number | boolean | null | undefined {
  if (value === null) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") return value.slice(0, MAX_DIAGNOSTIC_VALUE_LENGTH);
  // Objects and arrays are refused outright: nesting is exactly how a route or a
  // coordinate would arrive here unnoticed.
  return undefined;
}

export class DiagnosticRepository {
  constructor(
    private readonly repository: SessionRepository,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  /**
   * Records one event, keeping only declared fields with scalar values.
   *
   * Returns which fields were refused rather than throwing: a diagnostic must
   * never be able to break the operation it is describing.
   */
  async record(type: DiagnosticType, fields: Record<string, unknown>): Promise<RecordOutcome> {
    const allowed = DIAGNOSTIC_FIELDS[type];
    if (!allowed) return { written: false, rejected: Object.keys(fields ?? {}) };

    const kept: Record<string, unknown> = {};
    const rejected: string[] = [];
    for (const [key, value] of Object.entries(fields ?? {})) {
      if (!allowed.includes(key)) {
        rejected.push(key);
        continue;
      }
      const sanitised = sanitiseValue(value);
      if (sanitised === undefined) {
        rejected.push(key);
        continue;
      }
      kept[key] = sanitised;
    }

    // The count is recorded, never the names of the offending fields — a field
    // name can itself describe what the app was doing.
    if (rejected.length > 0) kept.droppedFieldCount = rejected.length;

    try {
      await this.repository.recordDiagnostic(type, kept, this.clock());
      return { written: true, rejected };
    } catch {
      return { written: false, rejected };
    }
  }

  /** Fire-and-forget, for call sites that must not await a log write. */
  recordAsync(type: DiagnosticType, fields: Record<string, unknown>): void {
    void this.record(type, fields);
  }

  list(): Promise<DiagnosticRow[]> {
    return this.repository.listDiagnostics();
  }

  clear(): Promise<void> {
    return this.repository.clearDiagnostics();
  }
}

/** Coarse buckets, so a duration cannot become a timing side channel. */
export function durationBucketMs(durationMs: number): number {
  if (!Number.isFinite(durationMs) || durationMs < 0) return -1;
  for (const bound of [10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000]) {
    if (durationMs <= bound) return bound;
  }
  return 30_000;
}
