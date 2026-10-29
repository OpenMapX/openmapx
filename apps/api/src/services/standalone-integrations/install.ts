import { createHmac } from "node:crypto";
import {
  standaloneInstallRequestSchema,
  standalonePreviewRequestSchema,
} from "@openmapx/core/api-contracts";
import {
  canonicalJson,
  readOpsTokenFile,
  type StandaloneIntegrationProvenance,
  standaloneInstallInspectionSchema,
  standaloneInstallSourceSchema,
  standaloneIntegrationProvenanceSchema,
} from "@openmapx/core/ops";
import { and, eq, sql } from "drizzle-orm";
import z from "zod/v4";
import { db } from "../../db";
import {
  adminJob,
  installedExtension,
  installedExtensionComponent,
  installedIntegration,
} from "../../db/schema";
import { reloadIntegrations } from "../../integration-host";
import { dbActorId } from "../../utils/actor";
import { AdminJobFailure, JobObservationPending } from "../admin-job-failure";
import { executeAdminJobOperation } from "../admin-job-ops";
import { readProjection } from "../admin-job-projection";
import { withExtensionChangeLock } from "../extension-recovery";
import type { JobContext } from "../job-runner";

type State = import("./state").StandaloneState;

import { readStandaloneState, sealStandaloneState } from "./state";

