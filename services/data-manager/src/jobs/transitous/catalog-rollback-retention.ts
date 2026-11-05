/** Preserve the complete inactive healthy generation before validation can reuse it. */
import { createHash } from "node:crypto";
import { mkdirSync, statfsSync } from "node:fs";
import { join } from "node:path";
import {
  assertArtifactTargetLeaseForward,
  assertControlExecutionForward,
  controlDigest,
  executionAuthorityState,
  inspectArtifactTargetLeaseChildSettlement,
  signControl,
} from "@openmapx/core/build-artifacts";
import { canonicalJson } from "@openmapx/core/ops";
import z from "zod/v4";
import {
  copyArtifactTree,
  inspectArtifactTree,
} from "../../../../../packages/core/src/build-artifacts/copy-tree";
import { AnchoredDirectory } from "../../../../../packages/core/src/build-artifacts/filesystem";
import { safeArtifactPath } from "../../../../../packages/core/src/build-artifacts/manifest";
import { atomicWriteJsonSync } from "../../utils/atomic-write";
import type { DataExecutionContext } from "../execution/runtime";
import { dataExecutionInputFingerprint } from "../execution/store";
import { publishDataChange } from "../execution/worker-scope";
import { CANDIDATE_MANIFEST_FILENAME } from "./candidate";
import { readMotisSlotState } from "./slot-state";

