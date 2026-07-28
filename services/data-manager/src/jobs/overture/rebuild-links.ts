import { existsSync } from "node:fs";
import { join } from "node:path";
import { sql } from "../../db/index.js";
import { osmPbfName } from "../download-osm.js";
import { conflateOverture } from "./conflate.js";
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

export interface ConflationState {
  release: string;
  region: string;
  status: ConflationStateStatus;
  attemptCount: number;
  extractedCount: number | null;
  candidateCount: number | null;
  linkedCount: number | null;
  lastError: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  updatedAt: Date;
}

export type RebuildOvertureLinksResult =
  | { status: "completed"; linked: number; extracted: number; candidates: number }
  | { status: "already_completed"; linked: number }
  | { status: "already_running"; linked: number }
  | { status: "waiting_for_osm"; linked: number; pbfPath: string }
  | { status: "failed"; linked: number; error: string };

export interface RebuildOvertureLinksOptions {
  region: string;
  dataDir: string;
  release?: string;
  schema?: string;
  force?: boolean;
  ollamaUrl?: string;
  useEmbeddings?: boolean;
  onProgress?: (message: string) => void;
}

interface RebuildDependencies {
  fileExists: typeof existsSync;
  extract: typeof extractOsmPois;
  conflate: typeof conflateOverture;
}

const defaultDependencies: RebuildDependencies = {
  fileExists: existsSync,
  extract: extractOsmPois,
  conflate: conflateOverture,
};

interface StateRow {
  release: string;
  region: string;
  status: ConflationStateStatus;
  attempt_count: number;
  extracted_count: string | null;
  candidate_count: string | null;
  linked_count: string | null;
  last_error: string | null;
  started_at: Date | null;
  completed_at: Date | null;
  updated_at: Date;
}

function mapState(row: StateRow): ConflationState {
  return {
    release: row.release,
    region: row.region,
    status: row.status,
    attemptCount: Number(row.attempt_count),
    extractedCount: row.extracted_count === null ? null : Number(row.extracted_count),
    candidateCount: row.candidate_count === null ? null : Number(row.candidate_count),
    linkedCount: row.linked_count === null ? null : Number(row.linked_count),
    lastError: row.last_error,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at,
  };
}

export async function getOvertureConflationState(
  schema = "overture_places",
): Promise<ConflationState | null> {
  assertValidOvertureSchema(schema);
  try {
    const rows = await sql.unsafe<StateRow[]>(
      `SELECT release, region, status, attempt_count,
              extracted_count::TEXT, candidate_count::TEXT, linked_count::TEXT,
              last_error, started_at, completed_at, updated_at
       FROM "${schema}".conflation_state
       WHERE singleton = 1`,
      [],
    );
    return rows[0] ? mapState(rows[0]) : null;
  } catch {
    return null;
  }
}