async function token() {
  return readOpsTokenFile(process.env.OPS_AGENT_TOKEN_FILE ?? "");
}
async function authenticatePayload(ctx: JobContext) {
  const payload = ctx.payload;
  if (
    typeof payload.ownerId !== "string" ||
    payload.ownerId !== payload._standaloneActor ||
    typeof payload.operationId !== "string" ||
    !z.uuid().safeParse(payload.operationId).success
  )
    throw new JobObservationPending("recovery_required");
  const type = ctx.jobType;
  const body =
    type === "standalone.preview"
      ? standalonePreviewRequestSchema.parse({ source: payload.source })
      : standaloneInstallRequestSchema.parse({
          inspectionId: payload.inspectionId,
          expectedContentDigest: payload.expectedContentDigest,
        });
  const expected = createHmac("sha256", await token())
    .update("openmapx-standalone-request-v1\0")
    .update(canonicalJson({ type, payload: body, actorId: payload.ownerId }))
    .digest("hex");
  if (payload._requestDigest !== expected) throw new JobObservationPending("recovery_required");
  return { ownerId: payload.ownerId, operationId: payload.operationId, body };
}
async function save(ctx: JobContext, state: State) {
  const sealed = await sealStandaloneState(state);
  await ctx.checkpoint({
    ...ctx.checkpointResult,
    _standalone: sealed,
    _standaloneSettled: state.phase === "complete",
  });
}
async function restore(ctx: JobContext): Promise<State | null> {
  const value = ctx.checkpointResult?._standalone;
  if (value === undefined) return null;
  const state = await readStandaloneState(value);
  const payload = await authenticatePayload(ctx);
  if (
    state.jobId !== ctx.jobId ||
    state.operationId !== payload.operationId ||
    state.ownerId !== payload.ownerId ||
    canonicalJson(state.request) !== canonicalJson(payload.body)
  )
    throw new JobObservationPending("recovery_required");
  return state;
}
async function cancellationRequested(ctx: JobContext) {
  const [row] = await db
    .select({ status: adminJob.status })
    .from(adminJob)
    .where(eq(adminJob.id, ctx.jobId));
  if (!row) throw new JobObservationPending("recovery_required");
  return row.status === "cancel_pending" || row.status === "canceled";
}
function provenance(state: State): StandaloneIntegrationProvenance {
  const inspection = state.inspection,
    source = state.source;
  return standaloneIntegrationProvenanceSchema.parse(
    source.kind === "source"
      ? {
          kind: source.kind,
          url: source.repository,
          commit: inspection.commit,
          contentDigest: inspection.contentDigest,
        }
      : source.kind === "artifact"
        ? {
            kind: source.kind,
            url: source.url,
            artifactSha256: inspection.archiveSha256,
            contentDigest: inspection.contentDigest,
          }
        : {
            kind: source.kind,
            stageId: source.stageId,
            artifactSha256: inspection.archiveSha256,
            contentDigest: inspection.contentDigest,
          },
  );
}
async function previewForInstall(ctx: JobContext, ownerId: string, inspectionId: string) {
  const rows = await db
    .select()
    .from(adminJob)
    .where(
      and(
        eq(adminJob.type, "standalone.preview"),
        eq(adminJob.status, "success"),
        sql`${adminJob.payload}->>'ownerId' = ${ownerId}`,
        sql`${adminJob.result}->>'inspectionId' = ${inspectionId}`,
      ),
    )
    .limit(2);
  if (rows.length !== 1)
    throw new AdminJobFailure("Standalone preview is missing or belongs to another administrator", {
      operationId: ctx.payload.operationId,
    });
  const row = rows[0]!;
  await authenticatePayload({
    ...ctx,
    jobId: row.id,
    jobType: row.type,
    payload: row.payload as Record<string, unknown>,
  });
  return {
    source: standaloneInstallSourceSchema.parse((row.payload as { source: unknown }).source),
    inspection: standaloneInstallInspectionSchema.parse(
      Object.fromEntries(
        Object.entries(row.result as Record<string, unknown>).filter(([key]) =>
          Object.hasOwn(standaloneInstallInspectionSchema.shape, key),
        ),
      ),
    ),
  };
}
async function ownership(integrationId: string) {
  const [row] = await db
    .select({ parent: installedExtension })
    .from(installedExtensionComponent)
    .innerJoin(
      installedExtension,
      eq(installedExtension.id, installedExtensionComponent.extensionId),
    )
    .where(
      and(
        eq(installedExtensionComponent.kind, "integration"),
        eq(installedExtensionComponent.componentId, integrationId),
      ),
    )
    .limit(1);
  const [integration] = await db
    .select()
    .from(installedIntegration)
    .where(eq(installedIntegration.id, integrationId))
    .limit(1);
  if (row && row.parent.installationKind !== "standalone")
    throw new AdminJobFailure("Integration belongs to a catalog extension", { integrationId });
  if (integration?.managedByExtension && integration.managedByExtension !== row?.parent.id)
    throw new JobObservationPending("recovery_required");
  return row?.parent.id ?? null;
}
async function bookkeeping(
  ctx: JobContext,
  state: State,
  write: boolean,
): Promise<"committed" | "absent"> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${"standalone-bookkeeping:" + state.inspection.integrationId},0))`,
    );
    const [parent] = await tx
      .select()
      .from(installedExtension)
      .where(eq(installedExtension.id, state.parentId))
      .for("update");
    const [integration] = await tx
      .select()
      .from(installedIntegration)
      .where(eq(installedIntegration.id, state.inspection.integrationId))
      .for("update");
    const [component] = await tx
      .select()
      .from(installedExtensionComponent)
      .where(
        and(
          eq(installedExtensionComponent.kind, "integration"),
          eq(installedExtensionComponent.componentId, state.inspection.integrationId),
        ),
      )
      .for("update");
    const source = provenance(state);
    if (parent?.lastOperationId === state.operationId) {
      if (
        parent.installationKind !== "standalone" ||
        parent.sourceTrust !== "community" ||
        canonicalJson(parent.provenance) !== canonicalJson(source) ||
        integration?.managedByExtension !== state.parentId ||
        component?.extensionId !== state.parentId ||
        integration.installedVersion !== state.inspection.version
      )
        throw new JobObservationPending("recovery_required");
      return "committed";
    }
    if (!write) return "absent";
    if (component && component.extensionId !== state.parentId)
      throw new AdminJobFailure("Integration ownership changed during installation", {
        operationId: state.operationId,
      });
    if (parent && parent.installationKind !== "standalone")
      throw new AdminJobFailure("Catalog extensions cannot be replaced by a standalone install", {
        operationId: state.operationId,
      });
    const now = new Date(),
      repository = "url" in source ? source.url : null;
    await tx
      .insert(installedExtension)
      .values({
        id: state.parentId,
        name: state.inspection.integrationId,
        sourceUrl: repository,
        sourceTrust: "community",
        installationKind: "standalone",
        provenance: source,
        lastOperationId: state.operationId,
        installedVersion: state.inspection.version,
        manifest: null,
        installedBy: dbActorId(state.ownerId),
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: installedExtension.id,
        set: {
          sourceUrl: repository,
          sourceTrust: "community",
          installationKind: "standalone",
          provenance: source,
          lastOperationId: state.operationId,
          installedVersion: state.inspection.version,
          updatedAt: now,
        },
      });
    await tx
      .insert(installedIntegration)
      .values({
        id: state.inspection.integrationId,
        repository,
        sourceType: source.kind,
        installedVersion: state.inspection.version,
        installedBy: dbActorId(state.ownerId),
        managedByExtension: state.parentId,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: installedIntegration.id,
        set: {
          repository,
          sourceType: source.kind,
          installedVersion: state.inspection.version,
          managedByExtension: state.parentId,
          updatedAt: now,
        },
      });
    if (!component)
      await tx.insert(installedExtensionComponent).values({
        extensionId: state.parentId,
        kind: "integration",
        componentId: state.inspection.integrationId,
      });
    return "committed";
  });
}
export async function handleStandalonePreview(ctx: JobContext): Promise<Record<string, unknown>> {
  const { ownerId, body } = await authenticatePayload(ctx),
    input = standalonePreviewRequestSchema.parse(body);
  return executeAdminJobOperation(
    ctx,
    { kind: "integration.inspectInstall", source: input.source, ownerId },
    "standalone.preview",
  );
}
export function handleStandaloneInstall(ctx: JobContext): Promise<Record<string, unknown>> {
  return withExtensionChangeLock(async () => {
    const payload = await authenticatePayload(ctx),
      request = standaloneInstallRequestSchema.parse(payload.body);
    let state = await restore(ctx);
    if (!state) {
      if (ctx.observationOnly) throw new JobObservationPending("recovery_required");
      ctx.signal.throwIfAborted();
      const preview = await previewForInstall(ctx, payload.ownerId, request.inspectionId);
      if (
        preview.inspection.contentDigest !== request.expectedContentDigest ||
        Date.parse(preview.inspection.expiresAt) <= Date.now()
      )
        throw new AdminJobFailure("Preview expired or changed; inspect the source again", {
          operationId: payload.operationId,
        });
      state = {
        version: 1,
        jobId: ctx.jobId,
        operationId: payload.operationId,
        ownerId: payload.ownerId,
        request,
        ...preview,
        parentId:
          (await ownership(preview.inspection.integrationId)) ?? `local-${payload.operationId}`,
        phase: "prepared",
        outcome: null,
      };
      await save(ctx, state);
    }
    if (state.phase === "complete")
      return {
        operationId: state.operationId,
        integrationId: state.inspection.integrationId,
        outcome: state.outcome,
      };
    if (
      state.phase === "prepared" &&
      (await cancellationRequested(ctx)) &&
      !Object.values(readProjection(ctx.checkpointResult).operations).some(
        (operation) => operation.kind === "integration.install",
      )
    ) {
      state.phase = "complete";
      state.outcome = "restored";
      await save(ctx, state);
      throw new AdminJobFailure("Standalone installation canceled before publication", {
        operationId: state.operationId,
        outcome: "not_started",
      });
    }
    const install = {
      kind: "integration.install" as const,
      inspectionId: state.request.inspectionId,
      expectedContentDigest: state.request.expectedContentDigest,
      operationId: state.operationId,
      ownerId: state.ownerId,
    };
    // The retained operation helper adopts exact attempted addresses; it never replays an uncertain POST.
    await executeAdminJobOperation(ctx, install, "standalone.publish");
    if (state.phase === "prepared") {
      state.phase = "published";
      await save(ctx, state);
    }
    if (state.phase === "published") {
      if (await cancellationRequested(ctx)) {
        state.phase = "restore";
        await save(ctx, state);
      } else {
        state.phase = "reload_attempted";
        await save(ctx, state);
        try {
          await reloadIntegrations();
        } catch {
          state.phase = "restore";
          await save(ctx, state);
        }
        if (state.phase === "reload_attempted") {
          state.phase = "reloaded";
          await save(ctx, state);
        }
      }
    }
    if (state.phase === "reload_attempted") throw new JobObservationPending("recovery_required");
    if (state.phase === "reloaded") {
      if (await cancellationRequested(ctx)) {
        state.phase = "restore";
        await save(ctx, state);
      } else {
        state.phase = "persist_attempted";
        await save(ctx, state);
      }
    }
    if (state.phase === "persist_attempted") {
      try {
        const outcome = await bookkeeping(ctx, state, !(await cancellationRequested(ctx)));
        state.phase = outcome === "committed" ? "persisted" : "restore";
        await save(ctx, state);
      } catch {
        // Serialize behind the original SQL transaction before interpreting its
        // acknowledgement loss. A missing row while that transaction is live is
        // never rollback evidence.
        try {
          state.phase =
            (await bookkeeping(ctx, state, false)) === "committed" ? "persisted" : "restore";
          await save(ctx, state);
        } catch {
          throw new JobObservationPending("recovery_required");
        }
      }
    }
    const decision = state.phase === "persisted" ? "commit" : "restore";
    if (decision === "commit" && (await bookkeeping(ctx, state, false)) !== "committed")
      throw new JobObservationPending("recovery_required");
    const settled = await executeAdminJobOperation(
      ctx,
      {
        kind: "integration.settle",
        transactionId: state.operationId,
        decision,
        expectedContentDigest: state.inspection.contentDigest,
      },
      `standalone.${decision}`,
    );
    if (decision === "restore") {
      try {
        await reloadIntegrations();
      } catch {
        throw new JobObservationPending("recovery_required");
      }
    }
    state.phase = "complete";
    state.outcome = settled.outcome;
    await save(ctx, state);
    const result = {
      operationId: state.operationId,
      integrationId: state.inspection.integrationId,
      outcome: state.outcome,
    };
    if (state.outcome === "restored")
      throw new AdminJobFailure(
        "Standalone integration was restored; installation did not commit",
        result,
      );
    return result;
  });
}
