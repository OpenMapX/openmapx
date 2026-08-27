import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { sql } from "../../db/index.js";
import { scrubSecrets } from "../../utils/scrub-secrets.js";
import { osmPbfName } from "../download-osm.js";
import { assertOverturePostgresCapacity, estimateOvertureConflationBytes } from "./capacity.js";
import {
  assignOvertureCandidates,
  cleanupOvertureConflationWorkspace,
  publishOvertureLinks,
  scoreOvertureCandidates,
} from "./conflate.js";
import { validateFusedOvertureQuality } from "./eval/quality-gate.js";
import { extractOsmPois } from "./extract-osm-pois.js";
import { withOvertureOperationLock } from "./operation-lock.js";
import { assertValidRegion } from "./pull.js";
import { assertValidOvertureSchema } from "./schema.js";

export type ConflationStateStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "waiting_for_osm";

export type ConflationPhase = "extract" | "score" | "assign" | "publish" | "complete";

export interface ConflationState {
  release: string;
  region: string;
  placeCount: number;
  status: ConflationStateStatus;
  phase: ConflationPhase;
  attemptCount: number;
  sourceFingerprint: string | null;
  emittedCount: number | null;
  extractedCount: number | null;
  processedCount: number | null;
  candidateCount: number | null;
  componentCount: number | null;
  assignmentCursor: number | null;
  stagedLinkCount: number | null;
  linkedCount: number | null;
  scoreCursorH3: string | null;
  scoreCursorType: string | null;
  scoreCursorId: number | null;
  phaseDurationsMs: Partial<Record<ConflationPhase, number>>;
  lastError: string | null;
  startedAt: Date | null;
  attemptStartedAt: Date | null;
  phaseStartedAt: Date | null;
  completedAt: Date | null;
  workspaceCleanedAt: Date | null;
  releaseFilesPrunedAt: Date | null;
  updatedAt: Date;
}

export type RebuildOvertureLinksResult =
  | {
      status: "completed";
      linked: number;
      emitted: number;
      extracted: number;
      candidates: number;
      components: number;
      phaseDurationsMs: Partial<Record<ConflationPhase, number>>;
    }
  | { status: "already_completed"; linked: number }
  | { status: "already_running"; linked: number }
  | { status: "waiting_for_osm"; linked: number; pbfPath: string }
  | { status: "failed"; linked: number; phase: ConflationPhase; error: string };

export interface RebuildOvertureLinksOptions {
  region: string;
  dataDir: string;
  release?: string;
  schema?: string;
  /** Explicitly discard every durable phase and restart from OSM extraction. */
  force?: boolean;
  ollamaUrl?: string;
  useEmbeddings?: boolean;
  onProgress?: (message: string) => void;
}

interface RebuildDependencies {
  fileExists: typeof existsSync;
  fingerprint: (path: string) => string;
  extract: typeof extractOsmPois;
  score: typeof scoreOvertureCandidates;
  assign: typeof assignOvertureCandidates;
  validateFusedQuality: typeof validateFusedOvertureQuality;
  publish: typeof publishOvertureLinks;
  cleanup: typeof cleanupOvertureConflationWorkspace;
  preflight: (schema: string) => Promise<void>;
}

export function fingerprintOsmSnapshot(path: string): string {
  const stat = statSync(path);
  // Atomic downloads can legitimately preserve size and modification time.
  // Device/inode identity makes replacement detection robust without hashing
  // a multi-gigabyte country PBF on every 15-minute retry.
  return `${stat.dev}:${stat.ino}:${stat.size}:${Math.trunc(stat.mtimeMs)}`;
}

const defaultDependencies: RebuildDependencies = {
  fileExists: existsSync,
  fingerprint: fingerprintOsmSnapshot,
  extract: extractOsmPois,
  score: scoreOvertureCandidates,
  assign: assignOvertureCandidates,
  validateFusedQuality: validateFusedOvertureQuality,
  publish: publishOvertureLinks,
  cleanup: cleanupOvertureConflationWorkspace,
  preflight: (schema) =>
    assertOverturePostgresCapacity({
      schema,
      stage: "PostGIS conflation workspace",
      workingBytes: estimateOvertureConflationBytes,
    }),
};