/**
 * Rebuilds the optional OSM↔Overture links without touching the installed
 * Places snapshot. The state row is also a renewable database lease: another
 * process can reclaim an abandoned `running` attempt after 30 minutes, while
 * active extraction/scoring checkpoints keep the lease fresh.
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
  if (!current) {
    throw new Error(`No installed Overture release with conflation state in ${schema}`);
  }
  const release = opts.release ?? current.release;
  if (current.release !== release || current.region !== opts.region) {
    throw new Error(
      `Conflation target ${opts.region}@${release} does not match installed ` +
        `${current.region}@${current.release}`,
    );
  }
  if (current.status === "completed" && !opts.force) {
    return { status: "already_completed", linked: current.linkedCount ?? 0 };
  }

  const pbfPath = join(opts.dataDir, "osm", osmPbfName(opts.region));
  const claimed = await sql.unsafe<StateRow[]>(
    `UPDATE "${schema}".conflation_state
     SET status = 'running',
         attempt_count = attempt_count + 1,
         extracted_count = NULL,
         candidate_count = NULL,
         last_error = NULL,
         started_at = NOW(),
         completed_at = NULL,
         updated_at = NOW()
     WHERE singleton = 1
       AND release = $1
       AND region = $2
       AND ($3::BOOLEAN OR status <> 'completed')
       AND (status <> 'running' OR updated_at < NOW() - INTERVAL '30 minutes')
     RETURNING release, region, status, attempt_count,
               extracted_count::TEXT, candidate_count::TEXT, linked_count::TEXT,
               last_error, started_at, completed_at, updated_at`,
    [release, opts.region, opts.force === true],
  );
  const attempt = claimed[0] ? mapState(claimed[0]) : null;
  if (!attempt) {
    const state = await getOvertureConflationState(schema);
    if (state?.status === "completed") {
      return { status: "already_completed", linked: state.linkedCount ?? 0 };
    }
    return { status: "already_running", linked: state?.linkedCount ?? 0 };
  }
  if (!dependencies.fileExists(pbfPath)) {
    await sql.unsafe(
      `UPDATE "${schema}".conflation_state
       SET status = 'waiting_for_osm', last_error = $1, updated_at = NOW()
       WHERE singleton = 1 AND status = 'running' AND attempt_count = $2`,
      [`OSM PBF not found at ${pbfPath}`, attempt.attemptCount],
    );
    opts.onProgress?.(`OSM PBF not found at ${pbfPath}; link rebuild remains retryable.`);
    return { status: "waiting_for_osm", linked: current.linkedCount ?? 0, pbfPath };
  }

  const heartbeat = async (fields: { extracted?: number; candidates?: number }): Promise<void> => {
    await sql.unsafe(
      `UPDATE "${schema}".conflation_state
       SET extracted_count = COALESCE($1::BIGINT, extracted_count),
           candidate_count = COALESCE($2::BIGINT, candidate_count),
           updated_at = NOW()
       WHERE singleton = 1 AND status = 'running' AND attempt_count = $3`,
      [fields.extracted ?? null, fields.candidates ?? null, attempt.attemptCount],
    );
  };

  try {
    opts.onProgress?.(`Conflation attempt ${attempt.attemptCount}: streaming the OSM snapshot...`);
    const extraction = await dependencies.extract({
      region: opts.region,
      dataDir: opts.dataDir,
      pbfPath,
      onProgress: opts.onProgress,
      onCheckpoint: (extracted) => heartbeat({ extracted }),
    });
    await heartbeat({ extracted: extraction.extracted });

    const result = await dependencies.conflate({
      region: opts.region,
      release,
      schema,
      ollamaUrl: opts.ollamaUrl,
      useEmbeddings: opts.useEmbeddings,
      onProgress: opts.onProgress,
      onCheckpoint: (_processed, candidates) => heartbeat({ candidates }),
    });
    await sql.unsafe(
      `UPDATE "${schema}".conflation_state
       SET status = 'completed', extracted_count = $1, candidate_count = $2,
           linked_count = $3, last_error = NULL, completed_at = NOW(), updated_at = NOW()
       WHERE singleton = 1 AND status = 'running' AND attempt_count = $4`,
      [extraction.extracted, result.candidates, result.linked, attempt.attemptCount],
    );
    return {
      status: "completed",
      linked: result.linked,
      extracted: extraction.extracted,
      candidates: result.candidates,
    };
  } catch (error) {
    const message = (error as Error).message;
    await sql.unsafe(
      `UPDATE "${schema}".conflation_state
       SET status = 'failed', last_error = LEFT($1, 4000), updated_at = NOW()
       WHERE singleton = 1 AND status = 'running' AND attempt_count = $2`,
      [message, attempt.attemptCount],
    );
    opts.onProgress?.(`Conflation attempt ${attempt.attemptCount} failed: ${message}`);
    return { status: "failed", linked: current.linkedCount ?? 0, error: message };
  }
}
