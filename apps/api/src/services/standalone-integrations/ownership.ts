import { randomUUID } from "node:crypto";
import { canonicalJson } from "@openmapx/core/ops";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db";
import {
  adminJob,
  installedExtension,
  installedExtensionComponent,
  installedIntegration,
} from "../../db/schema";
import { getIntegration, reloadIntegrations } from "../../integration-host";
import { dbActorId } from "../../utils/actor";
import { AdminJobFailure, JobObservationPending } from "../admin-job-failure";
import { executeAdminJobOperation } from "../admin-job-ops";
import { jobOwnership } from "../admin-job-state";
import { withExtensionChangeLock } from "../extension-recovery";
import type { JobContext } from "../job-runner";
import { createApiOpsClient, createDurableOpsKey, executeAndWait } from "../ops-client";
import { mergeStandaloneInventory } from "./inventory";
import { lockOwnership, ownershipSnapshot } from "./ownership-database";
import {
  authenticateOwnershipRequest,
  type OwnershipState,
  readOwnershipState,
  sealOwnershipState,
} from "./ownership-state";

type Connection = Parameters<Parameters<typeof db.transaction>[0]>[0];
export async function standaloneInventory() {
  const [files, integrations, parents, components] = await Promise.all([
    executeAndWait(
      createApiOpsClient(),
      { kind: "integration.inventory" },
      createDurableOpsKey("standalone.inventory", randomUUID()),
    ),
    db.select().from(installedIntegration),
    db.select().from(installedExtension),
    db.select().from(installedExtensionComponent),
  ]);
  return {
    entries: mergeStandaloneInventory({ files: files.entries, integrations, parents, components }),
  };
}
function permission(
  before: Awaited<ReturnType<typeof ownershipSnapshot>>,
  action: "adopt" | "remove",
) {
  const { integration, components, parent } = before,
    owner = components[0]?.extensionId ?? integration?.managedByExtension ?? null;
  if (
    (owner &&
      (!integration || components.length !== 1 || integration.managedByExtension !== owner)) ||
    components.length > 1 ||
    (integration?.managedByExtension && integration.managedByExtension !== owner) ||
    (owner && (!parent || parent.installationKind !== "standalone"))
  )
    throw new AdminJobFailure(
      "Integration has a conflicting or catalog owner; use that owner's controls",
      {},
    );
  if (action === "adopt" && owner) throw new AdminJobFailure("Integration is already managed", {});
  return owner;
}
async function save(ctx: JobContext, state: OwnershipState) {
  await ctx.checkpoint({
    ...ctx.checkpointResult,
    _standalone: await sealOwnershipState(state),
    _standaloneSettled: state.phase === "complete",
  });
}
async function readState(
  ctx: JobContext,
  payload: Awaited<ReturnType<typeof authenticateOwnershipRequest>>,
) {
  if (!ctx.checkpointResult?._standalone) return null;
  const state = await readOwnershipState(ctx.checkpointResult._standalone);
  if (
    state.jobId !== ctx.jobId ||
    state.operationId !== payload.operationId ||
    state.ownerId !== payload.ownerId ||
    canonicalJson(state.request) !== canonicalJson(payload.request) ||
    state.action !== (ctx.jobType === "standalone.adopt" ? "adopt" : "remove")
  )
    throw new JobObservationPending("recovery_required");
  return state;
}
async function canceled(ctx: JobContext) {
  const [row] = await db
    .select({ status: adminJob.status })
    .from(adminJob)
    .where(eq(adminJob.id, ctx.jobId));
  if (!row) throw new JobObservationPending("recovery_required");
  return row.status === "cancel_pending" || row.status === "canceled";
}
/** Desired ownership and its authenticated completion checkpoint commit in the SAME transaction.
 * A lost COMMIT response is resolved under the original advisory and owned-job locks. */
