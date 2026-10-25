import { AsyncLocalStorage } from "node:async_hooks";
import type postgres from "postgres";
import { rawSql } from "../../db/index.js";
import { AmbientPublicationBusyError } from "../ambient-places/schema.js";
import { createJobRow } from "../persistence.js";

const current = new AsyncLocalStorage<{
  id: string;
  version: number;
  operations: Record<string, unknown>[];
  database: postgres.Sql;
}>();
export function legacyDataMutation() {
  return current.getStore();
}
export async function checkpointLegacyDataOperation(
  operation: Record<string, unknown>,
): Promise<void> {
  const context = current.getStore();
  if (!context) throw Error("Retained data mutation admission required");
  const index = context.operations.findIndex(
      (entry) => entry.operationKey === operation.operationKey,
    ),
    next = [...context.operations];
  if (index < 0) next.push(operation);
  else next[index] = operation;
  if (next.length > 32 || Buffer.byteLength(JSON.stringify(next)) > 128 * 1024)
    throw Error("Retained legacy operation capacity exceeded");
  const rows =
    await context.database`UPDATE data_manager.jobs SET metadata=jsonb_set(coalesce(metadata,'{}'::jsonb),'{retainedOps}',${JSON.stringify(next)}::text::jsonb),ownership_version=ownership_version+1 WHERE id=${context.id} AND ownership_version=${context.version} AND finished_at IS NULL RETURNING ownership_version`;
  if (rows.length !== 1) throw Error("Legacy data operation owner CAS lost");
  context.version = Number(rows[0]!.ownership_version);
  context.operations = next;
}
export type LegacyDataMutationKind =
  | "traffic-live"
  | "traffic-maintenance"
  | "traffic-predicted"
  | "transit-proposal"
  | "data-reload"
  | "ambient-publication";
/** Admission is awaited before returning202; completion retains its own actual
 * SQL owner and every nested host-operation checkpoint until containment. */
export async function startLegacyDataMutation<T>(
  kind: LegacyDataMutationKind,
  run: () => Promise<T>,
  database: postgres.Sql = rawSql,
): Promise<{ id: string; completion: Promise<T> }> {
  const id = await createJobRow(
    { kind, triggeredBy: "data-manager", metadata: { version: 1, retainedOps: [] } },
    database,
  );
  const context = { id, version: 0, operations: [] as Record<string, unknown>[], database };
  const finish = async (status: string) => {
    const rows =
      await database`UPDATE data_manager.jobs SET status=${status},finished_at=${new Date().toISOString()}::text::timestamptz WHERE id=${id} AND ownership_version=${context.version} AND execution_version IS NULL AND kind <> 'configuration-maintenance' AND finished_at IS NULL RETURNING id`;
    if (rows.length !== 1) throw Error("Legacy writer terminal CAS lost");
  };
  const completion = current.run(context, async () => {
    try {
      const value = await run();
      await finish("ok");
      return value;
    } catch (error) {
      if (kind === "ambient-publication" && error instanceof AmbientPublicationBusyError) {
        await finish("error");
        throw error;
      }
      await database`UPDATE data_manager.jobs SET status='interrupted',finished_at=NULL,metadata=jsonb_set(coalesce(metadata,'{}'::jsonb),'{recoveryRequired}','true'::jsonb) WHERE id=${id} AND finished_at IS NULL`;
      throw error;
    }
  });
  void completion.catch(() => {});
  return { id, completion };
}
export async function withLegacyDataMutation<T>(
  kind: LegacyDataMutationKind,
  run: () => Promise<T>,
  database: postgres.Sql = rawSql,
): Promise<T> {
  if (current.getStore()) return run();
  const owned = await startLegacyDataMutation(kind, run, database);
  return owned.completion;
}

/** A background maintenance operation admits its own durable row; it must not
 * inherit a parent cycle that can finish while the operation is still alive. */
export function independentLegacyDataMutation<T>(
  kind: Parameters<typeof withLegacyDataMutation>[0],
  run: () => Promise<T>,
): Promise<T> {
  return current.exit(() => withLegacyDataMutation(kind, run));
}
