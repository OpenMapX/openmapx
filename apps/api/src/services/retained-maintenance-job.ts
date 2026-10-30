/** Finite queued maintenance requests, retained in the existing admin job table. */
import { createHmac, randomUUID } from "node:crypto";
import { canonicalJson, readOpsTokenFile } from "@openmapx/core/ops";
import { and, sql } from "drizzle-orm";
import { db } from "../db";
import { adminJob } from "../db/schema";
import { dbActorId } from "../utils/actor";
export type RetainedMaintenanceJobType = "release.clear" | "service.images.pull";
export class MaintenanceRequestConflict extends Error {}
export async function retainMaintenanceJob(
  type: RetainedMaintenanceJobType,
  payload: Record<string, unknown>,
  actorId: string,
  key: string,
): Promise<string> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/.test(key))
    throw new MaintenanceRequestConflict("Invalid mutation key");
  const token = await readOpsTokenFile(process.env.OPS_AGENT_TOKEN_FILE ?? "");
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
      payload: { ...payload, _maintenanceRequest: { actorId, key, digest } },
    });
    return id;
  });
}
