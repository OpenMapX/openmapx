import { randomUUID } from "node:crypto";
import {
  canonicalJson,
  type stageInspectionBindingSchema,
  standaloneInstallInspectionSchema,
} from "@openmapx/core/ops";
import {
  createIntegrationArtifactPreparation,
  describeIntegrationPublication,
  describePreparedIntegration,
  discardIntegrationPreparation,
  inspectInstalledIntegrationFingerprint,
  inspectIntegrationPublication,
  prepareIntegrationSource,
  prepareRemoteIntegrationArtifact,
  publishPreparedIntegration,
  restoreIntegrationPublication,
  restorePreparedIntegration,
  settleIntegrationPublication,
} from "@openmapx/integration-framework/installer";
import type z from "zod/v4";
import type { ArtifactTransferStore } from "./artifact-transfer/store";
import type { OpsRuntime } from "./runtime";
import {
  standaloneInspectionRecordSchema as inspectionRecordSchema,
  standaloneTransactionRecordSchema as transactionRecordSchema,
} from "./standalone-integration-records";
import { installStandaloneOwnershipRuntime } from "./standalone-ownership-runtime";

function missing(error: unknown) {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}
export function installStandaloneIntegrationRuntime(
  runtime: OpsRuntime,
  options: { rootDir: string; store?: ArtifactTransferStore; now?: () => number },
): void {
  const now = options.now ?? Date.now;
  const store = () => {
    if (!options.store) throw Error("Standalone integration purpose storage is unavailable");
    return options.store;
  };
  runtime["integration.inspectInstall"] = async (operation, context) => {
    const installationId = store().standaloneInstallationId(context),
      preparationContext = createIntegrationArtifactPreparation({ rootDir: options.rootDir });
    let published = false;
    try {
      let commit: string | null = null,
        stage: z.infer<typeof stageInspectionBindingSchema> | null = null;
      let prepared: Awaited<ReturnType<typeof prepareRemoteIntegrationArtifact>>;
      if (operation.source.kind === "source") {
        const result = await prepareIntegrationSource(
          {
            repository: operation.source.repository,
            ref: operation.source.ref,
            signal: context.signal,
          },
          preparationContext,
        );
        prepared = result.prepared;
        commit = result.commit;
      } else if (operation.source.kind === "artifact") {
        prepared = await prepareRemoteIntegrationArtifact(
          { url: operation.source.url, sha256: operation.source.sha256, signal: context.signal },
          preparationContext,
        );
      } else {
        if (!options.store) throw Error("Integration artifact transfer is unavailable");
        const result = await options.store.validateIntegrationArtifact(context, preparationContext);
        prepared = result.prepared;
        stage = result.inspection;
      }
      const inspection = standaloneInstallInspectionSchema.parse({
        inspectionId: stage?.inspectionId ?? randomUUID(),
        sourceKind: operation.source.kind,
        integrationId: prepared.id,
        version: prepared.version,
        contentDigest: prepared.contentDigest,
        commit,
        stageId: stage?.stageId ?? null,
        archiveSha256: prepared.archiveSha256,
        expiresAt: stage?.expiresAt ?? new Date(now() + 600000).toISOString(),
        denials: [],
      });
      const record = inspectionRecordSchema.parse({
        version: 1,
        installationId,
        ownerId: operation.ownerId,
        source: operation.source,
        inspection,
        preparation: describePreparedIntegration(prepared),
        previous: inspectInstalledIntegrationFingerprint({
          rootDir: options.rootDir,
          id: prepared.id,
          signal: context.signal,
        }),
        stage,
      });
      store().retainStandaloneInspection(context, record);
      published = true;
      return inspection;
    } finally {
      if (!published) discardIntegrationPreparation(preparationContext);
    }
  };
  runtime["integration.install"] = async (operation, context) => {
    const installationId = store().standaloneInstallationId(context);
    const inspection = store().readStandaloneInspection(context, operation.inspectionId);
    if (
      inspection.ownerId !== operation.ownerId ||
      inspection.inspection.contentDigest !== operation.expectedContentDigest
    )
      throw Error("Standalone inspection owner or content changed");
    const journal = store().standalonePublicationJournal(context);
    let existing: z.infer<typeof transactionRecordSchema> | null = null;
    try {
      existing = store().readStandaloneTransaction(context, operation.operationId);
    } catch (error) {
      if (!missing(error)) throw error;
    }
    if (existing) {
      if (
        existing.ownerId !== operation.ownerId ||
        existing.inspection.inspection.inspectionId !== operation.inspectionId ||
        canonicalJson(existing.installExecution) !== canonicalJson(context.execution)
      )
        throw Error("Standalone transaction replay mismatch");
      const publication = inspectIntegrationPublication({
        rootDir: options.rootDir,
        preparation: existing.inspection.preparation,
        transactionId: existing.transactionId,
        journal,
      });
      if (publication.outcome !== "published")
        throw Error("Standalone installation requires original transaction reconciliation");
      await restoreIntegrationPublication({
        rootDir: options.rootDir,
        receipt: publication,
        signal: context.signal,
        journal,
      });
      return {
        transactionId: existing.transactionId,
        integrationId: publication.integrationId,
        previousContentDigest: publication.previousContentDigest,
        contentDigest: publication.preparation.contentDigest,
        outcome: "published",
      };
    }
    context.signal.throwIfAborted();
    if (Date.parse(inspection.inspection.expiresAt) <= now())
      throw Error("Standalone inspection expired; preview again");
    const prepared = await restorePreparedIntegration({
      rootDir: options.rootDir,
      receipt: inspection.preparation,
      signal: context.signal,
    });
    const claim = inspection.stage
      ? await options.store?.claimIntegrationArtifactInstall(context, inspection.stage)
      : null;
    if (inspection.stage && !claim) throw Error("Integration artifact claim is unavailable");
    const record = transactionRecordSchema.parse({
      version: 1,
      installationId,
      transactionId: operation.operationId,
      ownerId: operation.ownerId,
      installExecution: context.execution,
      inspection,
      claim: claim ?? null,
      publication: null,
    });
    store().retainStandaloneTransaction(context, record);
    const publication = await publishPreparedIntegration(prepared, {
      transactionId: operation.operationId,
      expectedPreviousContentDigest: inspection.previous?.contentDigest ?? null,
      expectedPreviousIdentity: inspection.previous?.identity ?? null,
      journal,
      signal: context.signal,
    });
    record.publication = describeIntegrationPublication(publication);
    store().retainStandaloneTransaction(context, record, publication);
    return {
      transactionId: record.transactionId,
      integrationId: prepared.id,
      previousContentDigest: record.publication.previousContentDigest,
      contentDigest: prepared.contentDigest,
      outcome: "published",
    };
  };
  runtime["integration.settle"] = async (operation, context) => {
    store().standaloneInstallationId(context);
    const record = store().readStandaloneTransaction(context, operation.transactionId);
    const journal = store().standalonePublicationJournal(context);
    if (record.inspection.inspection.contentDigest !== operation.expectedContentDigest)
      throw Error("Standalone settlement content mismatch");
    const publicationReceipt = inspectIntegrationPublication({
      rootDir: options.rootDir,
      preparation: record.inspection.preparation,
      transactionId: record.transactionId,
      journal,
    });
    const publication = await restoreIntegrationPublication({
      rootDir: options.rootDir,
      receipt: publicationReceipt,
      signal: context.signal,
      journal,
    });
    const result = await settleIntegrationPublication(
      publication,
      operation.decision,
      context.signal,
    );
    if (record.claim) {
      if (!options.store) throw Error("Integration artifact settlement is unavailable");
      await options.store.settleIntegrationArtifact(context, record.claim, publication);
    }
    record.publication = describeIntegrationPublication(publication);
    store().retainStandaloneTransaction(context, record, publication);
    return { transactionId: record.transactionId, ...result };
  };
  if (options.store)
    installStandaloneOwnershipRuntime(runtime, { ...options, store: options.store });
}