interface StateRow {
  release: string;
  region: string;
  place_count: string;
  status: ConflationStateStatus;
  phase: ConflationPhase;
  attempt_count: number;
  source_fingerprint: string | null;
  emitted_count: string | null;
  extracted_count: string | null;
  processed_count: string | null;
  candidate_count: string | null;
  component_count: string | null;
  assignment_cursor: string | null;
  staged_link_count: string | null;
  linked_count: string | null;
  score_cursor_h3: string | null;
  score_cursor_type: string | null;
  score_cursor_id: string | null;
  phase_durations_ms: Record<string, number> | null;
  last_error: string | null;
  started_at: Date | string | null;
  attempt_started_at: Date | string | null;
  phase_started_at: Date | string | null;
  completed_at: Date | string | null;
  workspace_cleaned_at: Date | string | null;
  release_files_pruned_at: Date | string | null;
  updated_at: Date | string;
}

const STATE_COLUMNS = `release, region, place_count::TEXT, status, phase, attempt_count,
  source_fingerprint, emitted_count::TEXT, extracted_count::TEXT,
  processed_count::TEXT, candidate_count::TEXT, component_count::TEXT,
  assignment_cursor::TEXT, staged_link_count::TEXT, linked_count::TEXT,
  score_cursor_h3, score_cursor_type, score_cursor_id::TEXT,
  phase_durations_ms, last_error, started_at, attempt_started_at,
  phase_started_at, completed_at, workspace_cleaned_at,
  release_files_pruned_at, updated_at`;

function numeric(value: string | null): number | null {
  return value === null ? null : Number(value);
}

