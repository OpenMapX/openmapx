import { jobStages, jobs } from "@openmapx/db-schema";
import { and, eq, isNull, ne } from "drizzle-orm";
import type postgres from "postgres";
import z from "zod/v4";
import { db, rawSql } from "../db/index.js";
import { scrubDiagnosticValue, scrubSecrets } from "../utils/scrub-secrets.js";
import { assertDataMutationAdmission } from "./execution/admission.js";

export interface CreateJobRowOptions {
  kind: string;
  triggeredBy?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface PersistableStageResult {
  stage: string;
  status: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  message?: string;
  error?: { message: string; stack?: string };
  artifacts?: Record<string, unknown>;
}

export interface PersistenceLogger {
  warn(message: string): unknown;
}

export async function createJobRow(
  options: CreateJobRowOptions,
  database: postgres.Sql = rawSql,
): Promise<string> {
  const { inserted } = await database.begin(async (tx) => {
    await assertDataMutationAdmission(tx);
    const inserted = await tx<
      { id: string }[]
    >`INSERT INTO data_manager.jobs(kind,status,triggered_by,metadata)
    VALUES(${options.kind},'running',${options.triggeredBy ?? null},${options.metadata ? JSON.stringify(z.json().parse(options.metadata)) : null}::text::jsonb) RETURNING id`;
    return { inserted };
  });
  const row = inserted[0];
  if (!row) throw new Error("Failed to create data_manager.jobs row");
  return row.id;
}

export async function finalizeJobRow(jobId: string, status: string): Promise<void> {
  await db
    .update(jobs)
    .set({ status, finishedAt: new Date() })
    .where(
      and(
        eq(jobs.id, jobId),
        isNull(jobs.executionVersion),
        ne(jobs.kind, "configuration-maintenance"),
      ),
    );
}

export function makePersistingOnStageComplete<TStage extends PersistableStageResult>(
  jobId: string,
  logger: PersistenceLogger,
  logPrefix: string,
): (result: TStage) => Promise<void> {
  return async (result) => {
    try {
      const diagnostics = scrubDiagnosticValue({
        message: result.message ?? null,
        error: result.error ?? null,
        artifacts: result.artifacts ?? null,
      }) as {
        message: string | null;
        error: TStage["error"] | null;
        artifacts: Record<string, unknown> | null;
      };
      await db.insert(jobStages).values({
        jobId,
        stage: result.stage,
        status: result.status,
        startedAt: new Date(result.startedAt),
        finishedAt: new Date(result.finishedAt),
        durationMs: result.durationMs,
        message: diagnostics.message,
        error: diagnostics.error,
        artifacts: diagnostics.artifacts,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(
        scrubSecrets(
          `${logPrefix}: failed to persist stage result for ${result.stage}: ${message}`,
        ),
      );
    }
  };
}
