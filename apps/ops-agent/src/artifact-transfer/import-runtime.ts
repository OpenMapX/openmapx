/** Fixed prepared-artifact consumer. Filesystem paths and Docker acquisition stay agent-local. */
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  AnchoredDirectory,
  buildArtifactSpec,
  controlDigest,
  executeOwnedGenerationHardlinks,
  executionAuthorityState,
  type GenerationHardlinksOwnerPlan,
  lookupControlChildPhaseBinding,
  planGenerationHardlinksOwner,
  readGenerationHardlinksOwnerPlan,
  readOwnedGenerationHardlinkPlan,
  readPrivateRecord,
  signControl,
  type VerifiedExecutionAuthority,
  verifyControl,
  writePrivateRecord,
} from "@openmapx/core/build-artifacts";
import {
  artifactPublicationFingerprint,
  inspectArtifactPublication,
  publishValidatedBuild,
} from "@openmapx/core/build-artifacts/publication";
import {
  type ArtifactImportPreview,
  artifactImportPreviewSchema,
  type ExecutionRef,
  type OpsOperation,
} from "@openmapx/core/ops";
import { services } from "@openmapx/core/server";
import { z } from "zod";
import {
  assertConfigurationCoordinatorReady,
  configurationDataManagerTransport,
} from "../configuration-hardlinks-runtime";
import { type DockerRuntimeOptions, runContainedProcess } from "../docker-runtime";
import type { OwnedServiceResolver } from "../owned-services";
import { type OpsExecutionContext, OpsExecutionFailure, type OpsRuntime } from "../runtime";
import type { TrustedConfigurationAuthoritySnapshot } from "../trusted-config-runtime";
import type { ArtifactTransferStore } from "./store";

