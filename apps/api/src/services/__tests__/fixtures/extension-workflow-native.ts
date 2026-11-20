/** Native API-role process fixture. Only the test's fixed owned job is read. */
import { eq } from "drizzle-orm";
import { db, sql } from "../../../db";
import { adminJob, installedExtension, installedIntegration } from "../../../db/schema";
import { checkpointOwnedAdminJob } from "../../admin-job-checkpoint";
import { jobCheckpoint, jobOwnership, replaceJobCheckpoint } from "../../admin-job-state";
import { publishIntegration, settleIntegration } from "../../agent-integrations";
import {
  extensionDatabaseStep,
  extensionStep,
  openExtensionWorkflow,
} from "../../extension-workflow";
import type { JobContext } from "../../job-runner";
import { createDurableOpsKey } from "../../ops-client";

const [id, stopAt] = process.argv.slice(2);
if (!id) throw Error("Owned job required");
const [row] = await db.select().from(adminJob).where(eq(adminJob.id, id));
if (!row || row.type !== "extension.install" || row.status !== "running")
  throw Error("Owned job missing");
const payload = row.payload as {
    source: { kind: "artifact"; url: string; sha256: string };
    bundle: string;
  },
  execution = (row.protocol as { execution: { owner: string; version: number } }).execution;
const ctx: JobContext = {
  jobId: id,
  jobType: row.type,
  execution,
  payload: row.payload as Record<string, unknown>,
  signal: new AbortController().signal,
  checkpointResult: jobCheckpoint(row.result, row.protocol),
  protocol: row.protocol,
  log: async () => {},
  setProgress: async () => {},
  checkpoint: async (value, progress, key, address, operations) => {
    const recorded = operations ?? (ctx.protocol?.operations as typeof operations);
    if (recorded) {
      const saved = await checkpointOwnedAdminJob(
        id,
        execution,
        value,
        recorded,
        progress,
        key,
        address,
        ctx.checkpointResult ?? {},
      );
      ctx.checkpointResult = saved.result;
      ctx.protocol = saved.protocol;
    } else {
      const [saved] = await db
        .update(adminJob)
        .set(replaceJobCheckpoint(value))
        .where(jobOwnership(id, execution))
        .returning();
      if (!saved) throw Error("Owner changed");
      ctx.checkpointResult = jobCheckpoint(saved.result, saved.protocol);
      ctx.protocol = saved.protocol;
    }
  },
};
const cursor = await openExtensionWorkflow(ctx, { native: true });
const publication = await extensionStep(cursor, "publish", payload.source, () =>
  publishIntegration(
    { integrationId: "workflow-map", source: payload.source, extensionId: payload.bundle },
    {
      ctx,
      operationKey: createDurableOpsKey("extension.integration.publish", `${id}:workflow-map`),
    },
  ),
);
async function boundary(name: string) {
  if (stopAt !== name) return;
  process.send?.({ boundary: name });
  await new Promise(() => {});
}
await boundary("published");
await extensionDatabaseStep(cursor, "bookkeeping", { bundle: payload.bundle }, async (tx) => {
  await tx
    .insert(installedExtension)
    .values({
      id: payload.bundle,
      name: payload.bundle,
      sourceTrust: "community",
      installedVersion: "1.0.0",
      manifest: { id: payload.bundle, name: payload.bundle, version: "1.0.0" },
    })
    .onConflictDoUpdate({ target: installedExtension.id, set: { installedVersion: "1.0.0" } });
  await tx
    .insert(installedIntegration)
    .values({
      id: "workflow-map",
      repository: payload.source.url,
      sourceType: "registry",
      installedVersion: "1.0.0",
      managedByExtension: payload.bundle,
      lastTransactionId: publication.transactionId,
    })
    .onConflictDoUpdate({
      target: installedIntegration.id,
      set: { managedByExtension: payload.bundle, lastTransactionId: publication.transactionId },
    });
});
await boundary("bookkept");
await extensionStep(cursor, "settle", { transactionId: publication.transactionId }, () =>
  settleIntegration(
    { integrationId: "workflow-map", transactionId: publication.transactionId, outcome: "commit" },
    {
      ctx,
      operationKey: createDurableOpsKey(
        "extension.integration.commit",
        `${id}:${publication.transactionId}`,
      ),
    },
  ),
);
await sql.end({ timeout: 2 });
process.send?.({ complete: true });
