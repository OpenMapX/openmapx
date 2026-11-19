/** Local artifact transaction. Admission, stopped-consumer checks and remote
 * follow-up belong to the fixed agent/CLI consumer; this reports file commit only. */
import { createHash } from "node:crypto";
import { fsyncSync, lstatSync, mkdirSync, renameSync, rmdirSync, unlinkSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { z } from "zod";
import { canonicalJson } from "../ops/canonical-json";
import { opsOperationSchema } from "../ops/contract";
import { opsOperationFingerprint } from "../ops/fingerprint";
import {
  currentConfigurationGeneration,
  withConfigurationGenerationWriter,
} from "../services/configuration-generation";
import type { DataManagerTransport } from "../services/data-manager/transport";
import type { ValidatedBuildBundle } from "./archive";
import { controlDigest } from "./control-records";
import { hashArtifactFile, inspectArtifactTree } from "./copy-tree";
import {
  beginControlEffect,
  cancelControlExecution,
  type ExecutionHandle,
  executionEffectStarted,
  inspectControlChildPublication,
  retainControlEffectReceipt,
  verifyControlEffectSettlement,
  verifyLocalArtifactTargetRootRelease,
} from "./execution-record";
import { AnchoredDirectory, type FileIdentity, identity, sameInode } from "./filesystem";
import { inspectGenerationLinks } from "./generation-link";
import {
  BUILD_RECORD_DIR,
  buildArtifactSpec,
  buildRecordSchema,
  parseBundleManifest,
  safeArtifactPath,
} from "./manifest";
import type { MotisCandidateManifest } from "./motis-candidate";
import type { VerifiedPortableMotisMaterialization } from "./motis-portable";
import {
  assertMotisPublicationAliases,
  materializedMotisBundle,
  motisPublicationLayoutSchema,
  readMotisPublicationLayout,
} from "./motis-publication";
import { capturePreparedBuildEvidence, incompletePreparedLayout } from "./prepared-evidence";
import { readPrivateRecord, writePrivateRecord } from "./private-records";
import {
  assertArtifactTargetLeaseExecution,
  assertArtifactTargetLeaseReceiptOwner,
  type TargetLeaseAuthority,
} from "./target-lease";

export type ArtifactFilePublicationResult =
  | { outcome: "committed"; serviceId: string; artifactFingerprint: string; cleanupFailed: boolean }
  | { outcome: "not_committed"; reason: "conflict" | "invalid" | "failed"; cleanupFailed: boolean };
export interface ArtifactPublicationInput {
  dataRoot: string;
  stagingRoot: string;
  stageId: string;
  bundle: ValidatedBuildBundle;
  authority: ExecutionHandle;
  lease: TargetLeaseAuthority;
  expectedFingerprint: string;
  materialization?: VerifiedPortableMotisMaterialization;
  /** Fixed destination producer runs inside this one configuration writer. Its
   * nominal output is reverified; a callback cannot supply generated-file authority. */
  materializeMotis?: () => Promise<VerifiedPortableMotisMaterialization>;
  signal?: AbortSignal;
  /** Fixed local consumer's denial-only compatibility fence, acquired after
   * payload hashing while this publisher owns the configuration writer.
   * It grants no execution/target authority and never crosses an envelope. */
  beforePublication?: () => Promise<() => void>;
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const inode = z.strictObject({ dev: z.string(), ino: z.string() }),
  digest = z.string().regex(/^[a-f0-9]{64}$/);
const directoryEntry = z.strictObject({
  path: z.string(),
  targetPath: z.string().optional(),
  old: inode.nullable(),
  next: inode,
  oldMetadata: digest.nullable(),
  nextMetadata: digest,
  backup: z.string(),
});
const recordEntry = z.strictObject({
  name: z.string(),
  scope: z.enum(["build", "motis"]).optional(),
  old: inode.nullable(),
  next: inode.nullable(),
  digest: digest.nullable(),
  oldDigest: digest.nullable(),
  backup: z.string(),
});
const journalSchema = z.strictObject({
  version: z.literal(1),
  executionDigest: digest,
  leaseId: z.uuid(),
  stageId: z.uuid(),
  serviceId: z.string(),
  archiveSha256: digest,
  artifactFingerprint: digest,
  portableArtifactFingerprint: digest.optional(),
  motisLayout: motisPublicationLayoutSchema.optional(),
  expectedFingerprint: digest,
  stagingRelative: z.string(),
  stagingIdentity: inode,
  backupIdentity: inode,
  recordsIdentity: inode,
  phase: z.enum(["prepared", "committed", "restored"]),
  directories: z.array(directoryEntry).max(8),
  records: z.array(recordEntry).min(2).max(3),
  cleanupFailed: z.boolean(),
});
type Journal = z.infer<typeof journalSchema>;
const MAX_METADATA = 16 * 1024 * 1024;
const TREE_LIMITS = {
  maximumEntries: 10000,
  maximumBytes: Number.MAX_SAFE_INTEGER,
  maximumManifestBytes: MAX_METADATA,
};
function missing(error: unknown) {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}
function directoryAt(root: AnchoredDirectory, path: string, create = false) {
  if (path && !safeArtifactPath(path)) throw Error("Invalid artifact layout");
  const opened: AnchoredDirectory[] = [];
  let dir = root;
  try {
    for (const part of path ? path.split("/") : []) {
      dir = dir.directory(part, create, false);
      opened.push(dir);
    }
    return {
      dir,
      close() {
        for (const item of opened.reverse()) item.close();
      },
    };
  } catch (error) {
    for (const item of opened.reverse()) item.close();
    throw error;
  }
}
function parent(root: AnchoredDirectory, path: string, create = false) {
  const parts = path.split("/"),
    name = parts.pop();
  if (!name || !safeArtifactPath(path)) throw Error("Invalid artifact layout");
  return { ...directoryAt(root, parts.join("/"), create), name };
}
function dirIdentity(root: AnchoredDirectory, path: string): FileIdentity | null {
  let p: ReturnType<typeof parent> | undefined;
  try {
    p = parent(root, path);
    const stat = lstatSync(p.dir.name(p.name), { bigint: true });
    if (!stat.isDirectory()) throw Error("Artifact directory alias refused");
    const d = p.dir.directory(p.name, false, false);
    try {
      return identity(d.stat);
    } finally {
      d.close();
    }
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  } finally {
    p?.close();
  }
}
function directoryMetadata(root: AnchoredDirectory, path: string) {
  const d = directoryAt(root, path);
  try {
    return inspectArtifactTree(d.dir, TREE_LIMITS).metadataDigest;
  } finally {
    d.close();
  }
}
function fileIdentity(root: AnchoredDirectory, name: string): FileIdentity | null {
  try {
    return root.fileIdentity(name, false);
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}
function equal(a: FileIdentity | null, b: FileIdentity | null) {
  return a === null || b === null ? a === b : sameInode(a, b);
}
function snapshot(root: AnchoredDirectory, serviceId: string) {
  const spec = buildArtifactSpec(serviceId);
  const motisLayout = serviceId === "motis" ? readMotisPublicationLayout(root) : undefined;
  const directories = spec.dirs.map((path) => {
    const targetPath = path === "motis/live" && motisLayout ? motisLayout.physicalLive : path;
    const id = dirIdentity(root, targetPath);
    const entry = { path, ...(targetPath === path ? {} : { targetPath }) };
    if (!id) return { ...entry, id: null, metadata: null };
    const d = directoryAt(root, targetPath);
    try {
      return { ...entry, id, metadata: inspectArtifactTree(d.dir, TREE_LIMITS).metadataDigest };
    } finally {
      d.close();
    }
  });
  let records: AnchoredDirectory | undefined;
  try {
    records = root.directory(BUILD_RECORD_DIR);
  } catch (error) {
    if (!missing(error)) throw error;
  }
  try {
    const snapshots: Array<{
      name: string;
      id: FileIdentity | null;
      digest: string | null;
      scope?: "motis";
    }> = [`${serviceId}.json`, `${serviceId}.evidence.json`].map((name) => {
      const id = records ? fileIdentity(records, name) : null;
      return {
        name,
        id,
        digest:
          id && records ? hash(records.read(name, MAX_METADATA, false).toString("utf8")) : null,
      };
    });
    if (motisLayout?.slotState)
      snapshots.push({
        name: "slot-state.json",
        scope: "motis",
        id: motisLayout.slotState.inode,
        digest: motisLayout.slotState.digest,
      });
    return { directories, records: snapshots, ...(motisLayout ? { motisLayout } : {}) };
  } finally {
    records?.close();
  }
}
export async function artifactPublicationFingerprint(
  dataRoot: string,
  serviceId: string,
): Promise<string> {
  const root = new AnchoredDirectory(dataRoot);
  try {
    return controlDigest(snapshot(root, serviceId));
  } finally {
    root.close();
  }
}
function checkedOwner(input: ArtifactPublicationInput) {
  const owner = input.authority;
  if (
    owner.kind !== "artifactTransfer.import" ||
    input.lease.mode !== "owner" ||
    owner.installation.fixedChildId ||
    !["host-cli", "ops-agent"].includes(owner.installation.installation.role)
  )
    throw Error("Original artifact import owner required");
  assertArtifactTargetLeaseReceiptOwner(input.lease, owner.execution);
  const serviceId = input.bundle.manifest.service,
    spec = buildArtifactSpec(serviceId);
  if ([serviceId, ...spec.consumers].some((id) => !input.lease.serviceIds.includes(id)))
    throw Error("Artifact import target closure mismatch");
  const root = new AnchoredDirectory(input.dataRoot),
    trusted = new AnchoredDirectory(owner.installation.dataRoot);
  try {
    if (!sameInode(identity(root.stat), identity(trusted.stat)))
      throw Error("Foreign artifact data root");
  } finally {
    root.close();
    trusted.close();
  }
  const admitted = owner as {
    operation: {
      kind: string;
      stageId?: string;
      expectedSha256?: string;
      expectedCurrentRevisionId?: string | null;
    };
  };
  if (
    admitted.operation.kind !== owner.kind ||
    admitted.operation.stageId !== input.stageId ||
    admitted.operation.expectedSha256 !== input.bundle.archiveSha256
  )
    throw Error("Artifact stage admission mismatch");
  return { ...owner, origin: owner.origin };
}
function journalName(owner: ReturnType<typeof checkedOwner>) {
  return `artifact-publication-${owner.execution.operationKey}.json`;
}
function readJournal(owner: ReturnType<typeof checkedOwner>): Journal | null {
  try {
    const raw = readPrivateRecord(owner.installation, "observations", journalName(owner));
    return journalSchema.parse(raw);
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}
function writeJournal(owner: ReturnType<typeof checkedOwner>, journal: Journal) {
  writePrivateRecord(
    owner.installation,
    "observations",
    journalName(owner),
    journalSchema.parse(journal),
    false,
  );
}
function moved(
  from: AnchoredDirectory,
  fromName: string,
  to: AnchoredDirectory,
  toName: string,
  expected: FileIdentity,
  directory: boolean,
) {
  const current = directory ? dirIdentity(from, fromName) : fileIdentity(from, fromName);
  if (!equal(current, expected) || (directory ? dirIdentity(to, toName) : fileIdentity(to, toName)))
    throw Error("Artifact publication path changed");
  renameSync(from.name(fromName), to.name(toName));
  fsyncSync(from.fd);
  fsyncSync(to.fd);
  if (!equal(directory ? dirIdentity(to, toName) : fileIdentity(to, toName), expected))
    throw Error("Artifact publication inode changed");
}
function moveDirectory(
  from: AnchoredDirectory,
  path: string,
  to: AnchoredDirectory,
  destination: string,
  expected: FileIdentity,
) {
  const a = parent(from, path),
    b = parent(to, destination, true);
  try {
    moved(a.dir, a.name, b.dir, b.name, expected, true);
  } finally {
    b.close();
    a.close();
  }
}
function removeTree(
  root: AnchoredDirectory,
  name: string,
  expected: FileIdentity,
  remaining = { entries: 1000000 },
  depth = 0,
) {
  if (depth > 64 || --remaining.entries < 0) throw Error("Artifact cleanup exceeds its budget");
  const dir = root.directory(name, false, false);
  try {
    if (!sameInode(identity(dir.stat), expected)) throw Error("Artifact cleanup directory changed");
    for (const child of dir.listBounded(remaining.entries)) {
      const stat = lstatSync(dir.name(child), { bigint: true });
      if (stat.dev !== dir.stat.dev || stat.isSymbolicLink())
        throw Error("Artifact cleanup alias refused");
      if (stat.isDirectory()) removeTree(dir, child, identity(stat), remaining, depth + 1);
      else if (stat.isFile()) {
        if (--remaining.entries < 0) throw Error("Artifact cleanup exceeds its budget");
        unlinkSync(dir.name(child));
      } else throw Error("Artifact cleanup type refused");
    }
    dir.check();
    rmdirSync(root.name(name));
    fsyncSync(root.fd);
  } finally {
    dir.close();
  }
}
function validateJournal(
  input: ArtifactPublicationInput,
  journal: Journal,
  owner: ReturnType<typeof checkedOwner>,
) {
  const spec = buildArtifactSpec(input.bundle.manifest.service);
  if (
    journal.executionDigest !== controlDigest(owner.execution) ||
    journal.leaseId !== input.lease.leaseId ||
    journal.stageId !== input.stageId ||
    journal.serviceId !== input.bundle.manifest.service ||
    journal.archiveSha256 !== input.bundle.archiveSha256 ||
    (journal.portableArtifactFingerprint ?? journal.artifactFingerprint) !==
      input.bundle.artifactFingerprint ||
    canonicalJson(journal.directories.map((d) => d.path)) !== canonicalJson(spec.dirs) ||
    canonicalJson(journal.records.map((r) => r.name)) !==
      canonicalJson([
        `${journal.serviceId}.json`,
        `${journal.serviceId}.evidence.json`,
        ...(journal.motisLayout?.slotState ? ["slot-state.json"] : []),
      ]) ||
    journal.records.some((entry, index) =>
      index < 2 ? entry.scope === "motis" : entry.scope !== "motis",
    ) ||
    journal.directories.some(
      (entry) =>
        (entry.targetPath ?? entry.path) !==
        (entry.path === "motis/live" && journal.motisLayout
          ? journal.motisLayout.physicalLive
          : entry.path),
    ) ||
    (journal.serviceId === "motis"
      ? !journal.motisLayout || !journal.portableArtifactFingerprint
      : journal.motisLayout !== undefined || journal.portableArtifactFingerprint !== undefined)
  )
    throw Error("Artifact publication journal identity changed");
}
function targetPath(entry: Journal["directories"][number]) {
  return entry.targetPath ?? entry.path;
}
function withRecord<T>(
  root: AnchoredDirectory,
  records: AnchoredDirectory,
  entry: Journal["records"][number],
  run: (directory: AnchoredDirectory) => T,
): T {
  if (entry.scope !== "motis") return run(records);
  if (entry.name !== "slot-state.json") throw Error("Invalid MOTIS metadata record");
  const motis = root.directory("motis", false, false);
  try {
    return run(motis);
  } finally {
    motis.close();
  }
}
function restore(
  root: AnchoredDirectory,
  source: AnchoredDirectory,
  backups: AnchoredDirectory,
  records: AnchoredDirectory,
  journal: Journal,
) {
  if (journal.motisLayout) assertMotisPublicationAliases(root, journal.motisLayout);
  // Validate the WHOLE recorded set before restoring any member.
  for (const entry of journal.directories) {
    const live = dirIdentity(root, targetPath(entry)),
      next = dirIdentity(source, entry.path),
      old = dirIdentity(backups, entry.backup);
    if (
      (live && !equal(live, entry.old) && !equal(live, entry.next)) ||
      (next && !equal(next, entry.next)) ||
      (old && !equal(old, entry.old)) ||
      (equal(live, entry.next) && next) ||
      (entry.old && !equal(live, entry.old) && !equal(old, entry.old))
    )
      throw Error("Artifact restoration identity is uncertain");
  }
  for (const entry of journal.records) {
    const live = withRecord(root, records, entry, (home) => fileIdentity(home, entry.name)),
      old = fileIdentity(backups, entry.backup);
    if (
      (live && !equal(live, entry.old) && !equal(live, entry.next)) ||
      (old && !equal(old, entry.old)) ||
      (entry.old && !equal(live, entry.old) && !equal(old, entry.old))
    )
      throw Error("Artifact record restoration identity is uncertain");
  }
  for (const entry of journal.directories) {
    const old = entry.old
      ? equal(dirIdentity(root, targetPath(entry)), entry.old)
        ? { root, path: targetPath(entry) }
        : { root: backups, path: entry.backup }
      : null;
    if (old && directoryMetadata(old.root, old.path) !== entry.oldMetadata)
      throw Error("Artifact restoration content is uncertain");
  }
  for (const entry of journal.records) {
    const old =
      entry.old &&
      (equal(
        withRecord(root, records, entry, (home) => fileIdentity(home, entry.name)),
        entry.old,
      )
        ? {
            root: entry.scope === "motis" ? root : records,
            name: entry.scope === "motis" ? "motis/slot-state.json" : entry.name,
          }
        : { root: backups, name: entry.backup });
    if (
      old &&
      hash(
        (old.root === root && entry.scope === "motis"
          ? withRecord(root, records, entry, (home) => home.read(entry.name, MAX_METADATA, false))
          : old.root.read(old.name, MAX_METADATA, false)
        ).toString("utf8"),
      ) !== entry.oldDigest
    )
      throw Error("Artifact record restoration content is uncertain");
  }
  for (const entry of [...journal.directories].reverse()) {
    if (equal(dirIdentity(root, targetPath(entry)), entry.next))
      moveDirectory(root, targetPath(entry), source, entry.path, entry.next);
    if (entry.old && equal(dirIdentity(backups, entry.backup), entry.old))
      moveDirectory(backups, entry.backup, root, targetPath(entry), entry.old);
  }
  for (const entry of journal.records) {
    withRecord(root, records, entry, (home) => {
      if (entry.next && equal(fileIdentity(home, entry.name), entry.next))
        home.removeFile(entry.name);
      if (entry.old && equal(fileIdentity(backups, entry.backup), entry.old))
        moved(backups, entry.backup, home, entry.name, entry.old, false);
    });
  }
}
function cleanup(backups: AnchoredDirectory, journal: Journal) {
  let failed = false;
  for (const entry of journal.directories)
    try {
      const found = dirIdentity(backups, entry.backup);
      if (found) {
        if (!entry.old || !equal(found, entry.old)) throw Error("Artifact backup changed");
        removeTree(backups, entry.backup, entry.old);
      }
    } catch {
      failed = true;
    }
  for (const entry of journal.records)
    try {
      const found = fileIdentity(backups, entry.backup);
      if (found) {
        if (!entry.old || !equal(found, entry.old)) throw Error("Artifact record backup changed");
        backups.removeFile(entry.backup);
      }
    } catch {
      failed = true;
    }
  return failed;
}

export async function publishValidatedBuild(
  input: ArtifactPublicationInput,
): Promise<ArtifactFilePublicationResult> {
  const owner = checkedOwner(input),
    serviceId = input.bundle.manifest.service;
  return withConfigurationGenerationWriter(dirname(resolve(input.dataRoot)), async () => {
    const root = new AnchoredDirectory(input.dataRoot);
    let releaseCompatibility: (() => void) | undefined;
    let source: ReturnType<typeof directoryAt> | undefined,
      backups: AnchoredDirectory | undefined,
      records: AnchoredDirectory | undefined;
    try {
      let journal = readJournal(owner);
      if (journal) {
        validateJournal(input, journal, owner);
        if (journal.phase === "committed")
          return {
            outcome: "committed",
            serviceId,
            artifactFingerprint: journal.artifactFingerprint,
            cleanupFailed: journal.cleanupFailed,
          };
        if (journal.phase === "restored")
          return {
            outcome: "not_committed",
            reason: "failed",
            cleanupFailed: journal.cleanupFailed,
          };
      }
      const stagingRelative =
        journal?.stagingRelative ?? relative(resolve(input.dataRoot), resolve(input.stagingRoot));
      if (
        !safeArtifactPath(stagingRelative) ||
        !(
          stagingRelative === `.openmapx-import-${input.stageId}` ||
          new RegExp(`^\\.openmapx-transfers/${input.stageId}/prepared-[a-f0-9-]{36}$`).test(
            stagingRelative,
          )
        )
      )
        throw Error("Unmanaged artifact staging path");
      source = directoryAt(root, stagingRelative);
      if (source.dir.stat.dev !== root.stat.dev)
        throw Error("Artifact publication requires the target filesystem");
      if (journal) {
        if (!sameInode(identity(source.dir.stat), journal.stagingIdentity))
          throw Error("Artifact staging directory changed");
        backups = source.dir.directory(`publication-${input.stageId}`, false, true);
        records = root.directory(BUILD_RECORD_DIR);
        if (
          !sameInode(identity(backups.stat), journal.backupIdentity) ||
          !sameInode(identity(records.stat), journal.recordsIdentity)
        )
          throw Error("Artifact recovery directory changed");
        restore(root, source.dir, backups, records, journal);
        journal.phase = "restored";
        writeJournal(owner, journal);
        return { outcome: "not_committed", reason: "failed", cleanupFailed: false };
      }
      input.signal?.throwIfAborted();
      await assertArtifactTargetLeaseExecution(input.lease, owner.execution);
      if (controlDigest(snapshot(root, serviceId)) !== input.expectedFingerprint)
        return { outcome: "not_committed", reason: "conflict", cleanupFailed: false };
      let bundle = input.bundle,
        motisCandidate: MotisCandidateManifest | undefined;
      if (serviceId === "motis") {
        const materialization = input.materialization ?? (await input.materializeMotis?.());
        if (!materialization) throw Error("Original destination MOTIS materialization required");
        const materialized = await materializedMotisBundle(
          input.bundle,
          input.stagingRoot,
          materialization,
          input.signal,
        );
        bundle = materialized;
        motisCandidate = materialized.motisCandidate;
      }
      const manifest =
        serviceId === "motis"
          ? bundle.manifest
          : parseBundleManifest(JSON.stringify(bundle.manifest));
      if (
        manifest.files.length + manifest.directories.length > 10000 ||
        incompletePreparedLayout(serviceId, manifest.files)
      )
        return { outcome: "not_committed", reason: "invalid", cleanupFailed: false };
      // Compare the exact payload set before any live path is renamed. The
      // private validation manifest and publication journal live outside these roots.
      const stagedFiles: string[] = [],
        stagedDirectories: string[] = [],
        sourceMetadata = new Map<string, string>();
      for (const path of manifest.dirs) {
        const directory = directoryAt(source.dir, path);
        try {
          const tree = inspectArtifactTree(directory.dir, TREE_LIMITS);
          sourceMetadata.set(path, tree.metadataDigest);
          stagedDirectories.push(path, ...tree.directories.map((name) => `${path}/${name}`));
          stagedFiles.push(...tree.files.map((file) => `${path}/${file.path}`));
        } finally {
          directory.close();
        }
      }
      if (
        canonicalJson(stagedFiles.sort()) !==
          canonicalJson(manifest.files.map((file) => file.path).sort()) ||
        canonicalJson(stagedDirectories.sort()) !== canonicalJson([...manifest.directories].sort())
      )
        return { outcome: "not_committed", reason: "invalid", cleanupFailed: false };
      for (const file of manifest.files) {
        const actual = await hashArtifactFile(source.dir, file.path, input.signal);
        if (actual.sha256 !== file.sha256 || actual.sizeBytes !== file.sizeBytes)
          return { outcome: "not_committed", reason: "conflict", cleanupFailed: false };
      }
      try {
        releaseCompatibility = await input.beforePublication?.();
      } catch {
        return { outcome: "not_committed", reason: "conflict", cleanupFailed: false };
      }
      const original = owner as { operation: { expectedCurrentRevisionId: string | null } };
      if (
        currentConfigurationGeneration(dirname(resolve(input.dataRoot))) !==
          original.operation.expectedCurrentRevisionId ||
        controlDigest(snapshot(root, serviceId)) !== input.expectedFingerprint
      )
        return { outcome: "not_committed", reason: "conflict", cleanupFailed: false };
      input.signal?.throwIfAborted();
      await assertArtifactTargetLeaseExecution(input.lease, owner.execution);
      if (
        manifest.dirs.some(
          (path) => directoryMetadata(source!.dir, path) !== sourceMetadata.get(path),
        )
      )
        return { outcome: "not_committed", reason: "conflict", cleanupFailed: false };
      const initial = snapshot(root, serviceId);
      records = root.directory(BUILD_RECORD_DIR, true);
      mkdirSync(source.dir.name(`publication-${input.stageId}`), { mode: 0o700 });
      fsyncSync(source.dir.fd);
      backups = source.dir.directory(`publication-${input.stageId}`, false, true);
      journal = {
        version: 1,
        executionDigest: controlDigest(owner.execution),
        leaseId: input.lease.leaseId,
        stageId: input.stageId,
        serviceId,
        archiveSha256: input.bundle.archiveSha256,
        artifactFingerprint: bundle.artifactFingerprint,
        ...(initial.motisLayout
          ? {
              motisLayout: initial.motisLayout,
              portableArtifactFingerprint: input.bundle.artifactFingerprint,
            }
          : {}),
        expectedFingerprint: input.expectedFingerprint,
        stagingRelative,
        stagingIdentity: identity(source.dir.stat),
        backupIdentity: identity(backups.stat),
        recordsIdentity: identity(records.stat),
        phase: "prepared",
        directories: initial.directories.map((dir, index) => ({
          path: dir.path,
          ...(dir.targetPath ? { targetPath: dir.targetPath } : {}),
          old: dir.id,
          oldMetadata: dir.metadata,
          nextMetadata: sourceMetadata.get(dir.path)!,
          next: dirIdentity(source!.dir, dir.path)!,
          backup: `directory-${index}`,
        })),
        records: initial.records.map((record, index) => ({
          name: record.name,
          ...(record.scope ? { scope: record.scope } : {}),
          old: record.id,
          oldDigest: record.digest,
          next: null,
          digest: null,
          backup: `record-${index}`,
        })),
        cleanupFailed: false,
      };
      writeJournal(owner, journal);
      if (!(await executionEffectStarted(input.authority)))
        await beginControlEffect(input.authority);
      try {
        for (const entry of journal.directories) {
          input.signal?.throwIfAborted();
          await assertArtifactTargetLeaseExecution(input.lease, owner.execution);
          if (journal.motisLayout) assertMotisPublicationAliases(root, journal.motisLayout);
          if (entry.old) moveDirectory(root, targetPath(entry), backups, entry.backup, entry.old);
          moveDirectory(source.dir, entry.path, root, targetPath(entry), entry.next);
        }
        const originalRecords = backups;
        for (const entry of journal.records)
          if (entry.old)
            withRecord(root, records, entry, (home) =>
              moved(home, entry.name, originalRecords, entry.backup, entry.old!, false),
            );
        const { dirs: _dirs, directories: _directories, files: _files, ...record } = manifest;
        const pin = (name: string, inode: FileIdentity, bytes: string) => {
          const entry = journal!.records.find((entry) => entry.name === name);
          if (!entry) throw Error("Artifact record not admitted");
          entry.next = inode;
          entry.digest = hash(bytes);
          writeJournal(owner, journal!);
        };
        const next = await capturePreparedBuildEvidence({
          dataRoot: input.dataRoot,
          record: buildRecordSchema.parse(record),
          verifiedFiles: manifest.files,
          signal: input.signal,
          beforePublish: (inode, bytes) => pin(`${serviceId}.evidence.json`, inode, bytes),
        });
        if (next.artifactFingerprint !== bundle.artifactFingerprint)
          throw Error("Published artifact content differs from validation");
        if (
          journal.directories.some(
            (entry) => directoryMetadata(root, targetPath(entry)) !== entry.nextMetadata,
          )
        )
          throw Error("Imported content changed before commit");
        const bytes = JSON.stringify(next);
        records.write(`${serviceId}.json`, bytes, false, (inode) =>
          pin(`${serviceId}.json`, inode, bytes),
        );
        if (journal.motisLayout?.slotState && motisCandidate) {
          const original = journal.motisLayout.slotState.record;
          const manifestHash = manifest.files.find(
            (file) => file.path === "motis/live/motis-candidate-manifest.json",
          )?.sha256;
          if (!manifestHash) throw Error("Materialized MOTIS manifest proof missing");
          const imageDigest = manifest.runtimeImages.motis?.match(/@(sha256:[a-f0-9]{64})$/)?.[1];
          const nextState = {
            schemaVersion: 1,
            activeSlot: original.activeSlot,
            ...(original.previousHealthySlot && original.previousHealthySlot !== original.activeSlot
              ? { previousHealthySlot: original.previousHealthySlot }
              : {}),
            ...(original.retainedRollback && original.retainedRollback.slot !== original.activeSlot
              ? { retainedRollback: original.retainedRollback }
              : {}),
            datasetEpoch: motisCandidate.epoch,
            manifestHash,
            ...(imageDigest ? { imageDigest } : {}),
          };
          const entry = journal.records.find((record) => record.scope === "motis");
          if (!entry) throw Error("Original MOTIS slot metadata reservation missing");
          const stateBytes = JSON.stringify(nextState);
          withRecord(root, records, entry, (home) =>
            home.write("slot-state.json", stateBytes, false, (inode) =>
              pin("slot-state.json", inode, stateBytes),
            ),
          );
        }
        if (journal.motisLayout) assertMotisPublicationAliases(root, journal.motisLayout);
        journal.phase = "committed";
        writeJournal(owner, journal);
      } catch (error) {
        const current = readJournal(owner);
        if (!current) throw error;
        journal = current;
        if (journal.phase !== "committed") {
          restore(root, source.dir, backups, records, journal);
          journal.phase = "restored";
          writeJournal(owner, journal);
          return { outcome: "not_committed", reason: "failed", cleanupFailed: false };
        }
      }
      journal.cleanupFailed = cleanup(backups, journal);
      writeJournal(owner, journal);
      return {
        outcome: "committed",
        serviceId,
        artifactFingerprint: journal.artifactFingerprint,
        cleanupFailed: journal.cleanupFailed,
      };
    } finally {
      try {
        releaseCompatibility?.();
      } finally {
        records?.close();
        backups?.close();
        source?.close();
        root.close();
      }
    }
  });
}

/** Read the sole local publisher's recorded, indexed commit evidence. Local consumers
 * use this to settle a stage; public receipt IDs or result strings are insufficient. */
export function inspectArtifactPublication(authority: ExecutionHandle) {
  const state = authority;
  if (state.kind !== "artifactTransfer.import") throw Error("Original import authority required");
  const journal = readJournal({ ...state, origin: state.origin });
  if (!journal) return null;
  if (journal.executionDigest !== controlDigest(state.execution))
    throw Error("Original artifact publication is unavailable");
  return {
    phase: journal.phase,
    stageId: journal.stageId,
    archiveSha256: journal.archiveSha256,
    serviceId: journal.serviceId,
    artifactFingerprint: journal.artifactFingerprint,
    cleanupFailed: journal.cleanupFailed,
  };
}

/** Remove only the empty owned rollback directory after proved restoration and
 * physical release. This permits a new deliberate import of the same stage. */
export async function cleanupRestoredArtifactPublication(
  authority: ExecutionHandle,
): Promise<void> {
  const state = authority;
  if (state.kind !== "artifactTransfer.import") throw Error("Original import authority required");
  const journal = readJournal({ ...state, origin: state.origin });
  if (
    !journal ||
    journal.phase !== "restored" ||
    journal.executionDigest !== controlDigest(state.execution)
  )
    throw Error("Original restored publication required");
  await verifyLocalArtifactTargetRootRelease(authority);
  const root = new AnchoredDirectory(state.installation.dataRoot);
  let source: ReturnType<typeof directoryAt> | undefined, backups: AnchoredDirectory | undefined;
  try {
    source = directoryAt(root, journal.stagingRelative);
    if (!sameInode(identity(source.dir.stat), journal.stagingIdentity))
      throw Error("Restored staging identity changed");
    const name = `publication-${journal.stageId}`;
    try {
      backups = source.dir.directory(name, false, true);
    } catch (error) {
      if (missing(error)) return;
      throw error;
    }
    if (!sameInode(identity(backups.stat), journal.backupIdentity) || backups.listBounded(1).length)
      throw Error("Restored rollback directory is not empty and owned");
    backups.close();
    backups = undefined;
    if (!equal(dirIdentity(source.dir, name), journal.backupIdentity))
      throw Error("Restored rollback identity changed");
    rmdirSync(source.dir.name(name));
    fsyncSync(source.dir.fd);
  } finally {
    backups?.close();
    source?.close();
    root.close();
  }
}

/** Close only this purpose's proved historical publication. The original
 * canonical status/digest/time remain unchanged even if delivery failed after
 * files committed; containment is a separate, source-verified fact. */
export async function inspectSettledArtifactImport(
  authority: ExecutionHandle,
  links: { transport: DataManagerTransport; infraDir: string; revisionId: string | undefined },
) {
  const owner = authority;
  if (owner.kind !== "artifactTransfer.import") throw Error("Original import required");
  const journal = readJournal({ ...owner, origin: owner.origin });
  if (!journal || !["committed", "restored"].includes(journal.phase))
    throw Error("Original settled import required");
  await verifyLocalArtifactTargetRootRelease(authority);
  const effect = await verifyControlEffectSettlement(
    owner.installation.installation,
    owner.execution,
  );
  if (
    journal.phase === "committed"
      ? effect.outcome !== "committed" || effect.publication !== "committed"
      : effect.outcome === "unknown" || effect.publication !== "not_started"
  )
    throw Error("Original settled effect required");
  // The import's hardlink application, read back from data-manager by its key.
  const followUp =
    !links.revisionId ||
    (await inspectGenerationLinks({
      transport: links.transport,
      infraDir: links.infraDir,
      issuer: owner.execution,
      revisionId: links.revisionId,
    })) === "complete"
      ? ("complete" as const)
      : ("failed" as const);
  if (journal.phase === "restored")
    return {
      outcome: "not_committed" as const,
      reason: "failed" as const,
      cleanupFailed: journal.cleanupFailed,
    };
  return {
    outcome: "committed" as const,
    serviceId: journal.serviceId,
    artifactFingerprint: journal.artifactFingerprint,
    cleanupFailed: journal.cleanupFailed,
    followUp,
  };
}

/** A transfer claim may be released only after this exact import never began
 * publication and the original whole target tree is physically released. */
export async function inspectUnstartedArtifactImport(authority: ExecutionHandle) {
  const owner = authority;
  if (owner.kind !== "artifactTransfer.import" || readJournal({ ...owner, origin: owner.origin }))
    throw Error("Unstarted original import required");
  if (await executionEffectStarted(authority)) throw Error("Import publication began");
  const effect = await verifyControlEffectSettlement(
    owner.installation.installation,
    owner.execution,
  );
  if (
    !["failed_without_effect", "contained"].includes(effect.outcome) ||
    effect.publication !== "not_started"
  )
    throw Error("Unstarted import containment required");
  await verifyLocalArtifactTargetRootRelease(authority);
  return originalArtifactImportOperation(authority);
}

/** Actual fixed runtime has finished without starting publication. Freeze the
 * original issuer, prove every finite child unused, then retain nonissuance. */
export async function retainUnstartedArtifactImport(authority: ExecutionHandle) {
  const owner = authority;
  if (owner.kind !== "artifactTransfer.import" || readJournal({ ...owner, origin: owner.origin }))
    throw Error("Unstarted import required");
  if (await executionEffectStarted(authority)) throw Error("Import publication began");
  if ((await cancelControlExecution(authority)).length)
    throw Error("Original import child remains attempted");
  for (const slot of owner.reservations) {
    const source = await inspectControlChildPublication(authority, slot);
    if (source.binding !== null || source.publication.state !== "unissued")
      throw Error("Original import child remains attempted");
  }
  await retainControlEffectReceipt(authority, {
    outcome: "failed_without_effect",
    publication: "not_started",
    receipt: { kind: "not-started" },
  });
}

/** Fixed original body projection; callers cannot substitute stage/owner IDs. */
export function originalArtifactImportOperation(authority: ExecutionHandle) {
  const owner = authority;
  if (owner.kind !== "artifactTransfer.import") throw Error("Original import required");
  const operation = opsOperationSchema.parse(owner.operation);
  if (
    operation.kind !== "artifactTransfer.import" ||
    opsOperationFingerprint(operation) !== owner.execution.operationFingerprint
  )
    throw Error("Original import body required");
  return operation;
}

export function originalArtifactValidationOperation(authority: ExecutionHandle) {
  const owner = authority;
  if (
    owner.kind !== "artifactTransfer.validate" ||
    owner.installation.installation.role !== "ops-agent"
  )
    throw Error("Original validation required");
  const operation = opsOperationSchema.parse(owner.operation);
  if (
    operation.kind !== "artifactTransfer.validate" ||
    opsOperationFingerprint(operation) !== owner.execution.operationFingerprint ||
    owner.plan.length ||
    owner.reservations.length
  )
    throw Error("Original private-only validation body required");
  return operation;
}
/** This fixed private-only operation has no managed target or child. The live
 * store producer first proves its extraction is contained and cleaned. Match
 * its actual recorded effect result before upgrading only the retained knowledge;
 * the original public status tuple, deadline and timestamp remain unchanged. */
export async function assertKnownArtifactStageReceipt(authority: ExecutionHandle) {
  const owner = authority;
  if (!["artifactTransfer.import", "artifactTransfer.validate"].includes(owner.kind))
    throw Error("Original prepared purpose required");
  const effect = await verifyControlEffectSettlement(
    owner.installation.installation,
    owner.execution,
  );
  if (effect.outcome === "unknown" || effect.publication === "unknown")
    throw Error("Prepared purpose remains unknown");
  if (owner.kind === "artifactTransfer.import")
    await verifyLocalArtifactTargetRootRelease(authority);
}
