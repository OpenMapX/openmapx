/** Fixed candidate provenance for the data-manager transit phases. */
import { createHash } from "node:crypto";
import {
  constants as C,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { join, sep } from "node:path";
import { z } from "zod";
import type { OpsOperation } from "../ops/contract";
import { retainedParentExecutionSchema } from "../ops/execution-identity";
import { executionRefSchema } from "../ops/execution-ref";
import { canonicalJson } from "../ops/fingerprint";
// biome-ignore lint/suspicious/noImportCycles: Candidate snapshots and fixed proof publication share the original phase/authority; calls occur after schema initialization.
import { inspectControlChildPublication } from "./child-phase";
// biome-ignore-start lint/suspicious/noImportCycles: Nominal execution verification is reused by the fixed producer after module initialization.
import {
  assertControlExecutionForward,
  type ControlChildPhase,
  type ControlInstallation,
  controlChildOperationKey,
  controlDigest,
  executionAuthorityState,
  installationState,
  readPrivateRecord,
  retainedControlParent,
  type VerifiedExecutionAuthority,
  writePrivateRecord,
} from "./control-authority";
// biome-ignore-end lint/suspicious/noImportCycles: Shared original execution verification described above.
import {
  controlOriginSchema,
  originRecordDomain,
  sameControlOrigin,
  signControl,
  targetSchema,
  verifyControl,
} from "./control-records";
import { AnchoredDirectory, identity, sameInode } from "./filesystem";
import { familyRecordWrite, verifyFamilyOwnedRecord } from "./retention-family";

const schema = z.strictObject({
  version: z.literal(1),
  execution: executionRefSchema,
  phase: z.enum(["promote-primary", "proxy-stage", "proxy-commit", "proxy-restore"]),
  ordinal: z.number().int().min(0).max(31),
  candidateId: z.string(),
  directory: z.strictObject({ dev: z.string(), ino: z.string() }),
  consumer: z
    .strictObject({
      directory: z.strictObject({ dev: z.string(), ino: z.string() }),
      inode: z.strictObject({ dev: z.string(), ino: z.string() }),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .nullable(),
  artifactsDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  files: z
    .array(
      z.strictObject({
        name: z.string(),
        inode: z.strictObject({ dev: z.string(), ino: z.string() }),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .min(1)
    .max(2),
});
/** Data files intentionally have producer/consumer hardlinks. Authority record
 * readers retain their stricter single-link policy. Read identity and bytes
 * from one confined descriptor and detect replacement or mutation during it. */
function readCandidateFile(parent: AnchoredDirectory, name: string) {
  const path = parent.name(name),
    fd = openSync(path, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (
      !before.isFile() ||
      before.nlink < 1n ||
      before.uid !== BigInt(process.getuid?.() ?? -1) ||
      (before.mode & 0o022n) !== 0n ||
      before.size > 32n * 1024n * 1024n
    )
      throw Error("Unsafe or oversized candidate file");
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let count = 0;
    while (count < bytes.length) {
      const n = readSync(fd, bytes, count, bytes.length - count, null);
      if (!n) break;
      count += n;
    }
    const after = fstatSync(fd, { bigint: true });
    if (
      BigInt(count) !== before.size ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      !sameInode(identity(before), identity(lstatSync(path, { bigint: true })))
    )
      throw Error("Candidate inode/bytes changed during read");
    parent.check();
    return {
      inode: identity(before),
      sha256: createHash("sha256").update(bytes.subarray(0, count)).digest("hex"),
      bytes: bytes.subarray(0, count),
    };
  } finally {
    closeSync(fd);
  }
}
const artifactSchema = z.strictObject({
  path: z.string().min(1).max(255),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  sizeBytes: z.number().int().nonnegative().safe(),
});
/** The existing candidate writer verifies artifact hashes before retaining its
 * manifest. Bind all verified files' inode/change metadata into the signed
 * snapshot as well, so subsequent byte/inode changes cannot hide behind an
 * unchanged manifest. Paths are the finite manifest roles, never HTTP input. */
function candidateArtifacts(
  directory: AnchoredDirectory,
  manifestBytes: Buffer,
  executionId: string,
): string {
  const manifest = z
    .object({
      schemaVersion: z.literal(1),
      epoch: z.uuid(),
      artifacts: z.strictObject({
        config: artifactSchema,
        license: artifactSchema,
        proxyConfig: artifactSchema,
        proxyVars: artifactSchema,
        datasets: z.array(artifactSchema).min(1).max(16384),
        sourceIndex: artifactSchema.optional(),
        sourceManifest: artifactSchema,
      }),
    })
    .parse(JSON.parse(manifestBytes.toString("utf8")));
  if (manifest.epoch !== executionId)
    throw Error("Prepared candidate belongs to another execution");
  const a = manifest.artifacts;
  if (
    a.config.path !== "config.yml" ||
    a.license.path !== "license.json" ||
    a.proxyConfig.path !== ".openmapx-feed-proxy/conf/default.conf" ||
    a.proxyVars.path !== ".openmapx-feed-proxy/feed-proxy-vars.json" ||
    a.sourceManifest.path !== "transit-source-manifest.json" ||
    (a.sourceIndex && a.sourceIndex.path !== "gbfs-source-index.json") ||
    a.datasets.some((f) => !/^[^.][^/\\]*\.(gtfs|netex)\.zip$/i.test(f.path))
  )
    throw Error("Unexpected prepared candidate artifact role/path");
  const digest = createHash("sha256");
  for (const file of [
    a.config,
    a.license,
    a.proxyConfig,
    a.proxyVars,
    ...a.datasets,
    ...(a.sourceIndex ? [a.sourceIndex] : []),
    a.sourceManifest,
  ]) {
    const parts = file.path.split("/"),
      owned: AnchoredDirectory[] = [];
    let parent = directory;
    try {
      for (const part of parts.slice(0, -1)) {
        parent = parent.directory(part);
        owned.push(parent);
      }
      const path = parent.name(parts.at(-1)!);
      const fd = openSync(path, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
      try {
        const stat = fstatSync(fd, { bigint: true });
        if (
          !stat.isFile() ||
          stat.nlink < 1n ||
          stat.uid !== BigInt(process.getuid?.() ?? -1) ||
          (stat.mode & 0o022n) !== 0n ||
          stat.size !== BigInt(file.sizeBytes) ||
          !sameInode(identity(stat), identity(lstatSync(path, { bigint: true })))
        )
          throw Error("Prepared artifact inode/size/ownership changed");
        digest.update(
          canonicalJson({
            path: file.path,
            inode: identity(stat),
            size: String(stat.size),
            mtime: String(stat.mtimeNs),
            ctime: String(stat.ctimeNs),
          }),
        );
        parent.check();
      } finally {
        closeSync(fd);
      }
    } finally {
      for (const dir of owned.reverse()) dir.close();
    }
  }
  return digest.digest("hex");
}
function proxyConsumer(
  directory: AnchoredDirectory,
  producer: { inode: { dev: string; ino: string }; sha256: string },
) {
  const mounted = directory.directory("motis-feed-proxy-config");
  try {
    const file = readCandidateFile(mounted, "default.conf");
    if (!sameInode(file.inode, producer.inode) || file.sha256 !== producer.sha256)
      throw Error("Mounted proxy config differs from the original producer inode/bytes");
    return { directory: identity(mounted.stat), inode: file.inode, sha256: file.sha256 };
  } finally {
    mounted.close();
  }
}
function snapshot(
  authority: VerifiedExecutionAuthority,
  phase: ControlChildPhase,
  ordinal: number,
  preparing = false,
) {
  const s = executionAuthorityState(authority),
    slot =
      s.reservations.find((r) => r.phase === phase && r.ordinal === ordinal) ??
      s.plan.find((r) => r.phase === phase && r.ordinal === ordinal);
  if (
    !slot ||
    s.installation.installation.role !== "data-manager" ||
    !["transit-sync", "transit-maintenance"].includes(s.kind)
  )
    throw Error("Original data candidate reservation required");
  const proxy = ["proxy-stage", "proxy-commit", "proxy-restore"].includes(phase);
  if (!proxy && phase !== "promote-primary") return null;
  const relative = proxy ? "motis-feed-proxy" : `motis/${preparing ? "staging" : "live"}`;
  const root = realpathSync(s.installation.dataRoot),
    path = realpathSync(join(root, relative));
  if (!path.startsWith(root + sep)) throw Error("Candidate directory escaped data root");
  const directory = new AnchoredDirectory(path);
  try {
    const files = proxy
      ? [
          { name: "conf/default.conf", parts: ["conf", "default.conf"] },
          { name: "feed-proxy-vars.json", parts: ["feed-proxy-vars.json"] },
        ]
      : [{ name: "motis-candidate-manifest.json", parts: ["motis-candidate-manifest.json"] }];
    const retainedFiles = files.map(({ name, parts }) => {
      const nested = parts.length === 2 ? directory.directory(parts[0]!) : undefined;
      try {
        return { name, ...readCandidateFile(nested ?? directory, parts.at(-1)!) };
      } finally {
        nested?.close();
      }
    });
    return {
      version: 1 as const,
      execution: s.execution,
      phase,
      ordinal,
      candidateId: proxy
        ? `ctrl-${createHash("sha256").update(`openmapx-transit-candidate-v1\0${s.execution.operationKey}\0${phase}\0${ordinal}`).digest("hex").slice(0, 32)}`
        : s.execution.executionId,
      directory: identity(directory.stat),
      files: retainedFiles.map(({ name, inode, sha256 }) => ({ name, inode, sha256 })),
      consumer: proxy ? proxyConsumer(directory, retainedFiles[0]!) : null,
      artifactsDigest: proxy
        ? null
        : candidateArtifacts(directory, retainedFiles[0]!.bytes, s.execution.executionId),
    };
  } finally {
    directory.close();
  }
}
const name = (authority: VerifiedExecutionAuthority, ordinal: number) =>
  `candidate-${authority.execution.operationKey}-${ordinal}.json`;
export function retainOwnedDataTransitCandidate(
  authority: VerifiedExecutionAuthority,
  input: { phase: ControlChildPhase; ordinal: number },
): string | null {
  const value = snapshot(authority, input.phase, input.ordinal, input.phase === "promote-primary");
  if (!value) return null;
  const s = executionAuthorityState(authority),
    reserved = s.reservations.some(
      (slot) => slot.phase === input.phase && slot.ordinal === input.ordinal,
    ),
    publication = reserved ? inspectControlChildPublication(authority, input) : undefined;
  let saved: unknown;
  try {
    saved = readPrivateRecord(s.installation, "observations", name(authority, input.ordinal), 8192);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (saved !== null && saved !== undefined) {
    const prior = verifyControl(
      s.installation.installation.publicKey,
      "openmapx-data-candidate-v1",
      saved,
      schema,
    );
    if (canonicalJson(prior) !== canonicalJson(value))
      throw Error("Original candidate bytes/owner changed");
    publishCandidate(authority, prior);
    return controlDigest(prior);
  }
  if (publication && (publication.binding || publication.publication.state !== "unissued"))
    throw Error("Attempted candidate cannot be reconstructed");
  assertControlExecutionForward(authority);
  const parsed = schema.parse(value);
  writePrivateRecord(
    s.installation,
    "observations",
    name(authority, input.ordinal),
    signControl(s.installation.privateKey, "openmapx-data-candidate-v1", parsed),
    true,
    s.origin,
  );
  publishCandidate(authority, parsed);
  return controlDigest(parsed);
}
export function assertOwnedDataTransitCandidate(
  authority: VerifiedExecutionAuthority,
  input: { phase: ControlChildPhase; ordinal: number },
): string | null {
  const value = snapshot(authority, input.phase, input.ordinal);
  if (!value) return null;
  const s = executionAuthorityState(authority),
    saved = verifyControl(
      s.installation.installation.publicKey,
      "openmapx-data-candidate-v1",
      readPrivateRecord(s.installation, "observations", name(authority, input.ordinal), 8192),
      schema,
    );
  if (canonicalJson(saved) !== canonicalJson(value))
    throw Error("Foreign or changed owned transit candidate");
  return controlDigest(saved);
}

const publishedSchema = z.strictObject({
  version: z.literal(2),
  installationId: z.uuid(),
  origin: controlOriginSchema,
  candidate: schema,
  childOperationKey: z.string(),
  operationFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  serviceIds: targetSchema,
});
function sharedDirectory(local: ReturnType<typeof installationState>) {
  const data = new AnchoredDirectory(local.dataRoot),
    control = data.directory(".admin-target-control"),
    executions = control.directory("executions"),
    role = executions.directory("data-manager");
  return {
    role,
    close() {
      role.close();
      executions.close();
      control.close();
      data.close();
    },
  };
}
function publishCandidate(
  authority: VerifiedExecutionAuthority,
  candidate: z.infer<typeof schema>,
): void {
  const s = executionAuthorityState(authority),
    slot =
      s.reservations.find((r) => r.phase === candidate.phase && r.ordinal === candidate.ordinal) ??
      s.plan.find((r) => r.phase === candidate.phase && r.ordinal === candidate.ordinal);
  if (!slot || !s.origin) throw Error("Dated original candidate slot required");
  assertControlExecutionForward(authority);
  const payload = publishedSchema.parse({
      version: 2,
      installationId: s.installation.installation.installationId,
      origin: s.origin,
      candidate,
      childOperationKey: slot.execution.operationKey,
      operationFingerprint:
        "operationFingerprint" in slot
          ? slot.operationFingerprint
          : slot.execution.operationFingerprint,
      serviceIds: [...slot.serviceIds],
    }),
    bytes = canonicalJson(
      signControl(s.installation.privateKey, "openmapx-data-candidate-publication-v2", payload),
    ),
    directory = sharedDirectory(s.installation),
    name = `${slot.execution.operationKey}.data-candidate.json`;
  try {
    let prior: Buffer | undefined;
    try {
      prior = directory.role.read(name, 8192);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (prior) {
      if (prior.toString("utf8") !== bytes) throw Error("Original published candidate changed");
      verifyFamilyOwnedRecord(
        s.installation,
        s.origin,
        { scope: "shared", namespace: "execution", container: "data-manager", name },
        bytes,
      );
      return;
    }
    familyRecordWrite(
      s.installation,
      s.origin,
      { scope: "shared", namespace: "execution", container: "data-manager", name },
      bytes,
      (before) => directory.role.write(name, bytes, true, before),
      true,
    );
  } finally {
    directory.close();
  }
}
/** Fixed registry resource input. This reads shared signed evidence, never a
 * sibling role's private state, and never authorizes execution by itself. */
export function inspectDataTransitCandidate(
  installation: ControlInstallation,
  operationKey: string,
  operation: OpsOperation,
) {
  if (
    installation.role !== "ops-agent" ||
    (operation.kind !== "motis.primary.promote" && operation.kind !== "feedProxy.validateAndReload")
  )
    throw Error("Fixed transit candidate required");
  const local = installationState(installation),
    directory = sharedDirectory(local);
  try {
    const proof = verifyControl(
        local.publicKeys["data-manager"],
        "openmapx-data-candidate-publication-v2",
        JSON.parse(
          directory.role.read(`${operationKey}.data-candidate.json`, 8192).toString("utf8"),
        ),
        publishedSchema,
      ),
      candidate = proof.candidate;
    if (
      proof.installationId !== installation.installationId ||
      proof.childOperationKey !== operationKey ||
      proof.operationFingerprint !== controlDigest(operation) ||
      operationKey !==
        controlChildOperationKey(
          candidate.execution.operationKey,
          candidate.phase,
          candidate.ordinal,
        ) ||
      candidate.execution.executor !== "data-manager"
    )
      throw Error("Original candidate parent/phase/body changed");
    const promotion = operation.kind === "motis.primary.promote";
    if (
      promotion
        ? candidate.phase !== "promote-primary" ||
          candidate.candidateId !== operation.preparedRunId ||
          candidate.candidateId !== candidate.execution.executionId ||
          canonicalJson(proof.serviceIds) !== canonicalJson(["motis"])
        : !["proxy-stage", "proxy-commit", "proxy-restore"].includes(candidate.phase) ||
          candidate.candidateId !== operation.candidateId ||
          canonicalJson(proof.serviceIds) !== canonicalJson(["motis-feed-proxy"])
    )
      throw Error("Candidate identity/target mismatch");
    const root = realpathSync(local.dataRoot),
      path = realpathSync(join(root, promotion ? "motis/live" : "motis-feed-proxy"));
    if (!path.startsWith(root + sep)) throw Error("Candidate escaped data root");
    const confined = new AnchoredDirectory(path);
    try {
      if (canonicalJson(identity(confined.stat)) !== canonicalJson(candidate.directory))
        throw Error("Candidate directory replaced");
      const expected = promotion
        ? ["motis-candidate-manifest.json"]
        : ["conf/default.conf", "feed-proxy-vars.json"];
      if (canonicalJson(candidate.files.map((f) => f.name)) !== canonicalJson(expected))
        throw Error("Candidate files changed");
      let manifestBytes: Buffer | undefined;
      for (const file of candidate.files) {
        const parts = file.name.split("/"),
          nested = parts.length === 2 ? confined.directory(parts[0]!) : undefined,
          parent = nested ?? confined;
        try {
          const current = readCandidateFile(parent, parts.at(-1)!);
          if (
            canonicalJson(current.inode) !== canonicalJson(file.inode) ||
            current.sha256 !== file.sha256
          )
            throw Error("Candidate inode/bytes replaced");
          if (promotion) manifestBytes = current.bytes;
        } finally {
          nested?.close();
        }
      }
      if (promotion) {
        if (
          !manifestBytes ||
          candidate.consumer !== null ||
          candidateArtifacts(confined, manifestBytes, candidate.execution.executionId) !==
            candidate.artifactsDigest
        )
          throw Error("Prepared candidate artifacts changed");
      } else if (
        candidate.artifactsDigest !== null ||
        canonicalJson(proxyConsumer(confined, candidate.files[0]!)) !==
          canonicalJson(candidate.consumer)
      )
        throw Error("Mounted candidate inode/bytes replaced");
    } finally {
      confined.close();
    }
    return { digest: controlDigest(proof), proof };
  } finally {
    directory.close();
  }
}
/** Recheck the actual admitted parent, target lease and snapshot at each fixed
 * Docker effect boundary; a previously returned resource claim is insufficient. */
export function verifyDataTransitCandidateForExecution(
  authority: VerifiedExecutionAuthority,
  operation: OpsOperation,
  expectedDigest: string,
): void {
  const s = executionAuthorityState(authority),
    checked = inspectDataTransitCandidate(
      s.installation.installation,
      s.execution.operationKey,
      operation,
    ),
    raw = readPrivateRecord(
      s.installation,
      "executions",
      `${s.execution.operationKey}.json`,
      65536,
    ),
    admission = verifyControl(
      s.installation.installation.publicKey,
      originRecordDomain("openmapx-control-execution", raw),
      raw,
      z.object({ parent: retainedParentExecutionSchema }).passthrough(),
    );
  if (
    controlDigest(raw) !== s.receiptDigest ||
    checked.digest !== expectedDigest ||
    canonicalJson(admission.parent) !==
      canonicalJson(retainedControlParent(checked.proof.candidate.execution)) ||
    !sameControlOrigin(checked.proof.origin, s.origin) ||
    canonicalJson(s.serviceIds) !== canonicalJson(checked.proof.serviceIds)
  )
    throw Error("Candidate differs from original borrowed admission");
}
export function assertDataTransitCandidateForExecution(
  authority: VerifiedExecutionAuthority,
  operation: OpsOperation,
  expectedDigest: string,
): void {
  verifyDataTransitCandidateForExecution(authority, operation, expectedDigest);
  assertControlExecutionForward(authority);
}
