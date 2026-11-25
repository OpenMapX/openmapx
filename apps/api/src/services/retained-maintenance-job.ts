/** Finite queued maintenance requests, retained in the existing admin job table. */
import { createHash } from "node:crypto";
import type { AdminJobType } from "@openmapx/core/jobs";
import { canonicalJson } from "@openmapx/core/ops";
import { and, sql } from "drizzle-orm";
import { db } from "../db";
import { adminJob } from "../db/schema";
import { actorUserIdOrNull } from "../utils/actor";
// Service/backup additions share admission identity only. Their existing
// operation observers and coordinator recovery remain unchanged; they are not
// added to the finite retainedMaintenanceJob handler-replay routing list.
export type RetainedMaintenanceJobType = Extract<
  AdminJobType,
  | "release.clear"
  | "service.image.pull"
  | "backup.prune"
  | "compose.render"
  | "artifact.validate"
  | "artifact.import"
  | "artifact.export"
  | "service.start"
  | "service.stop"
  | "service.restart"
  | "service.core.restart"
  | "service.apply"
  | "service.batch.run"
  | "backup.operation.run"
>;
export class MaintenanceRequestConflict extends Error {}
function maintenanceRequestDigest(type: string, payload: unknown, actorId: string): string {
  return createHash("sha256")
    .update("openmapx-maintenance-request-v1\0")
    .update(canonicalJson({ type, payload, actorId }))
    .digest("hex");
}
export async function retainMaintenanceJob(
  type: RetainedMaintenanceJobType,
  payload: Record<string, unknown>,
  actorId: string,
  key: string,
  intent: Record<string, unknown> = payload,
): Promise<string> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/.test(key))
    throw new MaintenanceRequestConflict("Invalid mutation key");
  const digest = maintenanceRequestDigest(type, intent, actorId);
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`maintenance:${actorId}:${key}`},0))`,
    );
    const rows = await tx
      .select()
      .from(adminJob)
      .where(
        and(
          sql`${adminJob.payload}->'_maintenanceRequest'->>'actorId' = ${actorId}`,
          sql`${adminJob.payload}->'_maintenanceRequest'->>'key' = ${key}`,
        ),
      )
      .limit(2);
    if (rows.length) {
      const old = rows[0],
        request = (old?.payload as { _maintenanceRequest?: { digest?: string } })
          ?._maintenanceRequest;
      if (rows.length !== 1 || old?.type !== type || request?.digest !== digest)
        throw new MaintenanceRequestConflict("Mutation key belongs to another maintenance request");
      return old.id;
    }
    const [created] = await tx
      .insert(adminJob)
      .values({
        type,
        status: "queued",
        createdByUserId: actorUserIdOrNull(actorId),
        payload: {
          ...payload,
          _maintenanceRequest: { actorId, key, digest },
        },
      })
      .returning({ id: adminJob.id });
    if (!created) throw new Error("Maintenance job was not retained");
    return created.id;
  });
}

/** Replay observes the original request before checking mutable stage state.
 * The retained row's actor/body digest still has to match exactly. */
export async function lookupMaintenanceJob(
  type: RetainedMaintenanceJobType,
  payload: Record<string, unknown>,
  actorId: string,
  key: string,
): Promise<string | null> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/.test(key))
    throw new MaintenanceRequestConflict("Invalid mutation key");
  const digest = maintenanceRequestDigest(type, payload, actorId);
  const rows = await db
    .select()
    .from(adminJob)
    .where(
      and(
        sql`${adminJob.payload}->'_maintenanceRequest'->>'actorId' = ${actorId}`,
        sql`${adminJob.payload}->'_maintenanceRequest'->>'key' = ${key}`,
      ),
    )
    .limit(2);
  if (!rows.length) return null;
  const old = rows[0],
    request = (old?.payload as { _maintenanceRequest?: { digest?: string } })?._maintenanceRequest;
  if (rows.length !== 1 || old?.type !== type || request?.digest !== digest)
    throw new MaintenanceRequestConflict("Mutation key belongs to another maintenance request");
  return old.id;
}