async function persist(ctx: JobContext, state: OwnershipState, write: boolean): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [job] = await tx
      .select()
      .from(adminJob)
      .where(jobOwnership(ctx.jobId, ctx.execution, ["running", "cancel_pending"]))
      .for("update");
    if (!job) throw new JobObservationPending("recovery_required");
    await lockOwnership(tx, state.request.integrationId);
    const value = job.result as Record<string, unknown>,
      retained = await readOwnershipState(value._standalone);
    if (
      retained.operationId !== state.operationId ||
      retained.jobId !== ctx.jobId ||
      canonicalJson(retained.request) !== canonicalJson(state.request)
    )
      throw new JobObservationPending("recovery_required");
    if (
      retained.phase === "persisted" ||
      (retained.phase === "complete" && retained.outcome === "committed")
    ) {
      state.phase = retained.phase;
      state.outcome = retained.outcome;
      ctx.checkpointResult = value;
      return true;
    }
    const current = await ownershipSnapshot(tx, state.request.integrationId);
    if (canonicalJson(current) !== state.before)
      throw new JobObservationPending("recovery_required");
    if (!write) return false;
    permission(current, state.action);
    if (!state.inspection?.allowed) throw new JobObservationPending("recovery_required");
    const id = state.request.integrationId;
    if (state.action === "adopt") {
      const contentDigest = state.request.expectedContentDigest,
        version = state.inspection.version;
      if (!contentDigest || !version) throw new JobObservationPending("recovery_required");
      const parentId = state.parentId;
      if (!parentId) throw new JobObservationPending("recovery_required");
      await tx.insert(installedExtension).values({
        id: parentId,
        name: id,
        sourceUrl: null,
        sourceTrust: "community",
        installationKind: "standalone",
        provenance: { kind: "legacy_unknown", contentDigest },
        lastOperationId: state.operationId,
        installedVersion: version,
        manifest: null,
        installedBy: dbActorId(state.ownerId),
      });
      await tx
        .insert(installedIntegration)
        .values({
          id,
          repository: null,
          sourceType: "legacy_unknown",
          installedVersion: version,
          managedByExtension: parentId,
          installedBy: dbActorId(state.ownerId),
        })
        .onConflictDoUpdate({
          target: installedIntegration.id,
          set: {
            managedByExtension: parentId,
            repository: null,
            sourceType: "legacy_unknown",
            installedVersion: version,
            updatedAt: new Date(),
          },
        });
      await tx
        .insert(installedExtensionComponent)
        .values({ extensionId: parentId, kind: "integration", componentId: id });
    } else {
      if (state.parentId) {
        const owned = await tx
          .select()
          .from(installedExtensionComponent)
          .where(eq(installedExtensionComponent.extensionId, state.parentId))
          .for("update");
        if (owned.length !== 1 || owned[0]?.componentId !== id || owned[0].kind !== "integration")
          throw new AdminJobFailure(
            "Installation contains other components; use its extension controls",
            {},
          );
        await tx
          .delete(installedExtensionComponent)
          .where(
            and(
              eq(installedExtensionComponent.extensionId, state.parentId),
              eq(installedExtensionComponent.kind, "integration"),
              eq(installedExtensionComponent.componentId, id),
            ),
          );
      }
      await tx.delete(installedIntegration).where(eq(installedIntegration.id, id));
      if (state.parentId)
        await tx.delete(installedExtension).where(eq(installedExtension.id, state.parentId));
    }
    const committed = { ...state, phase: "persisted" as const };
    const result = {
      ...value,
      _standalone: await sealOwnershipState(committed),
      _standaloneSettled: false,
    };
    const updated = await tx
      .update(adminJob)
      .set({ result })
      .where(jobOwnership(ctx.jobId, ctx.execution, ["running", "cancel_pending"]))
      .returning({ id: adminJob.id });
    if (updated.length !== 1) throw new JobObservationPending("recovery_required");
    // Updating this local view is safe only after the transaction resolves. The
    // caller performs an authenticated read after ambiguous COMMIT instead.
    return true;
  });
}
async function observedCommit(ctx: JobContext, state: OwnershipState) {
  const committed = await persist(ctx, state, false);
  if (committed) {
    state.phase = "persisted";
    await save(ctx, state);
  }
  return committed;
}
export function handleStandaloneOwnership(ctx: JobContext): Promise<Record<string, unknown>> {
  return withExtensionChangeLock(async () => {
    const payload = await authenticateOwnershipRequest(ctx.jobType ?? "", ctx.payload);
    let state = await readState(ctx, payload);
    if (!state) {
      if (ctx.observationOnly) throw new JobObservationPending("recovery_required");
      ctx.signal.throwIfAborted();
      const action = ctx.jobType === "standalone.adopt" ? "adopt" : "remove";
      if (action === "adopt" && !payload.request.expectedContentDigest)
        throw new AdminJobFailure("Missing integrations cannot be adopted", {});
      const before = await db.transaction(async (tx) => {
        await lockOwnership(tx, payload.request.integrationId);
        const value = await ownershipSnapshot(tx, payload.request.integrationId);
        permission(value, action);
        return value;
      });
      state = {
        version: 1,
        kind: "ownership",
        jobId: ctx.jobId,
        operationId: payload.operationId,
        ownerId: payload.ownerId,
        action,
        request: payload.request,
        parentId: action === "adopt" ? `local-${payload.operationId}` : (before.parent?.id ?? null),
        before: canonicalJson(before),
        inspection: null,
        phase: "prepared",
        outcome: null,
      };
      await save(ctx, state);
    }
    if (state.phase === "prepared") {
      const inspection = await executeAdminJobOperation(
        ctx,
        {
          kind: "integration.inspectOwnership",
          integrationId: state.request.integrationId,
          expectedContentDigest: state.request.expectedContentDigest,
          ownerId: state.ownerId,
          operationId: state.operationId,
        },
        "standalone.ownership.inspect",
      );
      if (!inspection.allowed) {
        state.phase = "complete";
        state.outcome = "restored";
        await save(ctx, state);
        throw new AdminJobFailure(inspection.reason, {
          integrationId: state.request.integrationId,
        });
      }
      state.inspection = inspection;
      state.phase = "inspected";
      await save(ctx, state);
    }
    if (
      ["inspected", "removed", "reloaded"].includes(state.phase) &&
      state.inspection?.allowed &&
      Date.parse(state.inspection.expiresAt) <= Date.now()
    ) {
      state.phase = "restore";
      await save(ctx, state);
    }
    if (state.phase === "inspected" && (await canceled(ctx))) {
      state.phase = "restore";
      await save(ctx, state);
    }
    if (state.phase === "inspected") {
      if (state.action === "remove")
        await executeAdminJobOperation(
          ctx,
          {
            kind: "integration.remove",
            transactionId: state.operationId,
            expectedContentDigest: state.request.expectedContentDigest,
          },
          "standalone.ownership.remove",
        );
      state.phase = "removed";
      await save(ctx, state);
    }
    if (state.phase === "removed") {
      if (await canceled(ctx)) {
        state.phase = "restore";
        await save(ctx, state);
      } else {
        state.phase = "reload_attempted";
        await save(ctx, state);
        await reloadIntegrations();
        if (
          (state.action === "remove" && getIntegration(state.request.integrationId)) ||
          (state.action === "adopt" &&
            getIntegration(state.request.integrationId)?.manifest.version !==
              (state.inspection?.allowed ? state.inspection.version : null))
        )
          throw new JobObservationPending("recovery_required");
        state.phase = "reloaded";
        await save(ctx, state);
      }
    }
    if (state.phase === "reload_attempted") throw new JobObservationPending("recovery_required");
    if (state.phase === "reloaded") {
      state.phase = (await canceled(ctx)) ? "restore" : "persist_attempted";
      await save(ctx, state);
      if (state.phase === "persist_attempted") {
        try {
          await persist(ctx, state, true);
          state.phase = "persisted";
        } catch (error) {
          if (!(await observedCommit(ctx, state))) {
            state.phase = "restore";
          }
        }
        await save(ctx, state);
      }
    }
    if (state.phase === "persist_attempted") {
      if (await observedCommit(ctx, state)) state.phase = "persisted";
      else {
        state.phase = "restore";
        await save(ctx, state);
      }
    }
    if (state.phase === "restore") {
      await executeAdminJobOperation(
        ctx,
        {
          kind: "integration.settle",
          transactionId: state.operationId,
          decision: "restore",
          expectedContentDigest: state.request.expectedContentDigest,
        },
        "standalone.ownership.restore",
      );
      // Reload ambiguity remains held in Activity; never infer rollback completion.
      await reloadIntegrations();
      state.phase = "complete";
      state.outcome = "restored";
      await save(ctx, state);
    }
    if (state.phase === "persisted") {
      await executeAdminJobOperation(
        ctx,
        {
          kind: "integration.settle",
          transactionId: state.operationId,
          decision: "commit",
          expectedContentDigest: state.request.expectedContentDigest,
        },
        "standalone.ownership.commit",
      );
      state.phase = "complete";
      state.outcome = "committed";
      await save(ctx, state);
    }
    if (state.outcome !== "committed")
      throw new AdminJobFailure("Installation ownership change was restored", {
        integrationId: state.request.integrationId,
        outcome: "restored",
      });
    return {
      operationId: state.operationId,
      integrationId: state.request.integrationId,
      action: state.action,
      outcome: "committed",
    };
  });
}
