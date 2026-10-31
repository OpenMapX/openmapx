/** Fixed read-only prepared-artifact producer. No container lifecycle effects. */
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  AnchoredDirectory,
  artifactFingerprint,
  BUILD_RECORD_DIR,
  buildArtifactSpec,
  buildRecordSchema,
  controlDigest,
  incompletePreparedLayout,
  inspectDataFile,
  PREPARED_EVIDENCE_BYTES,
  portableMotisSourcesSchema,
  preparedArtifactPath,
  preparedBuildEvidenceSchema,
  sameDataFile,
  writeBuildBundle,
} from "@openmapx/core/build-artifacts";
import { canonicalJson } from "@openmapx/core/ops";
import { services } from "@openmapx/core/server";
import z from "zod/v4";
import type { DockerRuntimeOptions } from "../docker-runtime";
import type { OwnedServiceResolver } from "../owned-services";
import { OpsExecutionFailure, type OpsRuntime } from "../runtime";
import type { TrustedConfigurationAuthoritySnapshot } from "../trusted-config-runtime";
import type { ArtifactTransferStore } from "./store";

interface Source {
  infraDir: string;
  stack: services.StackPaths;
  ownedServices: OwnedServiceResolver;
  loadAuthority(): Promise<TrustedConfigurationAuthoritySnapshot>;
  execFile: NonNullable<DockerRuntimeOptions["execFile"]>;
}
const composeSchema = z.object({
  services: z.record(z.string(), z.object({ image: z.string().optional() })),
});
async function readExportSource(
  source: Source,
  serviceId: string,
  signal: AbortSignal,
  expectedArtifactFingerprint?: string,
) {
  const dataRoot = join(source.infraDir, "data"),
    spec = buildArtifactSpec(serviceId);
  const ids = [...new Set([serviceId, ...spec.consumers])];

  signal.throwIfAborted();
  const authority = await source.loadAuthority();
  if (!authority.services.some((service) => service.isBuiltIn && service.manifest.id === serviceId))
    throw Error("Prepared export target is unavailable");
  const root = new AnchoredDirectory(dataRoot),
    records = root.directory(BUILD_RECORD_DIR);
  let record: ReturnType<typeof buildRecordSchema.parse>;
  try {
    record = buildRecordSchema.parse(
      JSON.parse(records.read(`${serviceId}.json`, 4 * 1024 ** 2, false).toString("utf8")),
    );
    const evidence = preparedBuildEvidenceSchema.parse(
      JSON.parse(
        records.read(`${serviceId}.evidence.json`, PREPARED_EVIDENCE_BYTES, false).toString("utf8"),
      ),
    );
    if (
      record.schemaVersion !== 2 ||
      record.service !== serviceId ||
      canonicalJson(record) !== canonicalJson(evidence.record) ||
      (expectedArtifactFingerprint !== undefined &&
        record.artifactFingerprint !== expectedArtifactFingerprint) ||
      record.artifactFingerprint !== artifactFingerprint(evidence.files) ||
      incompletePreparedLayout(serviceId, evidence.files)
    )
      throw Error("Prepared export evidence is stale or incomplete");
    for (const file of evidence.files) {
      if (!sameDataFile(inspectDataFile(dataRoot, preparedArtifactPath(dataRoot, file.path)), file))
        throw Error("Prepared export output changed");
    }
    if (serviceId === "motis") {
      const live = new AnchoredDirectory(
        join(dataRoot, preparedArtifactPath(dataRoot, "motis/live")),
      );
      try {
        portableMotisSourcesSchema.parse(
          JSON.parse(live.read("portable-sources.json", 1048576, false).toString("utf8")),
        );
      } finally {
        live.close();
      }
    }
  } finally {
    records.close();
    root.close();
  }
  const config = composeSchema.parse(
    JSON.parse(
      (
        await source.execFile(
          "docker",
          [...services.stackComposeArgs(source.stack, existsSync), "config", "--format", "json"],
          { signal, timeout: 30000, maxBuffer: 1024 * 1024 },
        )
      ).stdout,
    ),
  );
  if (
    Object.entries(record.runtimeImages).some(([id, image]) => config.services[id]?.image !== image)
  )
    throw new OpsExecutionFailure("conflict", {});
  if (!source.ownedServices.inspectInventory) throw Error("Container inventory unavailable");
  const inventory = await source.ownedServices.inspectInventory(signal);
  if (
    inventory.unverifiedServiceIds.some((id) => ids.includes(id)) ||
    inventory.services.some(
      (row) => ids.includes(row.serviceId) && !["stopped", "created"].includes(row.state),
    )
  )
    throw new OpsExecutionFailure("conflict", {});
  return {
    record,
    fingerprint: controlDigest({
      record,
      revision: services.currentConfigurationGeneration(source.infraDir),
      authority: authority.revisionId,
      images: config.services,
      containers: inventory.services.filter((row) => ids.includes(row.serviceId)),
    }),
  };
}
export function installPreparedExportRuntime(
  runtime: OpsRuntime,
  store: ArtifactTransferStore,
  source: Source,
): void {
  runtime["artifactTransfer.capabilities"] = async (_operation, context) => {
    const targets = [];
    for (const serviceId of ["tileserver", "osrm", "otp", "pelias", "motis"]) {
      context.signal.throwIfAborted();
      try {
        const current = await readExportSource(source, serviceId, context.signal);
        targets.push({
          serviceId,
          available: true,
          reason: null,
          artifactFingerprint:
            current.record.schemaVersion === 2 ? current.record.artifactFingerprint : null,
        });
      } catch {
        targets.push({
          serviceId,
          available: false,
          reason:
            "Complete verified data, matching runtime images and stopped consumers are required.",
          artifactFingerprint: null,
        });
      }
    }
    return { ...(await store.transferCapabilities()), targets };
  };
  runtime["artifactTransfer.export"] = async (operation, context) => {
    const dataRoot = join(source.infraDir, "data"),
      spec = buildArtifactSpec(operation.serviceId);
    const ids = [...new Set([operation.serviceId, ...spec.consumers])];
    if (
      !context.ownedTargetLease ||
      ids.some((id) => !context.ownedTargetLease!.serviceIds.includes(id))
    )
      throw Error("Original export target closure required");

    return services.withConfigurationGenerationWriter(
      source.infraDir,
      async () => {
        const before = await readExportSource(
          source,
          operation.serviceId,
          context.signal,
          operation.expectedArtifactFingerprint,
        );
        return store.writePreparedExport(context, async (target, signal) => {
          const result = await writeBuildBundle({
            dataRoot,
            serviceId: operation.serviceId,
            record: before.record,
            target,
            limits: store.policy,
            signal,
          });
          const after = await readExportSource(
            source,
            operation.serviceId,
            signal,
            operation.expectedArtifactFingerprint,
          );
          if (before.fingerprint !== after.fingerprint)
            throw new OpsExecutionFailure("conflict", {});
          return {
            artifactFingerprint:
              before.record.schemaVersion === 2
                ? before.record.artifactFingerprint
                : result.artifactFingerprint,
          };
        });
      },
      context.signal,
    );
  };
}