const artifact = z.strictObject({
  path: z
    .string()
    .max(4096)
    .refine((value) => safeArtifactPath(value)),
  sizeBytes: z.number().int().nonnegative().safe(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const previousManifest = z.object({
  schemaVersion: z.literal(1),
  epoch: z.string().min(1).max(512),
  artifacts: z.object({
    config: artifact,
    license: artifact,
    proxyConfig: artifact,
    proxyVars: artifact,
    sourceManifest: artifact,
    sourceIndex: artifact.optional(),
    datasets: z.array(artifact).min(1).max(16384),
  }),
});
export async function retainPreviousHealthyCatalogSlot(
  context: DataExecutionContext,
  dataDir: string,
  proposalId: string,
  minimumDiskBytes: number,
): Promise<void> {
  const owner = executionAuthorityState(context.authority),
    record = await context.record();
  assertControlExecutionForward(context.authority);
  assertArtifactTargetLeaseForward(context.targetAuthority);
  if (
    owner.kind !== "catalog.validate" ||
    record.input.kind !== "catalog.validate" ||
    record.input.proposalId !== proposalId ||
    dataExecutionInputFingerprint(record.input) !== owner.execution.operationFingerprint ||
    context.targetAuthority.mode !== "owner" ||
    !["motis", "motis-staging", "motis-feed-proxy"].every((id) =>
      context.targetAuthority.serviceIds.includes(id),
    ) ||
    !Number.isSafeInteger(minimumDiskBytes) ||
    minimumDiskBytes < 0
  )
    throw Error("Original complete catalog validation owner required");
  const state = readMotisSlotState(dataDir);
  if (!state) throw Error("Initialize the two-slot MOTIS layout before catalog validation");
  const inactive = state.activeSlot === "A" ? "B" : "A";
  if (state.previousHealthySlot !== inactive) return;
  const stop = record.children.find(
    (child) => child.phase === "stop-staging" && child.ordinal === 0 && child.state === "terminal",
  );
  if (
    !stop ||
    stop.state !== "terminal" ||
    inspectArtifactTargetLeaseChildSettlement(context.targetAuthority, stop.execution)?.outcome !==
      "committed"
  )
    throw Error(
      "Stop staging under the original validation reservation before preserving rollback data",
    );
  const opened: AnchoredDirectory[] = [],
    limits = {
      maximumEntries: 100000,
      maximumBytes: Number.MAX_SAFE_INTEGER,
      maximumManifestBytes: 64 * 1024 * 1024,
    };
  const directory = (root: AnchoredDirectory, name: string, create = false, strict = false) => {
    const next = root.directory(name, create, strict);
    opened.push(next);
    return next;
  };
  try {
    const data = new AnchoredDirectory(owner.installation.dataRoot);
    opened.push(data);
    const motis = directory(data, "motis"),
      slots = directory(motis, "slots"),
      source = directory(slots, inactive);
    const expected = new AnchoredDirectory(dataDir);
    opened.push(expected);
    if (expected.stat.dev !== data.stat.dev || expected.stat.ino !== data.stat.ino)
      throw Error("Foreign catalog retention root");
    const manifest = previousManifest.parse(
        JSON.parse(
          source.read(CANDIDATE_MANIFEST_FILENAME, 32 * 1024 * 1024, false).toString("utf8"),
        ),
      ),
      inventory = inspectArtifactTree(source, limits),
      capacity = statfsSync(data.anchor, { bigint: true });
    const artifacts = [
      manifest.artifacts.config,
      manifest.artifacts.license,
      manifest.artifacts.proxyConfig,
      manifest.artifacts.proxyVars,
      manifest.artifacts.sourceManifest,
      ...manifest.artifacts.datasets,
      ...(manifest.artifacts.sourceIndex ? [manifest.artifacts.sourceIndex] : []),
    ];
    for (const expected of artifacts)
      if (
        !inventory.files.some(
          (file) => file.path === expected.path && file.sizeBytes === expected.sizeBytes,
        )
      )
        throw Error("Rollback generation is incomplete");
    if (
      capacity.bavail * capacity.bsize <
      BigInt(Math.max(inventory.totalBytes, minimumDiskBytes)) + 64n * 1024n * 1024n
    )
      throw Error(
        "Insufficient capacity to retain the previous healthy generation before validation",
      );
    const proposals = directory(motis, "proposals", false, true),
      base = directory(proposals, proposalId, false, true),
      basename = `rollback-${context.execution.executionId}`;
    await publishDataChange(async () => {
      mkdirSync(base.name(basename), { mode: 0o700 });
      const destination = directory(base, basename, false, true);
      const copied = await copyArtifactTree({
        source,
        destination,
        expectedInventory: inventory.metadataDigest,
        signal: context.signal,
        ...limits,
      });
      const copiedByPath = new Map(copied.files.map((file) => [file.path, file]));
      for (const expected of artifacts) {
        const actual = copiedByPath.get(expected.path);
        if (!actual || actual.sha256 !== expected.sha256 || actual.sizeBytes !== expected.sizeBytes)
          throw Error("Rollback generation artifact changed");
      }
      const manifestHash = copied.files.find(
        (file) => file.path === CANDIDATE_MANIFEST_FILENAME,
      )?.sha256;
      if (!manifestHash) throw Error("Retained rollback manifest is missing");
      const bytes = canonicalJson({
          files: copied.files,
          directories: copied.directories,
          totalBytes: copied.totalBytes,
        }),
        filesDigest = createHash("sha256").update(bytes).digest("hex");
      if (Buffer.byteLength(bytes, "utf8") > limits.maximumManifestBytes)
        throw Error("Rollback manifest exceeds its budget");
      base.write(`${basename}.files.json`, bytes, true);
      base.write(
        `${basename}.json`,
        canonicalJson(
          signControl(owner.installation.privateKey, "openmapx-catalog-rollback-v1", {
            version: 1,
            execution: context.execution,
            proposalId,
            slot: inactive,
            epoch: manifest.epoch,
            manifestHash,
            filesDigest,
            totalBytes: copied.totalBytes,
            fileCount: copied.files.length,
          }),
        ),
        true,
      );
      context.assertForward();
      if (controlDigest(readMotisSlotState(dataDir)) !== controlDigest(state))
        throw Error("MOTIS slot state changed before rollback retention");
      atomicWriteJsonSync(
        motis.name("slot-state.json"),
        {
          ...state,
          previousHealthySlot: undefined,
          retainedRollback: {
            proposalId,
            validationId: context.execution.executionId,
            slot: inactive,
            epoch: manifest.epoch,
            manifestHash,
            filesDigest,
          },
        },
        { durability: "full" },
      );
    });
  } finally {
    for (const directory of opened.reverse()) directory.close();
  }
}