type ImportOperation = Extract<OpsOperation, { kind: "artifactTransfer.import" }>;
interface Source {
  rootDir: string;
  infraDir: string;
  stack: services.StackPaths;
  ownedServices: OwnedServiceResolver;
  loadAuthority(): Promise<TrustedConfigurationAuthoritySnapshot>;
  execFile: NonNullable<DockerRuntimeOptions["execFile"]>;
  store: ArtifactTransferStore;
}
const sources = new WeakMap<OpsRuntime, Source>();
const planSchema = z.strictObject({
  version: z.literal(1),
  preview: artifactImportPreviewSchema,
  targetFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  preparationId: z.uuid(),
});
type ImportPlan = z.infer<typeof planSchema>;
const domain = "openmapx-artifact-import-owner-v1";
const name = (a: VerifiedExecutionAuthority) => `artifact-import-${a.execution.operationKey}.json`;
const configSchema = z.object({
  services: z.record(z.string(), z.object({ image: z.string().min(1).max(4096).optional() })),
});
async function snapshot(
  source: Source,
  input: { stageId: string; ownerId: string },
  signal: AbortSignal,
) {
  return source.store.withPreparedArtifact(input, async (prepared) => {
    signal.throwIfAborted();
    const authority = await source.loadAuthority(),
      revisionId = services.currentConfigurationGeneration(source.infraDir),
      spec = buildArtifactSpec(prepared.bundle.manifest.service),
      ids = [prepared.bundle.manifest.service, ...spec.consumers];
    const installed = authority.services.find(
      (s) => s.manifest.id === prepared.bundle.manifest.service && s.isBuiltIn,
    );
    if (!installed) throw Error("Prepared target is not an installed built-in service");
    const args = services.stackComposeArgs(source.stack, existsSync);
    const parsed = configSchema.parse(
      JSON.parse(
        (
          await source.execFile("docker", [...args, "config", "--format", "json"], {
            signal,
            timeout: 30000,
            maxBuffer: 1024 * 1024,
          })
        ).stdout,
      ),
    );
    if (Object.keys(parsed.services).length > 256)
      throw Error("Compose inventory exceeds its budget");
    if (!source.ownedServices.inspectInventory)
      throw Error("Owned container inventory unavailable");
    const inventory = await source.ownedServices.inspectInventory(signal);
    const runningConsumers = inventory.services
      .filter((s) => ids.includes(s.serviceId) && !["stopped", "created"].includes(s.state))
      .map((s) => s.serviceId)
      .sort();
    const runtimeImageMismatches = Object.entries(prepared.bundle.manifest.runtimeImages).flatMap(
      ([service, bundle]) => {
        const local = parsed.services[service]?.image ?? "(not configured)";
        return local === bundle ? [] : [{ service, bundle, local }];
      },
    );
    const blockers: string[] = [];
    if (!revisionId)
      blockers.push("Generate the current configuration before importing prepared data.");
    if (runningConsumers.length)
      blockers.push(
        "Stop the listed consumers before importing; import never stops or starts them.",
      );
    if (inventory.unverifiedServiceIds.some((id) => ids.includes(id)))
      blockers.push(
        "A target container has unverifiable provenance; reconcile it before importing.",
      );
    if (runtimeImageMismatches.length)
      blockers.push("Bundle runtime images differ from the current Compose configuration.");
    if (prepared.bundle.manifest.files.length + prepared.bundle.manifest.directories.length > 10000)
      blockers.push("Prepared publication supports at most 10,000 entries per bundle.");
    if (prepared.bundle.manifest.service === "motis")
      blockers.push("Target MOTIS credential materialization must complete before publication.");
    const targetFingerprint =
      prepared.bundle.manifest.service === "motis"
        ? controlDigest({ blocked: "motis-target-materialization" }) // Denial-only preview; it cannot admit an import.
        : await artifactPublicationFingerprint(
            join(source.infraDir, "data"),
            prepared.bundle.manifest.service,
          );
    const hardlinks = revisionId
      ? readOwnedGenerationHardlinkPlan(source.infraDir, revisionId)
      : null;
    if (hardlinks?.plan.length)
      try {
        await assertConfigurationCoordinatorReady(signal);
      } catch {
        blockers.push(
          "Start the data manager using its guarded controls before importing this nonempty hardlink plan.",
        );
      }
    const state = {
      stageSha256: prepared.stage.sha256,
      manifestSha256: prepared.bundle.manifestSha256,
      preparationId: prepared.preparationId,
      revisionId,
      authorityRevision: authority.revisionId,
      images: parsed.services,
      consumers: inventory.services.filter((s) => ids.includes(s.serviceId)),
      unverified: inventory.unverifiedServiceIds.filter((id) => ids.includes(id)),
      targetFingerprint,
      hardlinkDigest: hardlinks ? controlDigest(hardlinks) : null,
    };
    const preview = artifactImportPreviewSchema.parse({
      stageId: input.stageId,
      sha256: prepared.stage.sha256,
      serviceId: prepared.bundle.manifest.service,
      region: prepared.bundle.manifest.region ?? null,
      bytes: prepared.stage.bytes,
      requiredFreeBytes: 0,
      requiredCredentials:
        prepared.bundle.manifest.schemaVersion === 2
          ? (prepared.bundle.manifest.credentialRequirements ?? [])
          : [],
      runtimeImageMismatches,
      runningConsumers,
      blockers,
      fingerprint: controlDigest(state),
      currentRevisionId: revisionId,
      expiresAt: new Date(
        Math.min(Date.now() + 600000, Date.parse(prepared.stage.expiresAt)),
      ).toISOString(),
    });
    return { preview, targetFingerprint, preparationId: prepared.preparationId };
  });
}
/** Fixed source invoked by the actual server before signing the original root. */
export async function prepareArtifactImportAdmission(
  runtime: OpsRuntime,
  parent: ExecutionRef,
  operation: ImportOperation,
  targets: readonly string[],
): Promise<{ plan: ImportPlan; hardlinks: GenerationHardlinksOwnerPlan }> {
  const source = sources.get(runtime);
  if (!source) throw Error("Prepared import runtime unavailable");
  const retained = source.store.readImportPreview(operation),
    current = await snapshot(source, operation, AbortSignal.timeout(120000));
  if (
    current.preview.blockers.length ||
    current.preview.fingerprint !== retained.preview.fingerprint ||
    current.preview.currentRevisionId !== operation.expectedCurrentRevisionId ||
    !operation.expectedCurrentRevisionId
  )
    throw new OpsExecutionFailure("conflict", {});
  const plan = planSchema.parse({ version: 1, ...current });
  if (Buffer.byteLength(JSON.stringify(plan)) > 7 * 1024)
    throw new OpsExecutionFailure("validation", {});
  return {
    plan,
    hardlinks: planGenerationHardlinksOwner({
      infraDir: source.infraDir,
      parent,
      revisionId: operation.expectedCurrentRevisionId,
      coordinatorMode: "require-running",
      serviceIds: targets,
    }),
  };
}
export function retainArtifactImportPlan(authority: VerifiedExecutionAuthority, plan: ImportPlan) {
  const owner = executionAuthorityState(authority);
  if (owner.kind !== "artifactTransfer.import" || !owner.origin)
    throw Error("Original import root required");
  writePrivateRecord(
    owner.installation,
    "observations",
    name(authority),
    signControl(owner.installation.privateKey, domain, planSchema.parse(plan)),
    true,
    owner.origin,
  );
}
export function installPreparedImportRuntime(
  runtime: OpsRuntime,
  store: ArtifactTransferStore,
  options: Omit<Source, "store" | "execFile"> & { execFile?: Source["execFile"] },
) {
  const source: Source = { ...options, store, execFile: options.execFile ?? runContainedProcess };
  sources.set(runtime, source);
  runtime["artifactTransfer.previewImport"] = async (operation, context) => {
    const result = await snapshot(source, operation, context.signal);
    return store.saveImportPreview({ ...operation, ...result });
  };
  runtime["artifactTransfer.import"] = async (operation, context) => {
    const authority = context.controlAuthority,
      lease = context.ownedTargetLease;
    if (!authority || !lease) throw Error("Original import authority required");
    const owner = executionAuthorityState(authority),
      plan = verifyControl(
        owner.installation.installation.publicKey,
        domain,
        readPrivateRecord(owner.installation, "observations", name(authority), 8192),
        planSchema,
      );
    if (
      plan.preview.fingerprint !== operation.previewFingerprint ||
      plan.preview.sha256 !== operation.expectedSha256
    )
      throw Error("Retained import intent differs");
    const published = inspectArtifactPublication(authority);
    if (!published) {
      const current = await snapshot(source, operation, context.signal);
      if (
        current.preview.fingerprint !== plan.preview.fingerprint ||
        current.preview.blockers.length
      )
        return {
          outcome: "not_committed" as const,
          reason: "conflict" as const,
          cleanupFailed: false,
        };
    }

    const claim = await store.claimStage(
      {
        ...operation,
        purpose: "prepared-artifact",
        use: "import-build",
        identity: {
          executionId: context.execution.executionId,
          operationKey: context.execution.operationKey,
          fingerprint: context.execution.fingerprint,
          executionDeadlineAt: new Date(context.execution.deadlineAt).toISOString(),
        },
      },
      context,
    );
    return store.withPreparedArtifact(operation, async (prepared) => {
      const result = await publishValidatedBuild({
        ...prepared,
        stageId: operation.stageId,
        dataRoot: join(source.infraDir, "data"),
        authority,
        lease,
        expectedFingerprint: plan.targetFingerprint,
        signal: context.signal,
        beforePublication: async () => {
          const infra = new AnchoredDirectory(source.infraDir),
            releases = infra.directory(".ops-agent-releases", true, true);
          let lock: Awaited<ReturnType<typeof services.acquireReleaseStoreLock>> | undefined;
          try {
            lock = await services.acquireReleaseStoreLock(
              releases.anchor,
              {},
              { failIfBusy: true },
            );
            const current = await snapshot(source, operation, context.signal);
            if (
              current.preview.blockers.length ||
              current.preview.fingerprint !== plan.preview.fingerprint
            )
              throw Error("Prepared compatibility changed");
            return () => {
              try {
                lock?.release();
              } finally {
                releases.close();
                infra.close();
              }
            };
          } catch (error) {
            try {
              lock?.release();
            } finally {
              releases.close();
              infra.close();
            }
            throw error;
          }
        },
      });
      if (result.outcome !== "committed") return result;
      // The frozen CURRENT generation already names the producer paths; importing
      // changes their bytes, not configuration. Apply it through the one borrowed
      // require-running leaf under the SAME original import root.
      const hardlinks = readGenerationHardlinksOwnerPlan(authority);
      try {
        if (hardlinks.plan.plan.length) await assertConfigurationCoordinatorReady(context.signal);
        await services.withConfigurationGenerationWriter(
          source.infraDir,
          () =>
            executeOwnedGenerationHardlinks({
              authority,
              lease,
              infraDir: source.infraDir,
              transport: configurationDataManagerTransport(),
              signal: context.signal,
            }),
          context.signal,
        );
        await store.completePreparedImport(context, claim, result);
        return { ...result, followUp: "complete" as const };
      } catch (error) {
        if (
          hardlinks.reservation &&
          lookupControlChildPhaseBinding(authority, hardlinks.reservation)
        )
          throw new OpsExecutionFailure("recovery_required", {});
        // Files are committed, but an unavailable coordinator started no child.
        // Preserve that result; the caller must report failed follow-up explicitly.
        return { ...result, followUp: "failed" as const };
      }
    });
  };
}
