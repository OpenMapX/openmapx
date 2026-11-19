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
import { readCatalogProposalFile, readCatalogValidationFile } from "../catalog-pins/record-files";
import { canonicalJson } from "../ops/canonical-json";
import { pairedPinApprovalInputSchema } from "../ops/catalog-pin-approval";
import type { OpsOperation } from "../ops/contract";
import { retainedParentExecutionSchema } from "../ops/execution-identity";
import { type ExecutionRef, executionRefSchema } from "../ops/execution-ref";
import { opsOperationFingerprint } from "../ops/fingerprint";
import {
  type ControlInstallation,
  controlDigest,
  controlOriginSchema,
  sameControlOrigin,
} from "./control-records";
import {
  assertControlExecutionForward,
  type ExecutionHandle,
  inspectControlChildPublication,
  retainedControlParent,
  withControlExecutionForward,
} from "./execution-record";
import { AnchoredDirectory, identity, sameInode } from "./filesystem";
import { type ControlChildPhase, controlChildOperationKey, localLeases } from "./lease-store";
import { installationState, readPrivateRecord, writePrivateRecord } from "./private-records";

const schema = z.strictObject({
  version: z.literal(1),
  execution: executionRefSchema,
  phase: z.enum(["promote-primary", "proxy-stage", "proxy-commit", "proxy-restore"]),
  ordinal: z.number().int().min(0).max(31),
  catalogActivation: z
    .strictObject({
      proposalId: z.uuid(),
      validationId: z.uuid(),
      validationDigest: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .optional(),
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
 * manifest. Bind all verified files' inode/change metadata into the retained
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
function catalogRecordSource(state: ReturnType<typeof installationState>) {
  return { dataRoot: state.dataRoot };
}
function catalogActivationCandidate(s: ExecutionHandle) {
  if (s.kind !== "catalog.activate") return undefined;
  const admitted = { operation: z.record(z.string(), z.unknown()).parse(s.operation) };
  if (
    controlDigest(admitted.operation) !== s.execution.operationFingerprint ||
    admitted.operation.kind !== "catalog.activate"
  )
    throw Error("Original activation body required");
  const input = pairedPinApprovalInputSchema.parse({
    ...admitted.operation,
    kind: "transitousLock.approve",
  });
  const validation = readCatalogValidationFile(
    catalogRecordSource(s.installation),
    input.proposalId,
    input.validationId,
  );
  if (
    validation.validation.status !== "passed" ||
    validation.validation.diffDigest !== input.diffDigest ||
    !input.acknowledgeLicenseChanges
  )
    throw Error("Passing reviewed validation required");
  return {
    proposalId: input.proposalId,
    validationId: input.validationId,
    validationDigest: controlDigest(validation),
  };
}
function verifyCatalogActivationCandidate(
  installation: ControlInstallation,
  candidate: z.infer<typeof schema>,
) {
  const selected = candidate.catalogActivation;
  if (!selected) return candidate.execution.executionId;
  const validation = readCatalogValidationFile(
      catalogRecordSource(installationState(installation)),
      selected.proposalId,
      selected.validationId,
    ),
    proposal = readCatalogProposalFile(
      catalogRecordSource(installationState(installation)),
      selected.proposalId,
    );
  if (
    !proposal ||
    validation.validation.status !== "passed" ||
    controlDigest(validation) !== selected.validationDigest ||
    controlDigest(proposal) !== validation.proposalDigest ||
    validation.validation.pinDigest !== proposal.pins.generationId ||
    controlDigest({
      kind: "catalog.activate",
      proposalId: selected.proposalId,
      validationId: selected.validationId,
      expectedGenerationId: proposal.baseGenerationId,
      diffDigest: proposal.diffDigest,
      acknowledgeLicenseChanges: true,
    }) !== candidate.execution.operationFingerprint
  )
    throw Error("Activation candidate differs from its original validation/proposal/body");
  if (
    candidate.phase === "promote-primary" &&
    candidate.files[0]?.sha256 !== validation.validation.manifestHash
  )
    throw Error("Promotion manifest differs from its passed validation");
  return selected.validationId;
}
function snapshot(
  authority: ExecutionHandle,
  phase: ControlChildPhase,
  ordinal: number,
  preparing = false,
) {
  const s = authority,
    slot =
      s.reservations.find((r) => r.phase === phase && r.ordinal === ordinal) ??
      s.plan.find((r) => r.phase === phase && r.ordinal === ordinal);
  if (
    !slot ||
    s.installation.installation.role !== "data-manager" ||
    !["transit-sync", "transit-maintenance", "catalog.validate", "catalog.activate"].includes(
      s.kind,
    )
  )
    throw Error("Original data candidate reservation required");
  const activation = catalogActivationCandidate(s);
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
      ...(activation ? { catalogActivation: activation } : {}),
      candidateId: proxy
        ? `ctrl-${createHash("sha256").update(`openmapx-transit-candidate-v1\0${s.execution.operationKey}\0${phase}\0${ordinal}`).digest("hex").slice(0, 32)}`
        : (activation?.validationId ?? s.execution.executionId),
      directory: identity(directory.stat),
      files: retainedFiles.map(({ name, inode, sha256 }) => ({ name, inode, sha256 })),
      consumer: proxy ? proxyConsumer(directory, retainedFiles[0]!) : null,
      artifactsDigest: proxy
        ? null
        : candidateArtifacts(
            directory,
            retainedFiles[0]!.bytes,
            activation?.validationId ?? s.execution.executionId,
          ),
    };
  } finally {
    directory.close();
  }
}
const name = (authority: ExecutionHandle, ordinal: number) =>
  `candidate-${authority.execution.operationKey}-${ordinal}.json`;
export async function retainOwnedDataTransitCandidate(
  authority: ExecutionHandle,
  input: { phase: ControlChildPhase; ordinal: number },
): Promise<string | null> {
  const value = snapshot(authority, input.phase, input.ordinal, input.phase === "promote-primary");
  if (!value) return null;
  const s = authority,
    reserved = s.reservations.some(
      (slot) => slot.phase === input.phase && slot.ordinal === input.ordinal,
    ),
    publication = reserved ? await inspectControlChildPublication(authority, input) : undefined;
  let saved: unknown;
  try {
    saved = readPrivateRecord(s.installation, "observations", name(authority, input.ordinal), 8192);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (saved !== null && saved !== undefined) {
    const prior = schema.parse(saved);
    if (canonicalJson(prior) !== canonicalJson(value))
      throw Error("Original candidate bytes/owner changed");
    return controlDigest(prior);
  }
  if (publication && (publication.binding || publication.publication.state !== "unissued"))
    throw Error("Attempted candidate cannot be reconstructed");
  await assertControlExecutionForward(authority);
  const parsed = schema.parse(value);
  writePrivateRecord(s.installation, "observations", name(authority, input.ordinal), parsed, true);
  return controlDigest(parsed);
}
export function assertOwnedDataTransitCandidate(
  authority: ExecutionHandle,
  input: { phase: ControlChildPhase; ordinal: number },
): string | null {
  const value = snapshot(authority, input.phase, input.ordinal);
  if (!value) return null;
  const s = authority,
    saved = schema.parse(
      readPrivateRecord(s.installation, "observations", name(authority, input.ordinal), 8192),
    );
  if (canonicalJson(saved) !== canonicalJson(value))
    throw Error("Foreign or changed owned transit candidate");
  return controlDigest(saved);
}

/** The candidate on the child's row; the row itself names the child, its body and targets. */
const publishedSchema = z.strictObject({ candidate: schema });
/**
 * The candidate a transit phase acts on, as the agent receives it with the
 * child's grant. Null when the phase has no retained candidate.
 */
export function publishedDataTransitCandidate(
  authority: ExecutionHandle,
  input: { phase: ControlChildPhase; ordinal: number },
): Record<string, unknown> | undefined {
  const s = authority;
  let saved: unknown;
  try {
    saved = readPrivateRecord(s.installation, "observations", name(authority, input.ordinal), 8192);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const candidate = schema.parse(saved);
  const slot =
    s.reservations.find((r) => r.phase === candidate.phase && r.ordinal === candidate.ordinal) ??
    s.plan.find((r) => r.phase === candidate.phase && r.ordinal === candidate.ordinal);
  if (!slot || candidate.phase !== input.phase)
    throw Error("Dated original candidate slot required");
  return publishedSchema.parse({ candidate });
}
/**
 * Fixed registry resource input: the candidate data-manager recorded with the
 * child's grant in the lease store, re-checked against the files. It never
 * authorizes execution by itself.
 */
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
  const local = installationState(installation);
  const leases = localLeases(local.leases);
  if (!leases) throw Error("This role cannot read delegations");
  const grant = leases
    .listSync()
    .flatMap((lease) => lease.children)
    .find(
      (child) => child.execution.operationKey === operationKey && child.recipient === "ops-agent",
    );
  if (!grant?.evidence) throw Error("Transit candidate missing from the child grant");
  const candidate = publishedSchema.parse(grant.evidence).candidate,
    proof = { candidate, serviceIds: grant.targets };
  if (
    grant.execution.operationFingerprint !== controlDigest(operation) ||
    operationKey !==
      controlChildOperationKey(
        candidate.execution.operationKey,
        candidate.phase,
        candidate.ordinal,
      ) ||
    candidate.execution.executor !== "data-manager"
  )
    throw Error("Original candidate parent/phase/body changed");
  const expectedEpoch = verifyCatalogActivationCandidate(installation, candidate);
  const promotion = operation.kind === "motis.primary.promote";
  if (
    promotion
      ? candidate.phase !== "promote-primary" ||
        candidate.candidateId !== operation.preparedRunId ||
        candidate.candidateId !== expectedEpoch ||
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
        candidateArtifacts(confined, manifestBytes, expectedEpoch) !== candidate.artifactsDigest
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
}
/** Recheck the actual admitted parent, target lease and snapshot at each fixed
 * Docker effect boundary; a previously returned resource claim is insufficient. */
export function verifyDataTransitCandidateForExecution(
  authority: ExecutionHandle,
  operation: OpsOperation,
  expectedDigest: string,
): void {
  const s = authority,
    checked = inspectDataTransitCandidate(
      s.installation.installation,
      s.execution.operationKey,
      operation,
    ),
    admission = { parent: retainedParentExecutionSchema.parse(s.parent) };
  if (
    checked.digest !== expectedDigest ||
    canonicalJson(admission.parent) !==
      canonicalJson(retainedControlParent(checked.proof.candidate.execution)) ||
    canonicalJson(s.serviceIds) !== canonicalJson(checked.proof.serviceIds)
  )
    throw Error("Candidate differs from original borrowed admission");
}
export async function assertDataTransitCandidateForExecution(
  authority: ExecutionHandle,
  operation: OpsOperation,
  expectedDigest: string,
): Promise<void> {
  verifyDataTransitCandidateForExecution(authority, operation, expectedDigest);
  await assertControlExecutionForward(authority);
}

/** Fixed proxy proof helpers share the original candidate verifier and indexed
 * effect writer. Their private schemas initialize here; no authority is created. */
export const {
  feedProxyValidationCompletionDigest,
  reserveFeedProxyValidation,
  commitFeedProxyValidationFailure,
  recordFeedProxyReloadAttempted,
  inspectFeedProxyValidationFailure,
} = (() => {
  const digest = z.string().regex(/^[a-f0-9]{64}$/);
  const schema = z
    .strictObject({
      version: z.literal(2),
      origin: controlOriginSchema,
      execution: executionRefSchema,
      admissionDigest: digest,
      candidateId: z.string().max(64),
      candidateDigest: digest,
      reservedAt: z.number().int().nonnegative().safe(),
      phase: z.enum(["validation_pending", "validation_failed", "reload_started"]),
      completedAt: z.number().int().nonnegative().safe().nullable(),
      validationExitCode: z.number().int().min(1).max(255).nullable(),
      completionDigest: digest.nullable(),
      padding: z.string().max(4096),
    })
    .superRefine((p, ctx) => {
      if (
        (p.phase === "validation_failed") !==
          (p.validationExitCode !== null && p.completionDigest !== null) ||
        (p.phase === "validation_pending") !== (p.completedAt === null)
      )
        ctx.addIssue({ code: "custom", message: "Invalid fixed validation phase" });
    });
  type Proof = z.infer<typeof schema>;
  const name = (authority: ExecutionHandle) =>
    `proxy-validation-${authority.execution.operationKey}.json`;
  function state(authority: ExecutionHandle) {
    const s = authority;
    if (
      s.installation.installation.role !== "ops-agent" ||
      s.kind !== "feedProxy.validateAndReload"
    )
      throw Error("Original fixed proxy authority required");
    return s;
  }
  function read(authority: ExecutionHandle) {
    const s = state(authority),
      raw = readPrivateRecord(s.installation, "observations", name(authority), 4096);
    const p = schema.parse(raw);
    if (
      !sameControlOrigin(p.origin, s.origin) ||
      p.admissionDigest !== s.receiptDigest ||
      controlDigest(p.execution) !== controlDigest(s.execution) ||
      opsOperationFingerprint({
        kind: "feedProxy.validateAndReload",
        candidateId: p.candidateId,
      }) !== s.execution.operationFingerprint
    )
      throw Error("Original validation proof identity changed");
    return p;
  }
  function write(authority: ExecutionHandle, value: Proof, exclusive = false) {
    const s = state(authority),
      p = { ...value, padding: "" };
    const room = 4096 - Buffer.byteLength(canonicalJson(p));
    if (room < 0) throw Error("Validation proof capacity exceeded");
    p.padding = " ".repeat(room);
    const parsed = schema.parse(p);
    writePrivateRecord(s.installation, "observations", name(authority), parsed, exclusive);
  }
  function feedProxyValidationCompletionDigest(
    execution: ExecutionRef,
    candidateDigest: string,
    nonce: string,
    validationExitCode: number,
  ): string {
    return controlDigest({
      domain: "openmapx-feed-proxy-validation-completion-v1",
      execution,
      candidateDigest,
      nonce,
      validationExitCode,
    });
  }
  async function reserveFeedProxyValidation(
    authority: ExecutionHandle,
    candidateId: string,
    candidateDigest: string,
  ): Promise<void> {
    const s = state(authority);
    await assertControlExecutionForward(authority);
    verifyDataTransitCandidateForExecution(
      authority,
      { kind: "feedProxy.validateAndReload", candidateId },
      candidateDigest,
    );
    {
      let raw: unknown;
      try {
        raw = readPrivateRecord(s.installation, "observations", name(authority), 4096);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (raw !== null && raw !== undefined) {
        const prior = read(authority);
        if (prior.candidateId !== candidateId || prior.candidateDigest !== candidateDigest)
          throw Error("Validation candidate changed");
        return;
      }
      write(
        authority,
        schema.parse({
          version: 2,
          origin: s.origin,
          execution: s.execution,
          admissionDigest: s.receiptDigest,
          candidateId,
          candidateDigest,
          reservedAt: Date.now(),
          phase: "validation_pending",
          completedAt: null,
          validationExitCode: null,
          completionDigest: null,
          padding: "",
        }),
        true,
      );
    }
  }
  function commitFeedProxyValidationFailure(
    authority: ExecutionHandle,
    input: { candidateDigest: string; validationExitCode: number; completionDigest: string },
  ): void {
    state(authority);
    {
      const p = read(authority);
      if (p.candidateDigest !== input.candidateDigest) throw Error("Foreign validation candidate");
      if (p.phase === "validation_failed") {
        if (
          p.validationExitCode !== input.validationExitCode ||
          p.completionDigest !== input.completionDigest
        )
          throw Error("Validation commitment changed");
        return;
      }
      if (p.phase !== "validation_pending") throw Error("Reload already attempted");
      // A new producer commitment verifies the actual invocation's bytes. An
      // identical existing commitment above observes its frozen original proof,
      // which remains valid after a later legitimate restore replaces files.
      verifyDataTransitCandidateForExecution(
        authority,
        { kind: "feedProxy.validateAndReload", candidateId: p.candidateId },
        p.candidateDigest,
      );
      write(
        authority,
        schema.parse({ ...p, ...input, phase: "validation_failed", completedAt: Date.now() }),
      );
    }
  }
  function recordFeedProxyReloadAttempted(authority: ExecutionHandle): void {
    state(authority);
    const p = read(authority);
    if (p.phase !== "validation_pending") throw Error("Validation phase already consumed");
    verifyDataTransitCandidateForExecution(
      authority,
      { kind: "feedProxy.validateAndReload", candidateId: p.candidateId },
      p.candidateDigest,
    );
    write(authority, { ...p, phase: "reload_started", completedAt: Date.now() });
  }
  /** Frozen original proof stays valid after a legitimate restore replaces files. */
  function inspectFeedProxyValidationFailure(
    authority: ExecutionHandle,
    expectedDigest?: string,
  ): string | null {
    const p = read(authority);
    if (p.phase !== "validation_failed") return null;
    const proofDigest = controlDigest(p);
    if (expectedDigest !== undefined && expectedDigest !== proofDigest)
      throw Error("Foreign validation commitment");
    return proofDigest;
  }

  return {
    feedProxyValidationCompletionDigest,
    reserveFeedProxyValidation,
    commitFeedProxyValidationFailure,
    recordFeedProxyReloadAttempted,
    inspectFeedProxyValidationFailure,
  };
})();
/** Records that the proxy reload began, while the execution may still go forward. */
export async function markFeedProxyReloadAttempted(authority: ExecutionHandle): Promise<void> {
  await withControlExecutionForward(authority, () => recordFeedProxyReloadAttempted(authority));
}
