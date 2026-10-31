/** Finite queued maintenance requests, retained in the existing admin job table. */
import { createHmac, randomUUID } from "node:crypto";
import { canonicalJson, readOpsTokenFile } from "@openmapx/core/ops";
import { envString } from "@openmapx/core/server-env";
import { and, sql } from "drizzle-orm";
import { db } from "../db";
import { adminJob } from "../db/schema";
import { dbActorId } from "../utils/actor";
import { maintenanceJobAuthorization } from "./retained-maintenance-authorization";
export type RetainedMaintenanceJobType =
  | "release.clear"
  | "service.images.pull"
  | "backup.prune"
  | "compose.render"
  | "artifact.validate"
  | "artifact.import"
  | "artifact.export";
export class MaintenanceRequestConflict extends Error {}
export async function retainMaintenanceJob(
  type: RetainedMaintenanceJobType,
  payload: Record<string, unknown>,
  actorId: string,
  key: string,
): Promise<string> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/.test(key))
    throw new MaintenanceRequestConflict("Invalid mutation key");
  const token = await readOpsTokenFile(envString("OPS_AGENT_TOKEN_FILE", ""));
  const digest = createHmac("sha256", token)
    .update("openmapx-maintenance-request-v1\0")
    .update(canonicalJson({ type, payload, actorId }))
    .digest("hex");
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
    const id = randomUUID();
    await tx.insert(adminJob).values({
      id,
      type,
      status: "queued",
      createdBy: dbActorId(actorId),
      payload: {
        ...payload,
        _maintenanceRequest: {
          actorId,
          key,
          digest,
          authorization: maintenanceJobAuthorization(token, {
            jobId: id,
            type,
            payload,
            actorId,
            key,
          }),
        },
      },
    });
    return id;
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
  const token = await readOpsTokenFile(envString("OPS_AGENT_TOKEN_FILE", "")),
    digest = createHmac("sha256", token)
      .update("openmapx-maintenance-request-v1\0")
      .update(canonicalJson({ type, payload, actorId }))
      .digest("hex");
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
