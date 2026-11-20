import { jobStages } from "@openmapx/db-schema";
import { drizzle } from "drizzle-orm/postgres-js";
import type postgres from "postgres";
import { scrubDiagnosticValue, scrubSecrets } from "../utils/scrub-secrets.js";

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

export function makePersistingOnStageComplete<TStage extends PersistableStageResult>(
  sql: postgres.Sql,
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
      await drizzle(sql)
        .insert(jobStages)
        .values({
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