function timestamp(value: Date | string, column: string): Date;
function timestamp(value: Date | string | null, column: string): Date | null;
function timestamp(value: Date | string | null, column: string): Date | null {
  if (value === null) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid ${column} timestamp in Overture conflation state`);
  }
  return parsed;
}

function mapState(row: StateRow): ConflationState {
  return {
    release: row.release,
    region: row.region,
    placeCount: Number(row.place_count),
    status: row.status,
    phase: row.phase,
    attemptCount: Number(row.attempt_count),
    sourceFingerprint: row.source_fingerprint,
    emittedCount: numeric(row.emitted_count),
    extractedCount: numeric(row.extracted_count),
    processedCount: numeric(row.processed_count),
    candidateCount: numeric(row.candidate_count),
    componentCount: numeric(row.component_count),
    assignmentCursor: numeric(row.assignment_cursor),
    stagedLinkCount: numeric(row.staged_link_count),
    linkedCount: numeric(row.linked_count),
    scoreCursorH3: row.score_cursor_h3,
    scoreCursorType: row.score_cursor_type,
    scoreCursorId: numeric(row.score_cursor_id),
    phaseDurationsMs: row.phase_durations_ms ?? {},
    lastError: row.last_error,
    startedAt: timestamp(row.started_at, "started_at"),
    attemptStartedAt: timestamp(row.attempt_started_at, "attempt_started_at"),
    phaseStartedAt: timestamp(row.phase_started_at, "phase_started_at"),
    completedAt: timestamp(row.completed_at, "completed_at"),
    workspaceCleanedAt: timestamp(row.workspace_cleaned_at, "workspace_cleaned_at"),
    releaseFilesPrunedAt: timestamp(row.release_files_pruned_at, "release_files_pruned_at"),
    updatedAt: timestamp(row.updated_at, "updated_at"),
  };
}

export async function getOvertureConflationState(
  schema = "overture_places",
): Promise<ConflationState | null> {
  assertValidOvertureSchema(schema);
  try {
    const rows = await sql.unsafe<StateRow[]>(
      `SELECT ${STATE_COLUMNS}
       FROM "${schema}".conflation_state
       WHERE singleton = 1`,
      [],
    );
    return rows[0] ? mapState(rows[0]) : null;
  } catch (error) {
    const code = (error as { code?: string }).code;
    // A missing schema/table is the only expected "not installed" state.
    // Operational database failures must remain visible to callers.
    if (code === "3F000" || code === "42P01") return null;
    throw error;
  }
}

const ACCUMULATE_PHASE_DURATION = `phase_durations_ms = jsonb_set(
  phase_durations_ms,
  ARRAY[phase],
  to_jsonb(
    COALESCE((phase_durations_ms->>phase)::BIGINT, 0) +
    GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (NOW() - phase_started_at)) * 1000)::BIGINT)
  ),
  true
)`;

async function resetForNewSource(
  schema: string,
  attemptCount: number,
  sourceFingerprint: string,
): Promise<void> {
  await sql.unsafe(
    `TRUNCATE TABLE "${schema}".poi_conflation_candidate,
                    "${schema}".poi_conflation_component,
                    "${schema}".poi_conflation_link_next`,
  );
  await sql.unsafe(
    `UPDATE "${schema}".conflation_state
     SET phase = 'extract', source_fingerprint = $1,
         emitted_count = NULL, extracted_count = NULL, processed_count = NULL,
         candidate_count = NULL, component_count = NULL,
         assignment_cursor = NULL, staged_link_count = NULL,
         score_cursor_h3 = NULL, score_cursor_type = NULL, score_cursor_id = NULL,
         phase_durations_ms = '{}'::JSONB, phase_started_at = NOW(), updated_at = NOW()
     WHERE singleton = 1 AND status = 'running' AND attempt_count = $2`,
    [sourceFingerprint, attemptCount],
  );
}

async function stateAfterTransition(schema: string): Promise<ConflationState> {
  const state = await getOvertureConflationState(schema);
  if (!state) throw new Error("Overture conflation state disappeared during phase transition");
  return state;
}

async function finalizeWorkspace(
  schema: string,
  attemptCount: number,
  cleanup: RebuildDependencies["cleanup"],
): Promise<void> {
  await cleanup(schema);
  await sql.unsafe(
    `UPDATE "${schema}".conflation_state
     SET workspace_cleaned_at = COALESCE(workspace_cleaned_at, NOW()), updated_at = NOW()
     WHERE singleton = 1 AND status = 'completed' AND attempt_count = $1`,
    [attemptCount],
  );
}

/**
 * Rebuilds OSM↔Overture links as a durable state machine. Extraction, scoring,
 * component assignment, and publication are independent retry boundaries.
 */
export async function rebuildOvertureLinks(
  opts: RebuildOvertureLinksOptions,
  dependencies: RebuildDependencies = defaultDependencies,
): Promise<RebuildOvertureLinksResult> {
  return withOvertureOperationLock(() => rebuildOvertureLinksUnlocked(opts, dependencies));
}

/** Caller must hold `withOvertureOperationLock`; exported for sync composition and tests. */
export async function rebuildOvertureLinksUnlocked(
  opts: RebuildOvertureLinksOptions,
  dependencies: RebuildDependencies = defaultDependencies,
): Promise<RebuildOvertureLinksResult> {
  assertValidRegion(opts.region);
  const schema = opts.schema ?? "overture_places";
  assertValidOvertureSchema(schema);

  const current = await getOvertureConflationState(schema);
  if (!current) throw new Error(`No installed Overture release with conflation state in ${schema}`);
  const release = opts.release ?? current.release;
  if (current.release !== release || current.region !== opts.region) {
    throw new Error(
      `Conflation target ${opts.region}@${release} does not match installed ` +
        `${current.region}@${current.release}`,
    );
  }
  const pbfPath = join(opts.dataDir, "osm", osmPbfName(opts.region));
  const pbfExists = dependencies.fileExists(pbfPath);
  const sourceFingerprint = pbfExists ? dependencies.fingerprint(pbfPath) : null;
  const sourceChanged =
    sourceFingerprint !== null &&
    current.sourceFingerprint !== null &&
    current.sourceFingerprint !== sourceFingerprint;
  const restart = opts.force === true || sourceChanged;

  if (current.status === "completed" && !restart) {
    if (current.workspaceCleanedAt === null) {
      try {
        await finalizeWorkspace(schema, current.attemptCount, dependencies.cleanup);
      } catch (cleanupError) {
        opts.onProgress?.(
          `Conflation is complete; retry workspace cleanup remains deferred: ${(cleanupError as Error).message}`,
        );
      }
    }
    return { status: "already_completed", linked: current.linkedCount ?? 0 };
  }

  const claimed = await sql.unsafe<StateRow[]>(
    `UPDATE "${schema}".conflation_state
     SET status = 'running', attempt_count = attempt_count + 1,
         phase = CASE WHEN $3::BOOLEAN THEN 'extract' ELSE phase END,
         source_fingerprint = CASE WHEN $3::BOOLEAN THEN NULL ELSE source_fingerprint END,
         emitted_count = CASE WHEN $3::BOOLEAN THEN NULL ELSE emitted_count END,
         extracted_count = CASE WHEN $3::BOOLEAN THEN NULL ELSE extracted_count END,
         processed_count = CASE WHEN $3::BOOLEAN THEN NULL ELSE processed_count END,
         candidate_count = CASE WHEN $3::BOOLEAN THEN NULL ELSE candidate_count END,
         component_count = CASE WHEN $3::BOOLEAN THEN NULL ELSE component_count END,
         assignment_cursor = CASE WHEN $3::BOOLEAN THEN NULL ELSE assignment_cursor END,
         staged_link_count = CASE WHEN $3::BOOLEAN THEN NULL ELSE staged_link_count END,
         score_cursor_h3 = CASE WHEN $3::BOOLEAN THEN NULL ELSE score_cursor_h3 END,
         score_cursor_type = CASE WHEN $3::BOOLEAN THEN NULL ELSE score_cursor_type END,
         score_cursor_id = CASE WHEN $3::BOOLEAN THEN NULL ELSE score_cursor_id END,
         phase_durations_ms = CASE WHEN $3::BOOLEAN THEN '{}'::JSONB ELSE phase_durations_ms END,
         workspace_cleaned_at = CASE WHEN $3::BOOLEAN THEN NULL ELSE workspace_cleaned_at END,
         release_files_pruned_at =
           CASE WHEN $3::BOOLEAN THEN NULL ELSE release_files_pruned_at END,
         last_error = NULL,
         started_at = CASE WHEN $3::BOOLEAN OR started_at IS NULL THEN NOW() ELSE started_at END,
         attempt_started_at = NOW(), phase_started_at = NOW(), completed_at = NULL,
         updated_at = NOW()
     WHERE singleton = 1 AND release = $1 AND region = $2
       AND ($3::BOOLEAN OR status <> 'completed')
       AND (status <> 'running' OR updated_at < NOW() - INTERVAL '30 minutes')
     RETURNING ${STATE_COLUMNS}`,
    [release, opts.region, restart],
  );
  let state = claimed[0] ? mapState(claimed[0]) : null;
  if (!state) {
    const latest = await getOvertureConflationState(schema);
    if (latest?.status === "completed") {
      return { status: "already_completed", linked: latest.linkedCount ?? 0 };
    }
    return { status: "already_running", linked: latest?.linkedCount ?? 0 };
  }

  if (!pbfExists) {
    await sql.unsafe(
      `UPDATE "${schema}".conflation_state
       SET status = 'waiting_for_osm', last_error = $1, updated_at = NOW()
       WHERE singleton = 1 AND status = 'running' AND attempt_count = $2`,
      [`OSM PBF not found at ${pbfPath}`, state.attemptCount],
    );
    opts.onProgress?.(`OSM PBF not found at ${pbfPath}; link rebuild remains retryable.`);
    return { status: "waiting_for_osm", linked: current.linkedCount ?? 0, pbfPath };
  }

  if (sourceFingerprint === null) {
    throw new Error(`OSM PBF disappeared before conflation at ${pbfPath}`);
  }
  const attemptCount = state.attemptCount;
  const leaseHeartbeat = setInterval(() => {
    void sql
      .unsafe(
        `UPDATE "${schema}".conflation_state SET updated_at = NOW()
         WHERE singleton = 1 AND status = 'running' AND attempt_count = $1`,
        [attemptCount],
      )
      .catch(() => undefined);
  }, 60_000);
  leaseHeartbeat.unref();

  const heartbeatExtract = async (emitted: number): Promise<void> => {
    await sql.unsafe(
      `UPDATE "${schema}".conflation_state
       SET emitted_count = $1, updated_at = NOW()
       WHERE singleton = 1 AND status = 'running' AND attempt_count = $2 AND phase = 'extract'`,
      [emitted, attemptCount],
    );
  };

  try {
    await dependencies.preflight(schema);
    if (restart) {
      opts.onProgress?.(
        opts.force === true
          ? "Explicit restart requested; discarding durable conflation workspace..."
          : "OSM snapshot changed; restarting conflation from extraction...",
      );
      await resetForNewSource(schema, state.attemptCount, sourceFingerprint);
      state = await stateAfterTransition(schema);
    }

    if (state.phase === "extract") {
      opts.onProgress?.(
        `Conflation attempt ${state.attemptCount}, phase extract: streaming the OSM snapshot...`,
      );
      const extraction = await dependencies.extract({
        region: opts.region,
        dataDir: opts.dataDir,
        pbfPath,
        schema,
        onProgress: opts.onProgress,
        onCheckpoint: heartbeatExtract,
      });
      const publishedSourceFingerprint = dependencies.fingerprint(pbfPath);
      if (publishedSourceFingerprint !== sourceFingerprint) {
        throw new Error("OSM PBF changed during extraction; retrying from the new snapshot");
      }
      await sql.unsafe(
        `UPDATE "${schema}".conflation_state
         SET ${ACCUMULATE_PHASE_DURATION}, phase = 'score', phase_started_at = NOW(),
             source_fingerprint = $1, emitted_count = $2, extracted_count = $3,
             processed_count = 0, candidate_count = 0,
             score_cursor_h3 = NULL, score_cursor_type = '', score_cursor_id = 0,
             component_count = NULL, assignment_cursor = NULL, staged_link_count = NULL,
             updated_at = NOW()
         WHERE singleton = 1 AND status = 'running' AND attempt_count = $4 AND phase = 'extract'`,
        [sourceFingerprint, extraction.emitted, extraction.extracted, state.attemptCount],
      );
      state = await stateAfterTransition(schema);
    }

    if (state.phase === "score") {
      opts.onProgress?.(
        `Conflation attempt ${state.attemptCount}, phase score: continuing at ` +
          `${state.processedCount ?? 0} processed POIs...`,
      );
      const hasCursor = state.scoreCursorH3 !== null;
      const score = await dependencies.score({
        region: opts.region,
        release,
        schema,
        ollamaUrl: opts.ollamaUrl,
        useEmbeddings: opts.useEmbeddings,
        resume: hasCursor
          ? {
              cursor: {
                h3: state.scoreCursorH3,
                osmType: state.scoreCursorType ?? "",
                osmId: String(state.scoreCursorId ?? 0),
              },
              processed: state.processedCount ?? 0,
              candidates: state.candidateCount ?? 0,
            }
          : undefined,
        onProgress: opts.onProgress,
        onCheckpoint: async (processed, candidates, cursor) => {
          await sql.unsafe(
            `UPDATE "${schema}".conflation_state
             SET processed_count = $1, candidate_count = $2,
                 score_cursor_h3 = $3, score_cursor_type = $4, score_cursor_id = $5::BIGINT,
                 updated_at = NOW()
             WHERE singleton = 1 AND status = 'running' AND attempt_count = $6 AND phase = 'score'`,
            [processed, candidates, cursor.h3, cursor.osmType, cursor.osmId, attemptCount],
          );
        },
      });
      await sql.unsafe(
        `UPDATE "${schema}".conflation_state
         SET ${ACCUMULATE_PHASE_DURATION}, phase = 'assign', phase_started_at = NOW(),
             processed_count = $1, candidate_count = $2,
             score_cursor_h3 = $3, score_cursor_type = $4, score_cursor_id = $5::BIGINT,
             component_count = NULL, assignment_cursor = 0, staged_link_count = 0,
             updated_at = NOW()
         WHERE singleton = 1 AND status = 'running' AND attempt_count = $6 AND phase = 'score'`,
        [
          score.processed,
          score.candidates,
          score.cursor.h3,
          score.cursor.osmType,
          score.cursor.osmId,
          state.attemptCount,
        ],
      );
      state = await stateAfterTransition(schema);
    }

    if (state.phase === "assign") {
      opts.onProgress?.(
        `Conflation attempt ${state.attemptCount}, phase assign: solving exact components...`,
      );
      const assigned = await dependencies.assign({
        schema,
        componentCount: state.componentCount,
        assignmentCursor: state.assignmentCursor,
        stagedLinks: state.stagedLinkCount,
        onProgress: opts.onProgress,
        onWorkspace: async (components) => {
          await sql.unsafe(
            `UPDATE "${schema}".conflation_state
             SET component_count = $1, assignment_cursor = 0, staged_link_count = 0,
                 updated_at = NOW()
             WHERE singleton = 1 AND status = 'running' AND attempt_count = $2 AND phase = 'assign'`,
            [components, attemptCount],
          );
        },
        onCheckpoint: async (assignmentCursor, stagedLinks) => {
          await sql.unsafe(
            `UPDATE "${schema}".conflation_state
             SET assignment_cursor = $1, staged_link_count = $2, updated_at = NOW()
             WHERE singleton = 1 AND status = 'running' AND attempt_count = $3 AND phase = 'assign'`,
            [assignmentCursor, stagedLinks, attemptCount],
          );
        },
      });

      opts.onProgress?.("Running fused OSM + Overture quality regression gate...");
      const quality = await dependencies.validateFusedQuality(schema, opts.region);
      opts.onProgress?.(`Fused quality gate passed (${quality.applicableCases} cases).`);
      await sql.unsafe(
        `UPDATE "${schema}".conflation_state
         SET ${ACCUMULATE_PHASE_DURATION}, phase = 'publish', phase_started_at = NOW(),
             component_count = $1, assignment_cursor = $2, staged_link_count = $3,
             updated_at = NOW()
         WHERE singleton = 1 AND status = 'running' AND attempt_count = $4 AND phase = 'assign'`,
        [assigned.components, assigned.assignmentCursor, assigned.stagedLinks, state.attemptCount],
      );
      state = await stateAfterTransition(schema);
    }

    if (state.phase === "publish") {
      if (dependencies.fingerprint(pbfPath) !== sourceFingerprint) {
        throw new Error("OSM PBF changed before link publication; retrying from the new snapshot");
      }
      opts.onProgress?.(
        `Conflation attempt ${state.attemptCount}, phase publish: atomically activating links...`,
      );
      const published = await dependencies.publish(schema);
      await sql.unsafe(
        `UPDATE "${schema}".conflation_state
         SET ${ACCUMULATE_PHASE_DURATION}, phase = 'complete', status = 'completed',
             linked_count = $1, staged_link_count = $1, last_error = NULL,
             completed_at = NOW(), phase_started_at = NULL, updated_at = NOW()
         WHERE singleton = 1 AND status = 'running' AND attempt_count = $2 AND phase = 'publish'`,
        [published.linked, state.attemptCount],
      );
      state = await stateAfterTransition(schema);
      try {
        await finalizeWorkspace(schema, state.attemptCount, dependencies.cleanup);
      } catch (cleanupError) {
        opts.onProgress?.(
          `Conflation completed; retry workspace cleanup deferred: ${(cleanupError as Error).message}`,
        );
      }
    }

    return {
      status: "completed",
      linked: state.linkedCount ?? 0,
      emitted: state.emittedCount ?? 0,
      extracted: state.extractedCount ?? 0,
      candidates: state.candidateCount ?? 0,
      components: state.componentCount ?? 0,
      phaseDurationsMs: state.phaseDurationsMs,
    };
  } catch (error) {
    const message = scrubSecrets((error as Error).message);
    await sql.unsafe(
      `UPDATE "${schema}".conflation_state
       SET ${ACCUMULATE_PHASE_DURATION}, status = 'failed', last_error = LEFT($1, 4000),
           phase_started_at = NULL, updated_at = NOW()
       WHERE singleton = 1 AND status = 'running' AND attempt_count = $2`,
      [message, state.attemptCount],
    );
    opts.onProgress?.(
      `Conflation attempt ${state.attemptCount} failed in ${state.phase}: ${message}`,
    );
    return {
      status: "failed",
      linked: current.linkedCount ?? 0,
      phase: state.phase,
      error: message,
    };
  } finally {
    clearInterval(leaseHeartbeat);
  }
}
