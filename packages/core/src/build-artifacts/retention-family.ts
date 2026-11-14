/** Fixed, role-local receipt ownership and preallocated per-origin retirement cells. */
import { createHash, randomUUID } from "node:crypto";
import { fsyncSync, mkdirSync } from "node:fs";
import { z } from "zod";
import { canonicalJson } from "../ops/canonical-json";
import type { ControlExecutionOrigin } from "../ops/control-root-key";
import type {
  ControlIssuer,
  ExecutionRef,
  RetainedParentExecution,
} from "../ops/execution-identity";
import {
  assertConfigurationMaintenanceDecisionSource,
  configurationMaintenanceOwnerRecordSchema,
  configurationMaintenanceReleasedOwner,
  configurationMaintenanceSettleCompletion,
} from "./configuration-maintenance-owner-records";
// biome-ignore-start lint/suspicious/noImportCycles: Indexed completion repair and retirement require actual nominal authority from the same record owner. Parsed roots or caller flags cannot replace it; all calls are deferred.
import {
  executionAuthorityState,
  readPrivateRecord,
  type VerifiedExecutionAuthority,
  withPrivateEffectWriter,
} from "./control-authority";
// biome-ignore-end lint/suspicious/noImportCycles: Exact deferred original-owner/index guard join.
import {
  controlDigest,
  controlOriginSchema,
  type InstallationState,
  signControl,
  verifyControl,
} from "./control-records";
import {
  CONTROL_RETENTION_LIMITS,
  deleteRetainedRecord,
  finishRetainedDeletion,
  CONTROL_RETENTION_LIMITS as LIMITS,
} from "./control-retention";
import {
  type ControlRetentionPreparationContext,
  coordinatorPullBaselineSchema,
  type StagedCoordinatorRetirementPacket,
  stagedCoordinatorRetirementDomain,
  stagedCoordinatorRetirementPacketSchema,
  stagedCoordinatorRetirementPayloadSchema,
} from "./coordinator-pull-records";
import {
  AnchoredDirectory,
  acquireGuardDirectory,
  type FileIdentity,
  identity,
  sameInode,
} from "./filesystem";
import { advanceRetentionClock, readRetentionClock } from "./retention-clock";
// biome-ignore-start lint/suspicious/noImportCycles: Index repair verifies actual physical release/full closure; physical closure verifies this same index. No constructor or verifier runs at module initialization.
import { verifyRetainedArtifactTargetRootRelease } from "./target-lease";

// biome-ignore-end lint/suspicious/noImportCycles: Exact deferred original-owner/index guard join.

const ROLES = ["ops-agent", "data-manager", "host-cli"] as const;
const PRIVATE = new Set([
  "executions",
  "children",
  "child-keys",
  "effects",
  "effect-started",
  "observations",
  "leases",
  "execution-leases",
  "attempts",
  "adoptions",
  "parent-attempts",
  "parent-adoptions",
  "execution-parents",
  "execution-lifecycle",
  "lifecycle-observations",
  "spawns",
  "spawn-started",
  "prepared",
  "execution-adoptions",
  "configuration-maintenance",
  "hardlinks",
  "catalog-commits",
]);
const recordMaximum = (record: { scope: string; namespace: string }) =>
  record.scope === "shared" && record.namespace === "service-lifecycle"
    ? 65536
    : record.scope === "private" && record.namespace === "hardlinks"
      ? 1024 * 1024
      : LIMITS.privateRecordBytes;
const SHARED = new Set([
  "service-lifecycle",
  "execution",
  "lease-owner",
  "lease-grants",
  "lease-children",
  "lease-directory",
  "history-slot",
]);
const originSchema = controlOriginSchema;
const identitySchema = z.strictObject({
  dev: z.string().regex(/^\d+$/),
  ino: z.string().regex(/^\d+$/),
});
const sharedIdentitySchema = z.strictObject({
  version: z.literal(1),
  installationId: z.uuid(),
  origin: originSchema,
  familyId: z.uuid(),
  generation: z.uuid(),
  dataRootIdentity: identitySchema,
  sharedIdentity: identitySchema,
});
type SharedIdentity = z.infer<typeof sharedIdentitySchema>;
type Phase = "active" | "prepared" | "ready" | "committed" | "clean" | "final" | "released";
export interface FamilyRecord {
  scope: "private" | "shared";
  namespace: string;
  name: string;
  container: string;
  digest: string;
  inode: FileIdentity;
  ordinal: number;
  state: "reserved" | "prepared" | "written";
  counted: boolean;
  directory: boolean;
  generation?: string;
}
interface ExecutionFact {
  execution: ExecutionRef;
  verifier: string;
  receiptDigest: string;
  terminalDigest?: string;
  settlementDigest?: string;
  canonicalDigest?: string;
  canonicalTerminalAt?: number;
  terminalAt?: number;
  known: boolean;
  fixedChildId?: string;
  requiresJournal?: boolean;
  journalContained?: boolean;
}
interface IntentFact {
  id: string;
  childDigest: string;
  recipient: ControlIssuer;
}
interface LeaseFact {
  id: string;
  certificateDigest: string;
  ownerRole: ControlIssuer;
  released: boolean;
}
interface ApiDependency {
  parent: Extract<RetainedParentExecution, { issuer: "api" }>;
  operationKey: string;
  fingerprint: string;
}
interface Progress {
  version: 1;
  familyId: string;
  generation: string;
  sequence: number;
  phase: Phase;
  records: number;
  sharedRecords: number;
  metadataBytes: number;
  executions: Record<string, ExecutionFact>;
  intents: Record<string, IntentFact>;
  leases: Record<string, LeaseFact>;
  participants: ControlIssuer[];
  terminalAt: number;
  api?: ApiDependency;
  apiAck?: { terminalDigest: string; proofDigest: string };
  stagedCoordinatorRevalidation?: StagedCoordinatorRetirementPacket;
  cursor: number;
  sharedCursor: number;
  manifestDigest?: string;
  lastDone?: {
    namespace: string;
    ordinal: number;
    name: string;
    digest: string;
    inode: FileIdentity;
  };
  sharedTransaction?: { ordinal: number; phase: "planned" | "unlinked"; record: FamilyRecord };
  sharedRelease?: boolean;
  journalCleanupPlanned?: boolean;
  journalClean?: boolean;
  lastError?: string;
}
interface Candidate {
  version: 1;
  installationId: string;
  familyId: string;
  generation: string;
  role: ControlIssuer;
  originDigest: string;
  terminalAt: number;
  terminalSequenceDigest: string;
  executionReceiptDigests: Record<string, string>;
  localRecordSetDigest: string;
  sharedRecordSetDigest: string;
  leaseDigests: Record<string, string>;
  intentDigests: Record<string, string>;
  stagedCoordinatorDependency?: StagedCoordinatorRetirementPacket;
}
const apiCopySchema = z.strictObject({
  version: z.literal(1),
  installationId: z.uuid(),
  familyId: z.uuid(),
  generation: z.uuid(),
  originDigest: z.string().regex(/^[a-f0-9]{64}$/),
  parentDigest: z.string().regex(/^[a-f0-9]{64}$/),
  operationKey: z.string(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  terminalDigest: z.string().regex(/^[a-f0-9]{64}$/),
  proofDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
function apiCopy(f: Family, p: Progress) {
  const raw = json<unknown>(f.shared, "api-ack.json", 4096);
  if (raw === null) return null;
  const value = verifyControl(
    f.state.publicKeys[f.meta.origin.issuer],
    "openmapx-retention-api-copy-v1",
    raw,
    apiCopySchema,
  );
  sameFamily(f, value);
  if (
    value.installationId !== f.meta.installationId ||
    !p.api ||
    value.parentDigest !== controlDigest(p.api.parent) ||
    value.operationKey !== p.api.operationKey ||
    value.fingerprint !== p.api.fingerprint
  )
    throw Error("Invalid API retirement acknowledgement");
  return value;
}
interface Manifest {
  version: 1;
  installationId: string;
  origin: ControlExecutionOrigin;
  familyId: string;
  generation: string;
  sequence: number;
  terminalAt: number;
  terminalSequenceDigest: string;
  participants: string[];
  executionReceiptDigests: Record<string, string>;
  sharedRecordSetDigest: string;
  localRecordSetDigests: Record<string, string>;
  stagedCoordinatorDependencyDigest?: string;
}
interface Decision {
  version: 1;
  familyId: string;
  generation: string;
  phase: "active" | "prepared" | "committed" | "final";
  manifestDigest?: string;
  readyDigests?: Record<string, string>;
  cleanDigests?: Record<string, string>;
  stagedCoordinatorRevalidationDigest?: string;
  sequence: number;
}
interface Ack {
  version: 1;
  installationId: string;
  familyId: string;
  generation: string;
  originDigest: string;
  manifestDigest: string;
  role: ControlIssuer;
  phase: "ready" | "clean" | "released";
  terminalSequenceDigest: string;
  recordSetDigest: string;
  proofCopyDigest: string;
  sequence: number;
}
interface Family {
  state: InstallationState;
  root: AnchoredDirectory;
  slots: AnchoredDirectory;
  slot: AnchoredDirectory;
  sharedRoot: AnchoredDirectory;
  shared: AnchoredDirectory;
  meta: SharedIdentity;
  name: string;
  slotIdentity: FileIdentity;
  slotGeneration: string;
  originHash: string;
  sharedGone?: boolean;
  close(): void;
}
type PreparationMode = "preparing" | "before-commit" | "committed-cleanup";
const preparationContexts = new WeakMap<
  ControlRetentionPreparationContext,
  {
    family: Family;
    sequence: number;
    mode: PreparationMode;
    nonce: string;
    manifestDigest: string | null;
    createdAt: number;
    packet?: StagedCoordinatorRetirementPacket;
    consumed: boolean;
  }
>();
function preparationContext(value: ControlRetentionPreparationContext) {
  const state = preparationContexts.get(value);
  if (!state || readProgress(state.family).sequence !== state.sequence)
    throw Error("Actual current collector context required");
  checkLocalIdentity(state.family);
  return state;
}
export function controlRetentionPreparationState(value: ControlRetentionPreparationContext) {
  const state = preparationContext(value),
    f = state.family,
    p = readProgress(f);
  return {
    mode: state.mode,
    installationId: f.meta.installationId,
    role: f.state.installation.role,
    origin: structuredClone(f.meta.origin),
    originDigest: f.originHash,
    familyId: f.meta.familyId,
    generation: f.meta.generation,
    executions: Object.entries(p.executions)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([digest, fact]) => ({
        digest,
        execution: structuredClone(fact.execution),
        terminalDigest: fact.terminalDigest ?? null,
        requiresJournal: fact.requiresJournal ?? false,
      })),
    progressSequence: state.sequence,
    manifestDigest: state.manifestDigest,
    checkNonce: state.nonce,
  };
}
function verifiedStagedRetirementPacket(f: Family, p: Progress, raw: unknown) {
  const packet = stagedCoordinatorRetirementPacketSchema.parse(raw),
    value = verifyControl(
      f.state.publicKeys["ops-agent"],
      stagedCoordinatorRetirementDomain,
      packet,
      stagedCoordinatorRetirementPayloadSchema,
    ),
    fact = p.executions[controlDigest(value.execution)];
  if (
    f.state.installation.role !== "ops-agent" ||
    value.installationId !== f.meta.installationId ||
    value.originDigest !== f.originHash ||
    value.familyId !== f.meta.familyId ||
    value.generation !== f.meta.generation ||
    !fact ||
    canonicalJson(fact.execution) !== canonicalJson(value.execution) ||
    !fact.known ||
    !fact.journalContained ||
    value.terminalDigest !== fact.terminalDigest ||
    value.terminalDigest !== fact.canonicalDigest ||
    value.sourceAdmissionDigest !== fact.receiptDigest ||
    value.rank.operationKey !== value.execution.operationKey
  )
    throw Error("Original staged retirement family membership changed");
  return { packet, value, fact };
}
/** The literal fixed producer supplies a signed observation, never a caller
 * boolean. This recorder binds it to the collector's exact live sequence. */
export function recordStagedCoordinatorRetentionCheck(
  context: ControlRetentionPreparationContext,
  raw: unknown,
): void {
  const state = preparationContext(context),
    f = state.family,
    p = readProgress(f);
  if (state.consumed || state.mode === "committed-cleanup")
    throw Error("Original unused collector check required");
  const { packet, value, fact } = verifiedStagedRetirementPacket(f, p, raw);
  if (
    value.contextMode !== state.mode ||
    value.checkNonce !== state.nonce ||
    value.manifestDigest !== state.manifestDigest ||
    value.checkedAt < state.createdAt ||
    value.checkedAt > Date.now()
  )
    throw Error("Collector check nonce/phase changed");
  const rawAdmission = readPrivateRecord(
      f.state,
      "executions",
      `${value.execution.operationKey}.json`,
      65536,
    ),
    admitted = verifyControl(
      f.state.publicKeys["ops-agent"],
      "openmapx-control-execution-v2",
      rawAdmission,
      z
        .object({
          admittedAt: z.number().int().nonnegative().safe(),
          coordinatorPullBaseline: coordinatorPullBaselineSchema,
        })
        .passthrough(),
    ),
    baseline = admitted.coordinatorPullBaseline;
  if (
    controlDigest(rawAdmission) !== fact.receiptDigest ||
    admitted.admittedAt !== value.rank.admittedAt ||
    value.oldContainerDigest !==
      controlDigest({
        container: baseline.container,
        configImageReference: baseline.configImageReference,
        composeSourcesDigest: baseline.composeSourcesDigest,
        configurationRevisionId: baseline.configurationRevisionId,
      })
  )
    throw Error("Actual staged retirement source changed");
  state.consumed = true;
  state.packet = packet;
}
function sourcePreparationContextAllows(
  context: ControlRetentionPreparationContext | undefined,
  state: InstallationState,
  origin: ControlExecutionOrigin,
  execution: ExecutionRef,
  sequence: number,
) {
  if (!context) return false;
  const local = preparationContext(context);
  return (
    local.family.state === state &&
    local.mode !== "committed-cleanup" &&
    local.sequence === sequence &&
    local.family.originHash === controlDigest(origin) &&
    !!readProgress(local.family).executions[controlDigest(execution)]
  );
}
function assertStagedCommittedCleanup(f: Family, p: Progress, m: Manifest, current: Decision) {
  assertPrivateRetirementProof(f, m);
  const committedRaw = json(f.slot, "commit.json", 8192);
  const d =
    committedRaw === null
      ? current
      : verified<Decision>(
          f.state,
          f.meta.origin.issuer,
          "openmapx-retention-decision-v1",
          committedRaw,
        );
  sameFamily(f, d);
  if (
    d.phase !== "committed" ||
    current.manifestDigest !== d.manifestDigest ||
    !["committed", "final"].includes(current.phase) ||
    (current.phase === "committed" && controlDigest(current) !== controlDigest(d))
  )
    throw Error("Original signed committed decision required");
  if (
    !["committed", "final"].includes(d.phase) ||
    d.manifestDigest !== controlDigest(m) ||
    !Number.isSafeInteger(p.cursor) ||
    p.cursor < 0 ||
    p.cursor > p.records
  )
    throw Error("Original committed cleanup cursor required");
  if (f.state.installation.role !== "ops-agent") return;
  const proof = verified<Candidate>(
    f.state,
    "ops-agent",
    "openmapx-retention-candidate-v1",
    json(f.slot, "proof.json", 65536),
  );
  if (!m.stagedCoordinatorDependencyDigest) {
    if (
      proof.stagedCoordinatorDependency ||
      p.stagedCoordinatorRevalidation ||
      d.stagedCoordinatorRevalidationDigest
    )
      throw Error("Unbound staged committed cleanup proof");
    return; // Existing authenticated historical cleanup, never a source reader.
  }
  const first = verifiedStagedRetirementPacket(f, p, proof.stagedCoordinatorDependency),
    last = verifiedStagedRetirementPacket(f, p, p.stagedCoordinatorRevalidation);
  if (
    controlDigest(first.packet) !== m.stagedCoordinatorDependencyDigest ||
    controlDigest(last.packet) !== d.stagedCoordinatorRevalidationDigest ||
    first.value.contextMode !== "preparing" ||
    first.value.manifestDigest !== null ||
    last.value.contextMode !== "before-commit" ||
    last.value.manifestDigest !== controlDigest(m) ||
    first.value.checkNonce === last.value.checkNonce ||
    canonicalJson([
      first.value.execution,
      first.value.terminalDigest,
      first.value.sourceAdmissionDigest,
      first.value.oldContainerDigest,
      first.value.rank,
    ]) !==
      canonicalJson([
        last.value.execution,
        last.value.terminalDigest,
        last.value.sourceAdmissionDigest,
        last.value.oldContainerDigest,
        last.value.rank,
      ])
  )
    throw Error("Original staged committed revalidation changed");
}
async function prepareJournalPhase(f: Family, p: Progress, mode: PreparationMode, m?: Manifest) {
  if (mode === "committed-cleanup") {
    if (!m) throw Error("Committed cleanup manifest required");
    const current =
      p.phase === "released" && p.sharedRelease
        ? verified<Decision>(
            f.state,
            f.meta.origin.issuer,
            "openmapx-retention-decision-v1",
            json(f.slot, "final.json", 8192),
          )
        : decision(f);
    assertStagedCommittedCleanup(f, p, m, current);
  }
  const token = Object.freeze({}) as ControlRetentionPreparationContext;
  const state = {
    family: f,
    sequence: p.sequence,
    mode,
    nonce: randomUUID(),
    manifestDigest: m ? controlDigest(m) : null,
    createdAt: Date.now(),
    consumed: false,
    packet: undefined as StagedCoordinatorRetirementPacket | undefined,
  };
  preparationContexts.set(token, state);
  try {
    await f.state.retentionJournal?.prepare?.(
      Object.values(p.executions)
        .filter((fact) => fact.requiresJournal)
        .map((fact) => ({ execution: fact.execution, digest: fact.terminalDigest })),
      token,
    );
    preparationContext(token);
    return state.packet;
  } finally {
    preparationContexts.delete(token);
  }
}

const DIGEST = /^[a-f0-9]{64}$/;
const safeName = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/;
const slotName = /^slot-\d{1,4}$/;
function missing(e: unknown): boolean {
  return (e as NodeJS.ErrnoException).code === "ENOENT";
}
function cell(
  dir: AnchoredDirectory,
  name: string,
  value: unknown,
  maximum: number,
  exclusive = false,
) {
  const bytes = canonicalJson(value);
  if (Buffer.byteLength(bytes) > maximum)
    throw Error("Reserved retention workspace capacity exceeded");
  dir.write(name, bytes + " ".repeat(maximum - Buffer.byteLength(bytes)), exclusive);
}
function json<T>(dir: AnchoredDirectory, name: string, max = 131072): T {
  return JSON.parse(dir.read(name, max).toString("utf8")) as T;
}
function signed<T>(state: InstallationState, domain: string, value: T) {
  return signControl(state.privateKey, domain, value);
}
function verified<T>(
  state: InstallationState,
  role: ControlIssuer,
  domain: string,
  raw: unknown,
): T {
  return verifyControl(state.publicKeys[role], domain, raw, z.unknown()) as T;
}
function originHash(origin: ControlExecutionOrigin) {
  return controlDigest(origin);
}
function tuple(e: FamilyRecord): unknown[] {
  return [
    e.scope === "private" ? "p" : "s",
    e.namespace,
    e.name,
    e.container,
    e.digest,
    e.inode.dev,
    e.inode.ino,
    e.ordinal,
    e.state,
    e.counted ? 1 : 0,
    e.directory ? 1 : 0,
    e.generation ?? "",
  ];
}
function entry(v: unknown): FamilyRecord {
  if (
    !Array.isArray(v) ||
    v.length !== 12 ||
    !["p", "s"].includes(v[0]) ||
    !safeName.test(v[2]) ||
    !DIGEST.test(v[4]) ||
    !Number.isSafeInteger(v[7]) ||
    !["reserved", "prepared", "written"].includes(v[8])
  )
    throw Error("Corrupt retention index entry");
  const e: FamilyRecord = {
    scope: v[0] === "p" ? "private" : "shared",
    namespace: v[1],
    name: v[2],
    container: v[3],
    digest: v[4],
    inode: identitySchema.parse({ dev: v[5], ino: v[6] }),
    ordinal: v[7],
    state: v[8],
    counted: v[9] === 1,
    directory: v[10] === 1,
    ...(v[11] ? { generation: z.uuid().parse(v[11]) } : {}),
  };
  if (!(e.scope === "private" ? PRIVATE : SHARED).has(e.namespace))
    throw Error("Unknown fixed retention namespace");
  return e;
}
function readProgress(f: Family): Progress {
  const p = json<Progress>(f.slot, "progress.json");
  if (
    p.version !== 1 ||
    p.familyId !== f.meta.familyId ||
    p.generation !== f.meta.generation ||
    !Number.isSafeInteger(p.sequence) ||
    p.records > LIMITS.recordsPerFamily ||
    !Number.isSafeInteger(p.sharedRecords) ||
    p.sharedRecords < 0 ||
    p.sharedRecords > 2048 ||
    !Number.isSafeInteger(p.metadataBytes) ||
    p.metadataBytes > LIMITS.familyMetadataBytes ||
    Object.keys(p.executions).length > LIMITS.executionsPerFamily ||
    Object.keys(p.intents).length > LIMITS.intentsPerFamily ||
    p.participants.some((r) => !ROLES.includes(r))
  )
    throw Error("Retention family progress identity/capacity mismatch");
  const prior = json<{ sequence: number; digest: string }>(f.slot, "progress-highwater.json", 1024);
  if (
    p.sequence < prior.sequence ||
    (p.sequence === prior.sequence && controlDigest(p) !== prior.digest)
  )
    throw Error("Retention family progress rollback");
  return p;
}
function progress(f: Family, p: Progress, reserveAdmission = false) {
  if (json<Progress>(f.slot, "progress.json").sequence !== p.sequence)
    throw Error("Family progress compare-and-swap conflict");
  if (p.sequence >= Number.MAX_SAFE_INTEGER) throw Error("Family sequence exhausted");
  // Reserve space for retirement transactions and post-effect timestamps.
  // Ordinary admission may never consume the collector's last 8KiB.
  if (reserveAdmission && p.phase === "active" && Buffer.byteLength(canonicalJson(p)) > 120 * 1024)
    throw Error("Family progress capacity exhausted before exposure");
  p.sequence++;
  cell(f.slot, "progress.json", p, 131072);
  cell(f.slot, "progress-highwater.json", { sequence: p.sequence, digest: controlDigest(p) }, 1024);
}
export function guard<T>(dir: AnchoredDirectory, name: string, run: () => T): T {
  acquireGuardDirectory(dir.name(name));
  fsyncSync(dir.fd);
  const held = dir.directory(name),
    expected = identity(held.stat);
  try {
    return run();
  } finally {
    held.close();
    dir.removeDirectory(name, expected);
  }
}
function decision(f: Family): Decision {
  const value = verified<Decision>(
    f.state,
    f.meta.origin.issuer,
    "openmapx-retention-decision-v1",
    json(f.shared, "decision.json", 8192),
  );
  if (
    value.version !== 1 ||
    value.familyId !== f.meta.familyId ||
    value.generation !== f.meta.generation ||
    !["active", "prepared", "committed", "final"].includes(value.phase)
  )
    throw Error("Retention decision identity mismatch");
  return value;
}
function writeDecision(f: Family, value: Decision) {
  if (f.state.fixedChildId || f.state.installation.role !== f.meta.origin.issuer)
    throw Error("Only the origin coordinator may publish a retirement decision");
  cell(f.shared, "decision.json", signed(f.state, "openmapx-retention-decision-v1", value), 8192);
}
function checkLocalIdentity(f: Family) {
  f.slot.check();
  f.slots.check();
  if (!sameInode(identity(f.slot.stat), f.slotIdentity)) throw Error("Replaced family slot inode");
  const local = json<{ familyId: string; generation: string; slotGeneration: string }>(
    f.slot,
    "identity.json",
    2048,
  );
  if (
    local.familyId !== f.meta.familyId ||
    local.generation !== f.meta.generation ||
    local.slotGeneration !== f.slotGeneration
  )
    throw Error("Reused family slot generation");
}
function openFamily(state: InstallationState, origin: ControlExecutionOrigin): Family {
  const hash = originHash(origin),
    opened: AnchoredDirectory[] = [];
  const own = (directory: AnchoredDirectory) => {
    opened.push(directory);
    return directory;
  };
  const close = () => {
    for (const directory of [...opened].reverse()) directory.close();
  };
  try {
    const locations = own(state.privateRoot.directory("retention-locations"));
    const local = json<{
      name: string;
      inode: FileIdentity;
      slotGeneration: string;
      identity: unknown;
    }>(locations, `${hash}.json`, 4096);
    if (!slotName.test(local.name)) throw Error("Invalid family slot name");
    const meta = verifyControl(
      state.publicKeys[origin.issuer],
      "openmapx-retention-family-v1",
      local.identity,
      sharedIdentitySchema,
    );
    if (
      controlDigest(meta.origin) !== hash ||
      meta.installationId !== state.installation.installationId
    )
      throw Error("Foreign retained origin");
    const slots = own(state.privateRoot.directory("retention-families")),
      slot = own(slots.directory(local.name)),
      root = own(new AnchoredDirectory(state.dataRoot)),
      control = own(root.directory(".admin-target-control")),
      sharedRoot = own(control.directory("retention-families"));
    if (!sameInode(identity(root.stat), meta.dataRootIdentity))
      throw Error("Family physical data root replaced");
    let shared: AnchoredDirectory,
      sharedGone = false;
    try {
      shared = own(sharedRoot.directory(hash));
    } catch (error) {
      const p = json<Progress>(slot, "progress.json");
      if (!missing(error) || p.phase !== "released") throw error;
      const final = verified<Decision & { semanticClean?: boolean }>(
        state,
        origin.issuer,
        "openmapx-retention-decision-v1",
        json(slot, "final.json", 8192),
      );
      if (
        final.phase !== "final" ||
        !final.semanticClean ||
        final.familyId !== meta.familyId ||
        final.generation !== meta.generation
      )
        throw Error("Missing private final retirement proof");
      sharedGone = true;
      shared = own(state.privateRoot.directory("retention-families"));
    }
    const f: Family = {
      state,
      root,
      slots,
      slot,
      sharedRoot,
      shared,
      meta,
      name: local.name,
      slotIdentity: local.inode,
      slotGeneration: local.slotGeneration,
      originHash: hash,
      sharedGone,
      close,
    };
    checkLocalIdentity(f);
    if (!sharedGone && !sameInode(identity(shared.stat), meta.sharedIdentity))
      throw Error("Shared family slot inode replaced");
    return f;
  } catch (error) {
    close();
    throw error;
  }
}
export function hasLocalRetentionFamily(
  state: InstallationState,
  origin: ControlExecutionOrigin,
): boolean {
  try {
    const f = openFamily(state, origin);
    f.close();
    return true;
  } catch (e) {
    if (missing(e)) return false;
    throw e;
  }
}
function preallocateSharedRole(shared: AnchoredDirectory, role: ControlIssuer) {
  for (const [name, size] of [
    [`ack-${role}.json`, 4096],
    [`candidate-${role}.json`, 65536],
  ] as const)
    try {
      cell(shared, name, null, size, true);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  for (let n = 0; n < 32; n++)
    try {
      cell(shared, `shared-${role}-${n}.json`, [], 16384, true);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
}
/** Called by fixed admission/enlistment before any family record or assertion is exposed. */
export function reserveControlFamily(
  state: InstallationState,
  origin: ControlExecutionOrigin,
): void {
  try {
    const f = openFamily(state, origin);
    f.close();
    return;
  } catch (e) {
    if (!missing(e)) throw e;
  }
  if (state.fixedChildId) throw Error("A fixed child requires its role's already reserved family");
  const root = new AnchoredDirectory(state.dataRoot),
    control = root.directory(".admin-target-control", true, true),
    sharedRoot = control.directory("retention-families", true, true);
  const slots = state.privateRoot.directory("retention-families", true, true),
    locations = state.privateRoot.directory("retention-locations", true, true);
  const hash = originHash(origin);
  let shared: AnchoredDirectory | undefined, slot: AnchoredDirectory | undefined;
  try {
    if (json(state.privateRoot, "retention-slot-transaction.json", 4096) !== null)
      throw Error("Family slot release pending; reconcile before admission");
    let name: string | undefined;
    for (let n = 0; n < LIMITS.familiesPerRole; n++) {
      const candidate = `slot-${n}`;
      try {
        mkdirSync(slots.name(candidate), { mode: 0o700 });
        name = candidate;
        fsyncSync(slots.fd);
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
    }
    if (!name) throw Error("Retained family capacity exhausted; await retention/containment");
    slot = slots.directory(name);
    try {
      shared = sharedRoot.directory(hash);
    } catch (e) {
      if (!missing(e) || origin.issuer !== state.installation.role) throw e;
      shared = sharedRoot.directory(hash, true, true);
      const meta: SharedIdentity = {
        version: 1,
        installationId: state.installation.installationId,
        origin,
        familyId: randomUUID(),
        generation: randomUUID(),
        dataRootIdentity: identity(root.stat),
        sharedIdentity: identity(shared.stat),
      };
      cell(
        shared,
        "identity.json",
        signed(state, "openmapx-retention-family-v1", meta),
        2048,
        true,
      );
      cell(
        shared,
        "decision.json",
        signed(state, "openmapx-retention-decision-v1", {
          version: 1,
          familyId: meta.familyId,
          generation: meta.generation,
          phase: "active",
          sequence: 0,
        }),
        8192,
        true,
      );
      cell(shared, "manifest.json", null, 32768, true);
      cell(shared, "api-ack.json", null, 4096, true);
      shared.directory("executions", true).close();
      shared.directory("intents", true).close();
      shared.directory("leases", true).close();
    }
    const rawIdentity = json(shared, "identity.json", 2048);
    const meta = verifyControl(
      state.publicKeys[origin.issuer],
      "openmapx-retention-family-v1",
      rawIdentity,
      sharedIdentitySchema,
    );
    if (
      controlDigest(meta.origin) !== hash ||
      !sameInode(meta.dataRootIdentity, identity(root.stat)) ||
      !sameInode(meta.sharedIdentity, identity(shared.stat))
    )
      throw Error("Origin physical identity mismatch");
    preallocateSharedRole(shared, state.installation.role);
    const slotGeneration = randomUUID();
    cell(
      slot,
      "identity.json",
      { familyId: meta.familyId, generation: meta.generation, slotGeneration, originHash: hash },
      2048,
      true,
    );
    for (let n = 0; n < LIMITS.indexPages; n++)
      cell(slot, `page-${n}.json`, [], LIMITS.indexPageBytes, true);
    for (const [file, size] of [
      ["manifest.json", 32768],
      ["commit.json", 8192],
      ["final.json", 8192],
      ["proof.json", 65536],
    ] as const)
      cell(slot, file, null, size, true);
    const p: Progress = {
      version: 1,
      familyId: meta.familyId,
      generation: meta.generation,
      sequence: 0,
      phase: "active",
      records: 0,
      sharedRecords: 0,
      metadataBytes: 1942528,
      executions: {},
      intents: {},
      leases: {},
      participants: [origin.issuer, state.installation.role].filter(
        (r, i, a) => a.indexOf(r) === i,
      ),
      terminalAt: 0,
      cursor: 0,
      sharedCursor: 0,
    };
    cell(slot, "progress.json", p, 131072, true);
    cell(slot, "progress-highwater.json", { sequence: 0, digest: controlDigest(p) }, 1024, true);
    locations.write(
      `${hash}.json`,
      canonicalJson({ name, inode: identity(slot.stat), slotGeneration, identity: rawIdentity }),
      true,
    );
  } finally {
    slot?.close();
    locations.close();
    slots.close();
    shared?.close();
    sharedRoot.close();
    control.close();
    root.close();
  }
}
function* records(f: Family): Generator<FamilyRecord> {
  const p = readProgress(f);
  let ordinal = 0;
  for (let n = 0; n < Math.ceil(p.records / LIMITS.pageEntries); n++) {
    const page = json<unknown[]>(f.slot, `page-${n}.json`, LIMITS.indexPageBytes);
    if (!Array.isArray(page) || page.length > 64) throw Error("Invalid retained index page");
    for (const value of page) {
      const e = entry(value);
      if (e.ordinal !== ordinal++) throw Error("Retention index ordinal mismatch");
      yield e;
    }
  }
  if (ordinal !== p.records) throw Error("Retention index count mismatch");
}
function recordSetDigest(values: Iterable<FamilyRecord>): string {
  const h = createHash("sha256");
  h.update("[");
  let first = true;
  for (const e of values) {
    if (!first) h.update(",");
    first = false;
    h.update(canonicalJson(tuple(e)));
  }
  h.update("]");
  return h.digest("hex");
}
function findRecord(
  f: Family,
  address: Pick<FamilyRecord, "scope" | "namespace" | "name" | "container">,
): FamilyRecord | undefined {
  for (const e of records(f)) if (equalAddress(e, address)) return e;
  return undefined;
}
function saveEntry(f: Family, e: FamilyRecord) {
  const n = Math.floor(e.ordinal / LIMITS.pageEntries),
    page = json<unknown[]>(f.slot, `page-${n}.json`, LIMITS.indexPageBytes);
  page[e.ordinal % LIMITS.pageEntries] = tuple(e);
  cell(f.slot, `page-${n}.json`, page, LIMITS.indexPageBytes);
}
function equalAddress(
  a: Pick<FamilyRecord, "scope" | "namespace" | "name" | "container">,
  b: Pick<FamilyRecord, "scope" | "namespace" | "name" | "container">,
) {
  return (
    a.scope === b.scope &&
    a.namespace === b.namespace &&
    a.name === b.name &&
    a.container === b.container
  );
}
/** Fixed protocol readers compare the current indexed digest and physical
 * record before accepting an older still-valid signed payload. */
export function verifyFamilyOwnedRecord(
  state: InstallationState,
  origin: ControlExecutionOrigin,
  address: Pick<FamilyRecord, "scope" | "namespace" | "name" | "container">,
  bytes: string,
): void {
  const family = openFamily(state, origin);
  try {
    guard(family.slot, ".family-writer", () => {
      checkLocalIdentity(family);
      const retained = findRecord(family, address);
      if (!retained || retained.state !== "written" || retained.digest !== controlDigest(bytes))
        throw Error("Retained record digest changed");
      const opened = recordDirectory(family, retained);
      try {
        if (
          !sameInode(opened.dir.fileIdentity(retained.name), retained.inode) ||
          controlDigest(
            opened.dir.read(retained.name, recordMaximum(retained)).toString("utf8"),
          ) !== retained.digest
        )
          throw Error("Retained record identity changed");
      } finally {
        opened.close();
      }
    });
  } finally {
    family.close();
  }
}
/** Catalog recovery may finish only the exact terminal cache preimage already
 * indexed before a lost rename. This does not authorize pointer publication. */
export function verifyCatalogPinReceiptRepairPreimage(
  state: InstallationState,
  origin: ControlExecutionOrigin,
  operationKey: string,
  bytes: string,
): void {
  if (!/^opk1_[A-Za-z0-9_-]{16,64}$/.test(operationKey) || Buffer.byteLength(bytes) > 65536)
    throw Error("Invalid catalog receipt repair");
  const f = openFamily(state, origin);
  try {
    guard(f.slot, ".family-writer", () => {
      checkLocalIdentity(f);
      const record = findRecord(f, {
        scope: "private",
        namespace: "catalog-commits",
        name: `${operationKey}.json`,
        container: "",
      });
      if (!record || record.digest !== controlDigest(bytes) || record.state !== "written")
        throw Error("Original indexed catalog receipt preimage required");
    });
  } finally {
    f.close();
  }
}
/** Fixed normal coordinator source observation. Unlike ordinary indexed
 * readers, the reciprocal target check runs under the configuration writer and
 * must neither acquire a family writer nor change any metadata. Derive its one
 * private address from nominal authority; refuse busy/changing/retiring input. */
export function verifyCoordinatorPullAdmissionReadOnly(
  authority: VerifiedExecutionAuthority,
): void {
  verifyNormalImageAdmissionReadOnly(authority, "service.pull");
}
/** Same indexed normal source guard; the fixed stage kind cannot select another address. */
export function verifyImageStageAdmissionReadOnly(authority: VerifiedExecutionAuthority): void {
  verifyNormalImageAdmissionReadOnly(authority, "service.image.stage");
}
function verifyNormalImageAdmissionReadOnly(
  authority: VerifiedExecutionAuthority,
  kind: "service.pull" | "service.image.stage",
): void {
  const source = executionAuthorityState(authority),
    state = source.installation;
  if (
    !source.origin ||
    state.fixedChildId ||
    state.installation.role !== "ops-agent" ||
    source.kind !== kind ||
    source.execution.executor !== "ops-agent" ||
    source.execution.principal !== "api"
  )
    throw Error("Actual normal coordinator admission required");
  const family = openFamily(state, source.origin);
  try {
    const unlocked = () => {
      for (const [directory, name] of [
        [family.slot, ".family-writer"],
        [family.shared, ".membership-writer"],
      ] as const) {
        let held: AnchoredDirectory;
        try {
          held = directory.directory(name);
        } catch (error) {
          if (missing(error)) continue;
          throw error;
        }
        held.close();
        throw Error("Coordinator source index is busy");
      }
      checkLocalIdentity(family);
    };
    unlocked();
    const before = readProgress(family),
      beforeDecision = decision(family),
      address = {
        scope: "private" as const,
        namespace: "executions",
        container: "",
        name: `${source.execution.operationKey}.json`,
      },
      raw = readPrivateRecord(state, address.namespace, address.name, 65536);
    if (
      before.phase !== "active" ||
      beforeDecision.phase !== "active" ||
      controlDigest(raw) !== source.receiptDigest
    )
      throw Error("Original active coordinator admission changed");
    const operation = (raw as { payload: { operation: unknown } }).payload.operation;
    if (kind === "service.pull")
      z.object({
        kind: z.literal("service.pull"),
        serviceId: z.literal("data-manager"),
        candidateId: z.uuid(),
      })
        .passthrough()
        .parse(operation);
    else
      z.object({
        kind: z.literal("service.image.stage"),
        serviceId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
        expectedConfigurationRevisionId: z.string().regex(/^cfg1_[A-Za-z0-9_-]{43}$/),
      })
        .passthrough()
        .parse(operation);
    const retained = findRecord(family, address),
      bytes = canonicalJson(raw);
    if (!retained || retained.state !== "written" || retained.digest !== controlDigest(bytes))
      throw Error("Original coordinator admission index changed");
    const opened = recordDirectory(family, retained);
    try {
      if (
        !sameInode(opened.dir.fileIdentity(retained.name), retained.inode) ||
        controlDigest(opened.dir.read(retained.name, recordMaximum(retained)).toString("utf8")) !==
          retained.digest
      )
        throw Error("Original coordinator admission inode changed");
    } finally {
      opened.close();
    }
    if (
      controlDigest(readProgress(family)) !== controlDigest(before) ||
      controlDigest(decision(family)) !== controlDigest(beforeDecision) ||
      controlDigest(findRecord(family, address)) !== controlDigest(retained)
    )
      throw Error("Coordinator source index is changing");
    unlocked();
  } finally {
    family.close();
  }
}
/** Only the exact release-owner or subsequent canonical-completion preimage
 * ALREADY pinned by this original index can replace the old signed owner.
 * Actual retained physical release is mandatory for both finite transitions;
 * normal completion still verifies full closure before publishing success.
 * No generic index rollback, new effect/inspection/control body or time. */
export function repairIndexedConfigurationMaintenanceSettleCompletion(
  authority: VerifiedExecutionAuthority,
): void {
  const source = executionAuthorityState(authority),
    state = source.installation;
  if (
    state.installation.role !== "ops-agent" ||
    state.fixedChildId ||
    source.kind !== "configurationMaintenance.prepare" ||
    !source.origin
  )
    throw Error("Original maintenance completion recovery required");
  withPrivateEffectWriter(source, () => {
    const admitted = readPrivateRecord(
        state,
        "executions",
        `${source.execution.operationKey}.json`,
        65536,
      ) as { payload?: { operation?: { maintenanceId?: string } } },
      name = `${z.uuid().parse(admitted.payload?.operation?.maintenanceId)}.json`,
      raw = readPrivateRecord(state, "configuration-maintenance", name),
      owner = verifyControl(
        state.installation.publicKey,
        "openmapx-configuration-maintenance-owner-v2",
        raw,
        configurationMaintenanceOwnerRecordSchema,
      );
    assertConfigurationMaintenanceDecisionSource(owner);
    if (
      owner.admissionDigest !== source.receiptDigest ||
      canonicalJson(owner.origin) !== canonicalJson(source.origin) ||
      canonicalJson(owner.plan.prepare) !== canonicalJson(source.execution) ||
      !owner.final ||
      !owner.inspection
    )
      throw Error("Original completion source changed");
    const released = verifyRetainedArtifactTargetRootRelease(authority),
      completed =
        owner.receipt.state === "settling"
          ? configurationMaintenanceReleasedOwner(owner)
          : configurationMaintenanceSettleCompletion(owner, released.releasedAt),
      bytes = canonicalJson(
        signControl(state.privateKey, "openmapx-configuration-maintenance-owner-v2", completed),
      ),
      f = openFamily(state, source.origin!);
    try {
      guard(f.slot, ".family-writer", () => {
        checkLocalIdentity(f);
        const address = {
            scope: "private" as const,
            namespace: "configuration-maintenance",
            container: "",
            name,
          },
          retained = findRecord(f, address),
          p = readProgress(f);
        if (
          !retained ||
          retained.state !== "written" ||
          retained.digest !== controlDigest(bytes) ||
          Buffer.byteLength(bytes) > 131072 ||
          p.phase !== "active" ||
          decision(f).phase !== "active"
        )
          throw Error("Exact indexed settle completion required");
        const directory = state.privateRoot.directory("configuration-maintenance");
        try {
          if (
            canonicalJson(JSON.parse(directory.read(name, 131072).toString("utf8"))) !==
            canonicalJson(raw)
          )
            throw Error("Original completion source raced");
          directory.write(name, bytes, false, (inode) => saveEntry(f, { ...retained, inode }));
        } finally {
          directory.close();
        }
      });
    } finally {
      f.close();
    }
  });
}
export function familyRecordWrite(
  state: InstallationState,
  origin: ControlExecutionOrigin,
  address: Pick<FamilyRecord, "scope" | "namespace" | "name" | "container">,
  bytes: string,
  write: (beforePublish: (inode: FileIdentity) => void) => void,
  exclusive = false,
): void {
  reserveControlFamily(state, origin);
  const f = openFamily(state, origin);
  try {
    let ref: FamilyRecord;
    guard(f.slot, ".family-writer", () => {
      checkLocalIdentity(f);
      const p = readProgress(f),
        old = findRecord(f, address);
      if (exclusive && old?.state === "written")
        throw Object.assign(Error("Exclusive retained record already exists"), { code: "EEXIST" });
      const nextDigest = controlDigest(bytes);
      if (old?.state === "written" && old.digest === nextDigest) {
        const d = recordDirectory(f, old);
        try {
          if (
            sameInode(d.dir.fileIdentity(old.name), old.inode) &&
            controlDigest(d.dir.read(old.name, recordMaximum(old)).toString("utf8")) === old.digest
          ) {
            ref = old;
            return;
          }
        } finally {
          d.close();
        }
      }
      if (p.phase !== "active" || decision(f).phase !== "active")
        throw Error("Retiring family is observation-only");
      if (
        !old &&
        (p.records >= LIMITS.recordsPerFamily ||
          (address.scope === "shared" && p.sharedRecords >= 2048))
      )
        throw Error("Family record capacity exhausted");
      ref = {
        ...address,
        digest: nextDigest,
        inode: old?.inode ?? { dev: "0", ino: "0" },
        ordinal: old?.ordinal ?? p.records,
        state: "written",
        counted: address.scope === "private",
        directory: false,
      };
      // The durable count reserves this ordinal before ordinary publication.
      // The inode-bound page is fsynced by the publication callback while the
      // same family writer is held. An interrupted rename leaves a pinned
      // mismatch, never an unindexed exposed record.
      if (!old) {
        p.records++;
        if (address.scope === "shared") p.sharedRecords++;
        progress(f, p, true);
      }
      write((inode) => {
        ref = { ...ref, inode };
        saveEntry(f, ref);
      });
    });
  } finally {
    f.close();
  }
}
export function trackFamilyDirectory(
  state: InstallationState,
  origin: ControlExecutionOrigin,
  address: Pick<FamilyRecord, "namespace" | "name" | "container">,
  inode: FileIdentity,
  generation?: string,
) {
  const f = openFamily(state, origin);
  try {
    guard(f.slot, ".family-writer", () => {
      const p = readProgress(f),
        old = findRecord(f, { scope: "shared", ...address });
      if (old) {
        if (!sameInode(old.inode, inode)) throw Error("Replaced indexed directory");
        return;
      }
      if (
        p.phase !== "active" ||
        decision(f).phase !== "active" ||
        p.records >= LIMITS.recordsPerFamily ||
        p.sharedRecords >= 2048
      )
        throw Error("Retained directory capacity/fence");
      const e: FamilyRecord = {
        scope: "shared",
        ...address,
        inode,
        generation,
        digest: controlDigest({ inode, generation: generation ?? null }),
        ordinal: p.records,
        state: "written",
        counted: false,
        directory: true,
      };
      saveEntry(f, e);
      p.records++;
      p.sharedRecords++;
      progress(f, p, true);
    });
  } finally {
    f.close();
  }
}
function ticket(
  f: Family,
  p: Progress,
  kind: "executions" | "intents" | "leases",
  id: string,
  maximum: number,
  value: unknown,
) {
  const dir = f.shared.directory(kind);
  try {
    for (let n = 0; n < maximum; n++) {
      const name = `slot-${n}`;
      try {
        const existing = json<{ id: string; generation: string }>(dir, `${name}.json`, 4096);
        if (existing.id === id) {
          if (existing.generation !== f.meta.generation) throw Error("Ticket generation mismatch");
          return;
        }
      } catch (e) {
        if (!missing(e)) throw e;
      }
      const bytes = canonicalJson({ id, generation: f.meta.generation, value });
      if (p.metadataBytes + Buffer.byteLength(bytes) > LIMITS.familyMetadataBytes)
        throw Error("Origin retention metadata capacity exhausted before exposure");
      p.metadataBytes += Buffer.byteLength(bytes);
      progress(f, p, true);
      try {
        dir.write(`${name}.json`, bytes, true);
        return;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
    }
    throw Error(`Origin ${kind} capacity exhausted before effect`);
  } finally {
    dir.close();
  }
}
export function registerFamilyExecution(
  state: InstallationState,
  origin: ControlExecutionOrigin,
  execution: ExecutionRef,
  receiptDigest: string,
  parent?: RetainedParentExecution,
  stagedCoordinatorBaseline = false,
) {
  reserveControlFamily(state, origin);
  const f = openFamily(state, origin);
  try {
    guard(f.shared, ".membership-writer", () =>
      guard(f.slot, ".family-writer", () => {
        const p = readProgress(f),
          id = controlDigest(execution);
        if (p.executions[id]) {
          if (p.executions[id].receiptDigest !== receiptDigest)
            throw Error("Family execution conflict");
          return;
        }
        if (p.phase !== "active" || decision(f).phase !== "active")
          throw Error("Closed origin membership");
        if (stagedCoordinatorBaseline) {
          // Unsigned prospective encoding arithmetic. Both packets occupy the
          // existing cells; the collector's independent 8KiB headroom remains.
          const maximum = Number.MAX_SAFE_INTEGER,
            hash = "f".repeat(64),
            receipts = {
              ...Object.fromEntries(Object.keys(p.executions).map((key) => [key, hash])),
              [id]: hash,
            },
            candidate = {
              version: 1,
              installationId: f.meta.installationId,
              familyId: f.meta.familyId,
              generation: f.meta.generation,
              role: f.state.installation.role,
              originDigest: f.originHash,
              terminalAt: maximum,
              terminalSequenceDigest: hash,
              executionReceiptDigests: receipts,
              localRecordSetDigest: hash,
              sharedRecordSetDigest: hash,
              leaseDigests: Object.fromEntries(Object.keys(p.leases).map((key) => [key, hash])),
              intentDigests: Object.fromEntries(Object.keys(p.intents).map((key) => [key, hash])),
            };
          const width = (value: unknown) => Buffer.byteLength(canonicalJson(value));
          const futureFact = {
            execution,
            verifier: state.installation.publicKey,
            receiptDigest: hash,
            terminalDigest: hash,
            settlementDigest: hash,
            canonicalDigest: hash,
            canonicalTerminalAt: maximum,
            terminalAt: maximum,
            known: true,
            requiresJournal: true,
            journalContained: true,
          };
          const futureProgress = {
            ...p,
            sequence: maximum,
            terminalAt: maximum,
            executions: { ...p.executions, [id]: futureFact },
            ...(parent?.issuer === "api"
              ? {
                  api: {
                    parent,
                    operationKey: execution.operationKey,
                    fingerprint: execution.fingerprint,
                  },
                }
              : {}),
          };
          if (
            width({ payload: candidate, signature: "" }) + 86 + 4096 + 64 > 65536 ||
            width(futureProgress) + 4096 + 64 + 8192 > 131072 ||
            p.metadataBytes > LIMITS.familyMetadataBytes
          )
            throw Error("Staged coordinator retirement capacity unavailable before pull");
        }
        ticket(f, p, "executions", id, LIMITS.executionsPerFamily, execution);
        p.executions[id] = {
          execution,
          receiptDigest,
          verifier: state.installation.publicKey,
          known: false,
          terminalAt: 0,
          terminalDigest: "0".repeat(64),
          settlementDigest: "0".repeat(64),
          canonicalDigest: "0".repeat(64),
          canonicalTerminalAt: 0,
          requiresJournal: false,
          journalContained: false,
          ...(state.fixedChildId ? { fixedChildId: state.fixedChildId } : {}),
        };
        if (parent?.issuer === "api") {
          const api = {
            parent,
            operationKey: execution.operationKey,
            fingerprint: execution.fingerprint,
          };
          if (p.api && controlDigest(p.api) !== controlDigest(api))
            throw Error("Origin API parent conflict");
          p.api = api;
        }
        progress(f, p, true);
      }),
    );
  } finally {
    f.close();
  }
}
/** Fixed settlement reservation projection reads the actual original issuer
 * membership. Caller digests/ordinals cannot create or replace a ticket. */
export function retainedConfigurationMaintenanceFamilyMember(
  state: InstallationState,
  origin: ControlExecutionOrigin,
  execution: ExecutionRef,
) {
  if (
    state.fixedChildId ||
    state.installation.role !== "ops-agent" ||
    origin.issuer !== "ops-agent" ||
    origin.rootKey !== execution.operationKey ||
    execution.executor !== "ops-agent" ||
    execution.principal !== "api"
  )
    throw Error("Original maintenance issuer membership required");
  const f = openFamily(state, origin);
  try {
    return guard(f.shared, ".membership-writer", () =>
      guard(f.slot, ".family-writer", () => {
        checkLocalIdentity(f);
        const p = readProgress(f),
          id = controlDigest(execution),
          member = p.executions[id];
        if (
          p.phase !== "active" ||
          decision(f).phase !== "active" ||
          !member ||
          canonicalJson(member.execution) !== canonicalJson(execution)
        )
          throw Error("Original active maintenance membership unavailable");
        const tickets = f.shared.directory("executions");
        try {
          for (let ordinal = 0; ordinal < LIMITS.executionsPerFamily; ordinal++) {
            let ticket: { id: string; generation: string; value: unknown };
            try {
              ticket = json(tickets, `slot-${ordinal}.json`, 4096);
            } catch (error) {
              if (missing(error)) continue;
              throw error;
            }
            if (ticket.id !== id) continue;
            if (
              ticket.generation !== f.meta.generation ||
              canonicalJson(ticket.value) !== canonicalJson(execution)
            )
              throw Error("Original maintenance membership ticket changed");
            return {
              role: "ops-agent" as const,
              familyId: f.meta.familyId,
              rootMemberOrdinal: ordinal,
              rootExecutionDigest: id,
              rootAdmissionDigest: member.receiptDigest,
            };
          }
          throw Error("Original maintenance issuer ticket missing");
        } finally {
          tickets.close();
        }
      }),
    );
  } finally {
    f.close();
  }
}
/** Counterparty verification reads only the indexed shared issuer source;
 * the DM never needs an ops-agent-private family directory. */
export function verifyPublishedConfigurationMaintenanceFamilyMember(
  state: InstallationState,
  origin: ControlExecutionOrigin,
  execution: ExecutionRef,
  membership: {
    role: "ops-agent";
    familyId: string;
    rootMemberOrdinal: number;
    rootExecutionDigest: string;
    rootAdmissionDigest: string;
  },
): void {
  if (
    origin.issuer !== "ops-agent" ||
    execution.executor !== "ops-agent" ||
    execution.principal !== "api" ||
    origin.rootKey !== execution.operationKey ||
    membership.role !== "ops-agent" ||
    !Number.isInteger(membership.rootMemberOrdinal) ||
    membership.rootMemberOrdinal < 0 ||
    membership.rootMemberOrdinal >= LIMITS.executionsPerFamily
  )
    throw Error("Original shared maintenance membership required");
  const opened: AnchoredDirectory[] = [],
    own = (directory: AnchoredDirectory) => {
      opened.push(directory);
      return directory;
    };
  try {
    const root = own(new AnchoredDirectory(state.dataRoot)),
      control = own(root.directory(".admin-target-control")),
      families = own(control.directory("retention-families")),
      family = own(families.directory(originHash(origin)));
    const meta = verifyControl(
      state.publicKeys["ops-agent"],
      "openmapx-retention-family-v1",
      json(family, "identity.json", 2048),
      sharedIdentitySchema,
    );
    if (
      meta.installationId !== state.installation.installationId ||
      meta.familyId !== membership.familyId ||
      controlDigest(meta.origin) !== controlDigest(origin) ||
      !sameInode(meta.dataRootIdentity, identity(root.stat)) ||
      !sameInode(meta.sharedIdentity, identity(family.stat))
    )
      throw Error("Shared original family identity changed");
    const tickets = own(family.directory("executions")),
      ticket = json<{ id: string; generation: string; value: unknown }>(
        tickets,
        `slot-${membership.rootMemberOrdinal}.json`,
        4096,
      );
    if (
      ticket.generation !== meta.generation ||
      ticket.id !== membership.rootExecutionDigest ||
      ticket.id !== controlDigest(execution) ||
      canonicalJson(ticket.value) !== canonicalJson(execution)
    )
      throw Error("Shared original issuer membership changed");
  } finally {
    for (const directory of opened.reverse()) directory.close();
  }
}
export function enlistFamilyIntent(
  state: InstallationState,
  origin: ControlExecutionOrigin,
  id: string,
  child: ExecutionRef,
  recipient: ControlIssuer,
) {
  const f = openFamily(state, origin);
  try {
    guard(f.shared, ".membership-writer", () =>
      guard(f.slot, ".family-writer", () => {
        const p = readProgress(f);
        if (p.phase !== "active" || decision(f).phase !== "active")
          throw Error("Closed origin intent membership");
        if (state.installation.role !== origin.issuer && !p.participants.includes(recipient))
          throw Error("Finite noncoordinator edge cannot enlist a third role");
        ticket(f, p, "intents", id, LIMITS.intentsPerFamily, {
          childDigest: controlDigest(child),
          recipient,
        });
        p.intents[id] = { id, childDigest: controlDigest(child), recipient };
        if (!p.participants.includes(recipient)) p.participants.push(recipient);
        preallocateSharedRole(f.shared, recipient);
        progress(f, p, true);
      }),
    );
  } finally {
    f.close();
  }
}
export function registerFamilyLease(
  state: InstallationState,
  origin: ControlExecutionOrigin,
  id: string,
  certificateDigest: string,
  ownerRole: ControlIssuer,
) {
  const f = openFamily(state, origin);
  try {
    guard(f.shared, ".membership-writer", () =>
      guard(f.slot, ".family-writer", () => {
        const p = readProgress(f);
        if (p.leases[id]) return;
        if (p.phase !== "active" || decision(f).phase !== "active")
          throw Error("Closed origin lease membership");
        ticket(f, p, "leases", id, LIMITS.executionsPerFamily, { certificateDigest, ownerRole });
        p.leases[id] = { id, certificateDigest, ownerRole, released: false };
        progress(f, p, true);
      }),
    );
  } finally {
    f.close();
  }
}
export function requireFamilyJournal(
  state: InstallationState,
  origin: ControlExecutionOrigin,
  execution: ExecutionRef,
): void {
  const f = openFamily(state, origin);
  try {
    guard(f.slot, ".family-writer", () => {
      const p = readProgress(f),
        fact = p.executions[controlDigest(execution)];
      if (!fact || p.phase !== "active") throw Error("Invalid journal dependency");
      fact.requiresJournal = true;
      fact.journalContained = false;
      progress(f, p);
    });
  } finally {
    f.close();
  }
}
export function completeFamilyJournal(
  state: InstallationState,
  origin: ControlExecutionOrigin,
  execution: ExecutionRef,
  terminalAt?: number,
): void {
  const f = openFamily(state, origin);
  try {
    guard(f.slot, ".family-writer", () => {
      const p = readProgress(f),
        fact = p.executions[controlDigest(execution)];
      if (!fact?.requiresJournal) throw Error("Invalid joined journal worker");
      if (fact.journalContained) return;
      if (p.phase !== "active") throw Error("Invalid joined journal worker");
      if (terminalAt !== undefined && (!Number.isSafeInteger(terminalAt) || terminalAt <= 0))
        throw Error("Invalid original terminal time");
      fact.journalContained = true;
      p.terminalAt = Math.max(p.terminalAt, terminalAt ?? Date.now());
      progress(f, p);
    });
  } finally {
    f.close();
  }
}
export function markFamilyTerminal(
  state: InstallationState,
  origin: ControlExecutionOrigin,
  execution: ExecutionRef,
  known: boolean,
  terminalDigest?: string,
  terminalAt?: number,
) {
  const f = openFamily(state, origin);
  try {
    guard(f.slot, ".family-writer", () => {
      const p = readProgress(f),
        e = p.executions[controlDigest(execution)];
      if (!e) throw Error("Missing indexed terminal execution");
      if (p.phase !== "active") {
        if (
          e.known &&
          known &&
          (!terminalDigest || (e.settlementDigest ?? e.terminalDigest) === terminalDigest)
        )
          return;
        throw Error("Terminal transition after membership closed");
      }
      const changed =
        e.known !== known ||
        (terminalDigest !== undefined &&
          (e.settlementDigest ?? e.terminalDigest) !== terminalDigest);
      if (terminalAt !== undefined && (!Number.isSafeInteger(terminalAt) || terminalAt <= 0))
        throw Error("Invalid original terminal time");
      if (!changed && e.terminalAt !== undefined) return;
      e.known = known;
      if (terminalDigest) {
        e.settlementDigest = terminalDigest;
        if (!e.requiresJournal) e.terminalDigest = terminalDigest;
      }
      if (changed || e.terminalAt === undefined) {
        e.terminalAt = Math.max(e.terminalAt ?? 0, terminalAt ?? Date.now());
        p.terminalAt = Math.max(p.terminalAt, e.terminalAt);
      }
      progress(f, p);
    });
  } finally {
    f.close();
  }
}
function canonicalCompatible(
  p: Progress,
  execution: ExecutionRef,
  digest: string,
  terminalAt: number,
): ExecutionFact {
  const e = p.executions[controlDigest(execution)];
  if (!e?.requiresJournal || e.canonicalDigest === undefined || e.canonicalTerminalAt === undefined)
    throw Error("Missing canonical publication reservation; recovery required");
  if (!DIGEST.test(digest) || !Number.isSafeInteger(terminalAt) || terminalAt <= 0)
    throw Error("Invalid canonical terminal publication");
  if (e.canonicalDigest !== "0".repeat(64)) {
    if (
      e.canonicalDigest !== digest ||
      e.terminalDigest !== digest ||
      e.canonicalTerminalAt !== terminalAt
    )
      throw Error("Canonical terminal receipt/time conflict");
  } else if (p.phase !== "active")
    throw Error("Canonical publication after retirement preparation");
  return e;
}
export function assertFamilyCanonicalCompatibility(
  state: InstallationState,
  origin: ControlExecutionOrigin,
  execution: ExecutionRef,
  digest: string,
  terminalAt: number,
): void {
  const f = openFamily(state, origin);
  try {
    guard(f.slot, ".family-writer", () => {
      canonicalCompatible(readProgress(f), execution, digest, terminalAt);
    });
  } finally {
    f.close();
  }
}
/** One-way canonical publication, independent of the immutable own-effect proof. */
export function publishFamilyCanonicalTerminal(
  state: InstallationState,
  origin: ControlExecutionOrigin,
  execution: ExecutionRef,
  known: boolean,
  digest: string,
  terminalAt: number,
): void {
  const f = openFamily(state, origin);
  try {
    guard(f.slot, ".family-writer", () => {
      const p = readProgress(f),
        e = canonicalCompatible(p, execution, digest, terminalAt);
      if (e.canonicalDigest !== "0".repeat(64) && (e.known || !known)) return;
      if (p.phase !== "active") throw Error("Canonical containment after retirement preparation");
      e.canonicalDigest = digest;
      e.canonicalTerminalAt = terminalAt;
      e.terminalDigest = digest;
      e.known = known;
      e.terminalAt = Math.max(e.terminalAt ?? 0, terminalAt);
      p.terminalAt = Math.max(p.terminalAt, e.terminalAt);
      progress(f, p);
    });
  } finally {
    f.close();
  }
}
export function markFamilyLeaseReleased(
  state: InstallationState,
  origin: ControlExecutionOrigin,
  id: string,
  certificateDigest: string,
) {
  const f = openFamily(state, origin);
  try {
    guard(f.slot, ".family-writer", () => {
      const p = readProgress(f),
        lease = p.leases[id];
      if (
        !lease ||
        lease.certificateDigest !== certificateDigest ||
        lease.ownerRole !== state.installation.role
      )
        throw Error("Lease release family mismatch");
      if (lease.released) return;
      const value = {
        version: 1,
        familyId: f.meta.familyId,
        generation: f.meta.generation,
        originDigest: originHash(origin),
        leaseId: id,
        certificateDigest,
        releasedAt: Date.now(),
        role: state.installation.role,
      };
      lease.released = true;
      p.terminalAt = Math.max(p.terminalAt, value.releasedAt);
      progress(f, p);
    });
  } finally {
    f.close();
  }
}
function recordDirectory(f: Family, e: FamilyRecord): { dir: AnchoredDirectory; close(): void } {
  if (!safeName.test(e.name) || !(e.scope === "private" ? PRIVATE : SHARED).has(e.namespace))
    throw Error("Invalid fixed record address");
  const opened: AnchoredDirectory[] = [];
  let dir: AnchoredDirectory;
  if (e.scope === "private") dir = f.state.privateRoot.directory(e.namespace);
  else if (e.namespace === "service-lifecycle") {
    if (e.container !== "" || !/^opk1_[A-Za-z0-9_-]{16,64}\.json$/.test(e.name))
      throw Error("Invalid lifecycle receipt address");
    const agent = f.root.directory("ops-agent");
    opened.push(agent);
    dir = agent.directory("lifecycle");
  } else {
    let current = f.root.directory(".admin-target-control");
    opened.push(current);
    if (e.namespace === "execution") {
      if (!ROLES.includes(e.container as ControlIssuer)) throw Error("Invalid witness issuer");
      current = current.directory("executions");
      opened.push(current);
      dir = current.directory(e.container);
    } else if (e.namespace === "history-slot") {
      current = current.directory("admission-index-v1");
      opened.push(current);
      dir = current.directory("history");
    } else {
      if (!z.uuid().safeParse(e.container).success) throw Error("Invalid lease record container");
      current = current.directory("leases");
      opened.push(current);
      if (e.namespace === "lease-directory" && e.name === e.container) dir = current;
      else {
        current = current.directory(e.container);
        opened.push(current);
        dir =
          e.namespace === "lease-grants"
            ? current.directory("grants")
            : e.namespace === "lease-children"
              ? current.directory("children")
              : current;
        if (dir === current) opened.pop();
      }
    }
  }
  return {
    dir,
    close() {
      dir.close();
      for (const d of opened.reverse()) d.close();
    },
  };
}
function readAllTickets(
  f: Family,
  kind: "executions" | "intents" | "leases",
  maximum: number,
): Array<{ id: string; value: unknown }> {
  const d = f.shared.directory(kind),
    result: Array<{ id: string; value: unknown }> = [];
  try {
    for (let n = 0; n < maximum; n++)
      try {
        const t = json<{ id: string; generation: string; value: unknown }>(
          d,
          `slot-${n}.json`,
          4096,
        );
        if (t.generation !== f.meta.generation) throw Error("Stale family ticket generation");
        result.push(t);
      } catch (e) {
        if (!missing(e)) throw e;
      }
    return result;
  } finally {
    d.close();
  }
}
function directoryPresent(parent: AnchoredDirectory, name: string): boolean {
  try {
    const dir = parent.directory(name);
    dir.close();
    return true;
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}
function executionWriterPresent(f: Family, execution: ExecutionRef): boolean {
  const opened: AnchoredDirectory[] = [];
  const own = (d: AnchoredDirectory) => {
    opened.push(d);
    return d;
  };
  try {
    try {
      const effects = own(f.state.privateRoot.directory("effect-writers"));
      if (directoryPresent(effects, execution.operationKey)) return true;
    } catch (error) {
      if (!missing(error)) throw error;
    }
    const control = own(f.root.directory(".admin-target-control")),
      executions = own(control.directory("executions")),
      role = own(executions.directory(execution.executor));
    return directoryPresent(role, `${execution.operationKey}.writer`);
  } finally {
    for (const dir of opened.reverse()) dir.close();
  }
}
function localProof(f: Family, p: Progress): boolean {
  // A reserved logical control is a separate mandatory release/retirement
  // obligation. Ordinary terminal facts cannot stand in for its closure chain.
  if (!Object.keys(p.executions).length) return false;
  if (Object.values(p.executions).some((e) => !e.known || e.terminalAt === undefined)) return false;
  for (const fact of Object.values(p.executions)) {
    if (executionWriterPresent(f, fact.execution)) return false;
    if (
      fact.requiresJournal &&
      (!fact.canonicalDigest ||
        fact.canonicalDigest === "0".repeat(64) ||
        fact.canonicalDigest !== fact.terminalDigest ||
        !fact.journalContained ||
        !f.state.retentionJournal?.contained(fact.execution, fact.terminalDigest))
    )
      return false;
    const executions = f.state.privateRoot.directory("executions"),
      effects = f.state.privateRoot.directory("effects"),
      lifecycle = f.state.privateRoot.directory("execution-lifecycle");
    try {
      const raw = json<unknown>(executions, `${fact.execution.operationKey}.json`, 65536);
      if (controlDigest(raw) !== fact.receiptDigest) return false;
      const admitted = verifyControl(
        fact.verifier,
        "openmapx-control-execution-v2",
        raw,
        z
          .object({ version: z.literal(2), execution: z.unknown(), origin: originSchema })
          .passthrough(),
      );
      if (
        controlDigest(admitted.execution) !== controlDigest(fact.execution) ||
        controlDigest(admitted.origin) !== f.originHash
      )
        return false;
      const terminal = verifyControl(
        fact.verifier,
        "openmapx-control-settlement-v1",
        json(
          effects,
          `${fact.execution.operationKey}.json`,
          CONTROL_RETENTION_LIMITS.privateRecordBytes,
        ),
        z
          .object({
            identity: z.unknown(),
            outcome: z.enum(["contained", "committed", "failed_without_effect"]),
            publication: z.enum(["not_started", "committed"]),
            terminalReceiptDigest: z.string(),
            receipt: z.unknown(),
          })
          .passthrough(),
      );
      if (
        controlDigest(terminal.identity) !== controlDigest(fact.execution) ||
        terminal.terminalReceiptDigest !== controlDigest(terminal.receipt)
      )
        return false;
      const phase = verifyControl(
        fact.verifier,
        "openmapx-execution-lifecycle-v1",
        json(lifecycle, `${fact.execution.operationKey}.json`, 65536),
        z.object({ execution: z.unknown(), phase: z.literal("settled") }).passthrough(),
      );
      if (controlDigest(phase.execution) !== controlDigest(fact.execution)) return false;
    } finally {
      lifecycle.close();
      effects.close();
      executions.close();
    }
  }
  for (const lease of Object.values(p.leases)) {
    const control = f.root.directory(".admin-target-control"),
      leases = control.directory("leases"),
      ledger = leases.directory(lease.id);
    try {
      if (directoryPresent(ledger, ".journal-writer")) return false;
      const released = verified<{
        leaseId: string;
        certificateDigest: string;
        releasedAt?: number;
      }>(
        f.state,
        lease.ownerRole,
        "openmapx-admission-slots-v1",
        json(ledger, "admission.json", 4096),
      );
      if (
        released.leaseId !== lease.id ||
        released.certificateDigest !== lease.certificateDigest ||
        !released.releasedAt
      )
        return false;
    } finally {
      ledger.close();
      leases.close();
      control.close();
    }
  }
  return true;
}
function sameFamily(f: Family, v: { familyId: string; generation: string; originDigest?: string }) {
  if (
    v.familyId !== f.meta.familyId ||
    v.generation !== f.meta.generation ||
    (v.originDigest !== undefined && v.originDigest !== f.originHash)
  )
    throw Error("Retirement family/generation mismatch");
}
function ack(f: Family, role: ControlIssuer): Ack | null {
  const raw = json<unknown>(f.shared, `ack-${role}.json`, 4096);
  if (raw === null) return null;
  const a = verified<Ack>(f.state, role, "openmapx-retention-ack-v1", raw);
  sameFamily(f, a);
  if (
    a.role !== role ||
    !DIGEST.test(a.manifestDigest) ||
    !["ready", "clean", "released"].includes(a.phase) ||
    !Number.isSafeInteger(a.sequence) ||
    a.sequence < 1
  )
    throw Error("Invalid retirement acknowledgement");
  return a;
}
function manifest(f: Family): Manifest {
  const m = verified<Manifest>(
    f.state,
    f.meta.origin.issuer,
    "openmapx-retention-manifest-v1",
    json(f.shared, "manifest.json", 32768),
  );
  sameFamily(f, m);
  if (
    m.version !== 1 ||
    m.installationId !== f.state.installation.installationId ||
    controlDigest(m.origin) !== f.originHash ||
    Object.keys(m.executionReceiptDigests).length > LIMITS.executionsPerFamily ||
    m.participants.length > 4
  )
    throw Error("Invalid retirement manifest");
  return m;
}
function publishAck(f: Family, p: Progress, m: Manifest, phase: Ack["phase"]) {
  const old = ack(f, f.state.installation.role);
  if (old && old.manifestDigest !== controlDigest(m))
    throw Error("Conflicting retirement acknowledgement");
  if (old && old.sequence >= Number.MAX_SAFE_INTEGER)
    throw Error("Retirement acknowledgement sequence exhausted");
  const value: Ack = {
    version: 1,
    installationId: f.state.installation.installationId,
    familyId: f.meta.familyId,
    generation: f.meta.generation,
    originDigest: f.originHash,
    manifestDigest: controlDigest(m),
    role: f.state.installation.role,
    phase,
    terminalSequenceDigest: m.terminalSequenceDigest,
    recordSetDigest: m.localRecordSetDigests[f.state.installation.role] ?? "",
    proofCopyDigest: controlDigest({
      proof: json(f.slot, "proof.json", 65536),
      manifest: json(f.slot, "manifest.json", 32768),
      commit: json(f.slot, "commit.json", 8192),
      final: json(f.slot, "final.json", 8192),
    }),
    sequence: (old?.sequence ?? 0) + 1,
  };
  cell(
    f.shared,
    `ack-${f.state.installation.role}.json`,
    signed(f.state, "openmapx-retention-ack-v1", value),
    4096,
  );
  p.phase = phase;
  progress(f, p);
}
function publishCandidate(
  f: Family,
  p: Progress,
  staged?: StagedCoordinatorRetirementPacket,
): Candidate | null {
  const terminalAt = p.terminalAt;
  if (
    Date.now() < f.meta.origin.notAfter ||
    Date.now() - terminalAt < LIMITS.minimumTerminalRetentionMs ||
    !localProof(f, p)
  )
    return null;
  let sharedPage: unknown[] = [],
    sharedPageNumber = 0,
    sharedCount = 0;
  const flush = () => {
    cell(
      f.shared,
      `shared-${f.state.installation.role}-${sharedPageNumber++}.json`,
      sharedPage,
      16384,
    );
    sharedPage = [];
  };
  for (const e of records(f)) {
    if (e.state !== "written") return null;
    const d = recordDirectory(f, e);
    try {
      if (e.directory) {
        const child = d.dir.directory(e.name);
        try {
          if (!sameInode(identity(child.stat), e.inode))
            throw Error("Retirement directory replaced");
        } finally {
          child.close();
        }
      } else if (
        !sameInode(d.dir.fileIdentity(e.name), e.inode) ||
        controlDigest(d.dir.read(e.name, recordMaximum(e)).toString("utf8")) !== e.digest
      )
        throw Error("Retirement record replaced");
    } finally {
      d.close();
    }
    if (e.scope === "shared") {
      if (++sharedCount > 2048) throw Error("Shared retirement record workspace exhausted");
      sharedPage.push(tuple(e));
      if (sharedPage.length === 64) flush();
    }
  }
  if (sharedPage.length) flush();
  while (sharedPageNumber < 32) flush();
  const executionReceiptDigests = Object.fromEntries(
    Object.entries(p.executions).map(([id, e]) => [id, e.terminalDigest ?? e.receiptDigest]),
  );
  const candidate: Candidate = {
    version: 1,
    installationId: f.state.installation.installationId,
    familyId: f.meta.familyId,
    generation: f.meta.generation,
    role: f.state.installation.role,
    originDigest: f.originHash,
    terminalAt,
    terminalSequenceDigest: controlDigest([
      ...Object.values(p.executions).map((e) => ({
        execution: e.execution,
        terminalAt: e.terminalAt,
        digest: e.terminalDigest ?? e.receiptDigest,
      })),
    ]),
    executionReceiptDigests,
    leaseDigests: Object.fromEntries(
      Object.values(p.leases).map((l) => [l.id, l.certificateDigest]),
    ),
    intentDigests: Object.fromEntries(Object.values(p.intents).map((i) => [i.id, i.childDigest])),
    localRecordSetDigest: recordSetDigest(records(f)),
    sharedRecordSetDigest: recordSetDigest(readSharedRecords(f, f.state.installation.role)),
    ...(staged ? { stagedCoordinatorDependency: staged } : {}),
  };
  cell(
    f.shared,
    `candidate-${f.state.installation.role}.json`,
    signed(f.state, "openmapx-retention-candidate-v1", candidate),
    65536,
  );
  return candidate;
}
function* readSharedRecords(f: Family, role: ControlIssuer): Generator<FamilyRecord> {
  for (let page = 0; page < 32; page++) {
    const values = json<unknown[]>(f.shared, `shared-${role}-${page}.json`, 16384);
    if (!Array.isArray(values) || values.length > 64) throw Error("Corrupt shared ownership page");
    for (const value of values) yield entry(value);
  }
}
function prepare(f: Family, p: Progress): boolean {
  if (f.state.installation.role !== f.meta.origin.issuer || f.state.fixedChildId) return false;
  return guard(f.shared, ".membership-writer", () => {
    if (decision(f).phase !== "active") return true;
    const candidates: Candidate[] = [];
    for (const role of p.participants) {
      const raw = json<unknown>(f.shared, `candidate-${role}.json`, 65536);
      if (raw === null) return false;
      const c = verified<Candidate>(f.state, role, "openmapx-retention-candidate-v1", raw);
      sameFamily(f, c);
      if (
        c.role !== role ||
        c.installationId !== f.state.installation.installationId ||
        Date.now() - c.terminalAt < LIMITS.minimumTerminalRetentionMs
      )
        return false;
      if (recordSetDigest(readSharedRecords(f, role)) !== c.sharedRecordSetDigest)
        throw Error("Shared ownership digest conflict");
      candidates.push(c);
    }
    const receipts = Object.assign(
      {},
      ...candidates.map((c) => c.executionReceiptDigests),
    ) as Record<string, string>;
    const executions = readAllTickets(f, "executions", LIMITS.executionsPerFamily);
    const intents = readAllTickets(f, "intents", LIMITS.intentsPerFamily);
    if (
      Object.keys(receipts).length !== executions.length ||
      executions.some((t) => !receipts[t.id]) ||
      intents.some((t) => !receipts[(t.value as { childDigest: string }).childDigest])
    )
      return false;
    const intentDigests = Object.fromEntries(
      Object.entries(
        Object.assign({}, ...candidates.map((c) => c.intentDigests)) as Record<string, string>,
      ),
    );
    if (
      Object.keys(intentDigests).length !== intents.length ||
      Object.values(intentDigests).some((id) => !receipts[id]) ||
      intents.some((t) => intentDigests[t.id] !== (t.value as { childDigest: string }).childDigest)
    )
      return false;
    const leaseDigests = Object.assign({}, ...candidates.map((c) => c.leaseDigests)) as Record<
        string,
        string
      >,
      leases = readAllTickets(f, "leases", LIMITS.executionsPerFamily);
    if (
      Object.keys(leaseDigests).length !== leases.length ||
      leases.some(
        (t) => leaseDigests[t.id] !== (t.value as { certificateDigest: string }).certificateDigest,
      )
    )
      return false;
    const external: string[] = [];
    if (p.api) {
      const a = apiCopy(f, p);
      const root = Object.values(p.executions).find(
        (e) => e.execution.operationKey === p.api?.operationKey,
      );
      if (
        !a ||
        !root?.terminalDigest ||
        a.operationKey !== p.api.operationKey ||
        a.fingerprint !== p.api.fingerprint ||
        a.terminalDigest !== root.terminalDigest
      )
        return false;
      external.push(`api:${p.api.parent.apiJobId}:${p.api.parent.attemptId}`);
    }
    const m: Manifest = {
      version: 1,
      installationId: f.state.installation.installationId,
      origin: f.meta.origin,
      familyId: f.meta.familyId,
      generation: f.meta.generation,
      sequence: 1,
      terminalAt: Math.max(...candidates.map((c) => c.terminalAt)),
      terminalSequenceDigest: controlDigest({
        roles: candidates.map((c) => c.terminalSequenceDigest),
        api: p.api ? apiCopy(f, p) : null,
      }),
      participants: [...p.participants, ...external],
      executionReceiptDigests: receipts,
      sharedRecordSetDigest: controlDigest(candidates.map((c) => c.sharedRecordSetDigest)),
      localRecordSetDigests: Object.fromEntries(
        candidates.map((c) => [c.role, c.localRecordSetDigest]),
      ),
      ...(candidates.find((c) => c.role === "ops-agent")?.stagedCoordinatorDependency
        ? {
            stagedCoordinatorDependencyDigest: controlDigest(
              candidates.find((c) => c.role === "ops-agent")!.stagedCoordinatorDependency,
            ),
          }
        : {}),
    };
    advanceRetentionClock(f.state, f.meta.origin.notAfter);
    const envelope = signed(f.state, "openmapx-retention-manifest-v1", m);
    cell(f.slot, "manifest.json", envelope, 32768);
    cell(f.shared, "manifest.json", envelope, 32768);
    writeDecision(f, {
      version: 1,
      familyId: f.meta.familyId,
      generation: f.meta.generation,
      phase: "prepared",
      manifestDigest: controlDigest(m),
      sequence: 1,
    });
    p.phase = "prepared";
    p.manifestDigest = controlDigest(m);
    progress(f, p);
    return true;
  });
}
function roleIds(m: Manifest): ControlIssuer[] {
  return m.participants.filter((p): p is ControlIssuer => ROLES.includes(p as ControlIssuer));
}
function validateAck(_f: Family, m: Manifest, a: Ack | null, phase: Ack["phase"]): a is Ack {
  return (
    !!a &&
    a.phase === phase &&
    a.manifestDigest === controlDigest(m) &&
    a.terminalSequenceDigest === m.terminalSequenceDigest &&
    a.recordSetDigest === m.localRecordSetDigests[a.role]
  );
}
function unlinkShared(f: Family, p: Progress, e: FamilyRecord) {
  const previous = p.sharedTransaction;
  if (
    previous &&
    (previous.ordinal !== e.ordinal || controlDigest(previous.record) !== controlDigest(e))
  )
    throw Error("Shared retirement transaction conflict");
  const d = recordDirectory(f, e);
  try {
    if (!previous) {
      // Absence is resumable only after this exact item has a durable plan.
      if (e.directory) {
        const child = d.dir.directory(e.name);
        try {
          if (!sameInode(identity(child.stat), e.inode))
            throw Error("Replaced retirement directory");
          if (
            e.generation &&
            json<{ generation: string }>(child, "generation.json", 1024).generation !== e.generation
          )
            throw Error("Reused history slot generation");
        } finally {
          child.close();
        }
      } else if (
        !sameInode(d.dir.fileIdentity(e.name), e.inode) ||
        controlDigest(d.dir.read(e.name, recordMaximum(e)).toString("utf8")) !== e.digest
      )
        throw Error("Replaced shared retirement record");
      p.sharedTransaction = { ordinal: e.ordinal, phase: "planned", record: e };
      progress(f, p);
    }
    if (p.sharedTransaction?.phase === "planned") {
      try {
        if (e.directory) {
          const child = d.dir.directory(e.name);
          try {
            if (!sameInode(identity(child.stat), e.inode))
              throw Error("Replaced retirement directory");
          } finally {
            child.close();
          }
          if (e.generation) {
            const child = d.dir.directory(e.name);
            try {
              try {
                const g = json<{ generation: string }>(child, "generation.json", 1024);
                if (g.generation !== e.generation) throw Error("Reused history slot generation");
                child.removeFile("generation.json");
              } catch (error) {
                if (!missing(error)) throw error;
              }
            } finally {
              child.close();
            }
          }
          d.dir.removeDirectory(e.name, e.inode);
        } else {
          if (
            !sameInode(d.dir.fileIdentity(e.name), e.inode) ||
            controlDigest(d.dir.read(e.name, recordMaximum(e)).toString("utf8")) !== e.digest
          )
            throw Error("Replaced shared retirement record");
          d.dir.removeFile(e.name);
        }
      } catch (error) {
        if (!missing(error)) throw error;
      }
      p.sharedTransaction = { ordinal: e.ordinal, phase: "unlinked", record: e };
      progress(f, p);
    }
    p.sharedCursor++;
    delete p.sharedTransaction;
    progress(f, p);
  } finally {
    d.close();
  }
}
function cleanupLocalRecords(f: Family, p: Progress, m: Manifest): boolean {
  if (p.lastDone) {
    const dir = f.state.privateRoot.directory(p.lastDone.namespace);
    try {
      finishRetainedDeletion(dir, {
        ...p.lastDone,
        familyId: f.meta.familyId,
        generation: f.meta.generation,
        manifestDigest: controlDigest(m),
      });
    } finally {
      dir.close();
    }
    delete p.lastDone;
    progress(f, p);
  }
  let remaining = 64;
  while (p.cursor < p.records && remaining--) {
    const page = json<unknown[]>(f.slot, `page-${Math.floor(p.cursor / 64)}.json`, 16384);
    const e = entry(page[p.cursor % 64]);
    if (e.ordinal !== p.cursor) throw Error("Missing local cleanup ordinal");
    if (e.scope !== "private") {
      p.cursor++;
      progress(f, p);
      continue;
    }
    const d = recordDirectory(f, e);
    try {
      deleteRetainedRecord(
        d.dir,
        {
          familyId: f.meta.familyId,
          generation: f.meta.generation,
          manifestDigest: controlDigest(m),
          ordinal: e.ordinal,
          name: e.name,
          inode: e.inode,
          digest: e.digest,
        },
        () => {
          p.cursor++;
          p.lastDone = {
            namespace: e.namespace,
            ordinal: e.ordinal,
            name: e.name,
            inode: e.inode,
            digest: e.digest,
          };
          progress(f, p);
        },
        recordMaximum(e),
      );
      delete p.lastDone;
      progress(f, p);
    } finally {
      d.close();
    }
  }
  return p.cursor === p.records;
}
function cleanupSharedRecords(f: Family, p: Progress, m: Manifest): boolean {
  // Four fixed passes preserve physical containment: files, ledger subdirs,
  // ledger roots, then history slots. Resume uses the same fixed ordinal space
  // and reads one <=16KiB ownership page at a time.
  const roles = roleIds(m),
    perPass = roles.length * 2048,
    total = perPass * 4;
  let budget = 64,
    dirty = false;
  const passFor = (e: FamilyRecord) =>
    !e.directory ? 0 : e.namespace === "history-slot" ? 3 : e.name === e.container ? 2 : 1;
  let cached = "",
    page: unknown[] = [];
  while (p.sharedCursor < total && budget > 0) {
    const cursor = p.sharedCursor,
      pass = Math.floor(cursor / perPass),
      within = cursor % perPass,
      role = roles[Math.floor(within / 2048)],
      offset = within % 2048,
      pageNumber = Math.floor(offset / 64),
      key = `${role}:${pageNumber}`;
    if (!role) throw Error("Invalid shared cleanup role cursor");
    if (cached !== key) {
      page = json<unknown[]>(f.shared, `shared-${role}-${pageNumber}.json`, 16384);
      if (!Array.isArray(page) || page.length > 64) throw Error("Corrupt shared cleanup page");
      cached = key;
    }
    const value = page[offset % 64];
    if (value === undefined) {
      p.sharedCursor += 64 - (offset % 64);
      dirty = true;
      continue;
    }
    const e = entry(value);
    if (passFor(e) !== pass) {
      p.sharedCursor++;
      dirty = true;
      continue;
    }
    if (dirty) {
      progress(f, p);
      dirty = false;
    }
    unlinkShared(f, p, { ...e, ordinal: cursor });
    budget--;
  }
  if (dirty) progress(f, p);
  return p.sharedCursor === total;
}
const SLOT_FILES = [
  ...Array.from({ length: 64 }, (_, n) => `page-${n}.json`),
  "manifest.json",
  "commit.json",
  "final.json",
  "proof.json",
  "progress.json",
  "progress-highwater.json",
  "identity.json",
];
interface SlotRelease {
  familyId: string;
  generation: string;
  slotGeneration: string;
  name: string;
  inode: FileIdentity;
  originHash: string;
  role: ControlIssuer;
  proof: unknown;
  phase: "planned" | "item_done";
}
function resumeSlotRelease(state: InstallationState): boolean {
  return guard(state.privateRoot, ".retention-slot-writer", () => {
    const t = json<SlotRelease | null>(state.privateRoot, "retention-slot-transaction.json", 4096);
    if (t === null) return false;
    if (
      !slotName.test(t.name) ||
      !DIGEST.test(t.originHash) ||
      !ROLES.includes(t.role) ||
      !z.uuid().safeParse(t.slotGeneration).success
    )
      throw Error("Corrupt family slot transaction");
    const proof = verified<Decision & { semanticClean?: boolean }>(
      state,
      t.role,
      "openmapx-retention-decision-v1",
      t.proof,
    );
    if (
      proof.familyId !== t.familyId ||
      proof.generation !== t.generation ||
      proof.phase !== "final" ||
      !proof.semanticClean
    )
      throw Error("Invalid final slot-release proof");
    const slots = state.privateRoot.directory("retention-families");
    try {
      let slot: AnchoredDirectory | undefined;
      try {
        slot = slots.directory(t.name);
      } catch (e) {
        if (!missing(e)) throw e;
      }
      if (slot) {
        try {
          if (!sameInode(identity(slot.stat), t.inode))
            throw Error("Slot transaction inode replaced");
          try {
            const id = json<{ familyId: string; generation: string; slotGeneration: string }>(
              slot,
              "identity.json",
              2048,
            );
            if (
              id.familyId !== t.familyId ||
              id.generation !== t.generation ||
              id.slotGeneration !== t.slotGeneration
            )
              throw Error("Slot transaction generation replaced");
          } catch (e) {
            if (!missing(e)) throw e;
          }
          for (const name of SLOT_FILES)
            try {
              slot.removeFile(name);
            } catch (e) {
              if (!missing(e)) throw e;
            }
        } finally {
          slot.close();
        }
        slots.removeDirectory(t.name, t.inode);
      }
      const loc = state.privateRoot.directory("retention-locations");
      try {
        try {
          loc.removeFile(`${t.originHash}.json`);
        } catch (e) {
          if (!missing(e)) throw e;
        }
      } finally {
        loc.close();
      }
      cell(
        state.privateRoot,
        "retention-slot-transaction.json",
        { ...t, phase: "item_done" },
        4096,
      );
      cell(state.privateRoot, "retention-slot-transaction.json", null, 4096);
      return true;
    } finally {
      slots.close();
    }
  });
}
function freeFamily(f: Family, _p: Progress): void {
  guard(f.state.privateRoot, ".retention-slot-writer", () => {
    if (json(f.state.privateRoot, "retention-slot-transaction.json", 4096) !== null)
      throw Error("Other slot transaction pending");
    checkLocalIdentity(f);
    const t: SlotRelease = {
      familyId: f.meta.familyId,
      generation: f.meta.generation,
      slotGeneration: f.slotGeneration,
      name: f.name,
      inode: f.slotIdentity,
      originHash: f.originHash,
      role: f.meta.origin.issuer,
      proof: json(f.slot, "final.json", 8192),
      phase: "planned",
    };
    cell(f.state.privateRoot, "retention-slot-transaction.json", t, 4096);
  });
  resumeSlotRelease(f.state);
}
function freeSharedWorkspace(f: Family, p: Progress, m: Manifest): void {
  if (f.sharedGone) return;
  p.sharedRelease = true;
  progress(f, p);
  const names = [
    "identity.json",
    "decision.json",
    "manifest.json",
    "api-ack.json",
    ...roleIds(m).flatMap((role) => [
      `ack-${role}.json`,
      `candidate-${role}.json`,
      ...Array.from({ length: 32 }, (_, n) => `shared-${role}-${n}.json`),
    ]),
  ];
  for (const kind of ["executions", "intents", "leases"] as const) {
    let dir: AnchoredDirectory;
    try {
      dir = f.shared.directory(kind);
    } catch (e) {
      if (missing(e)) continue;
      throw e;
    }
    try {
      const max = kind === "intents" ? 256 : 128;
      for (let n = 0; n < max; n++)
        try {
          dir.removeFile(`slot-${n}.json`);
        } catch (e) {
          if (!missing(e)) throw e;
        }
      const inode = identity(dir.stat);
      dir.close();
      f.shared.removeDirectory(kind, inode);
    } finally {
      dir.close();
    }
  }
  for (const name of names)
    try {
      f.shared.removeFile(name);
    } catch (e) {
      if (!missing(e)) throw e;
    }
  try {
    f.sharedRoot.removeDirectory(f.originHash, identity(f.shared.stat));
  } catch (e) {
    if (!missing(e)) throw e;
  }
}
function assertPrivateRetirementProof(f: Family, m: Manifest): void {
  const local = verifyControl(
    f.state.publicKeys[f.meta.origin.issuer],
    "openmapx-retention-manifest-v1",
    json(f.slot, "manifest.json", 32768),
    z.unknown(),
  );
  if (controlDigest(local) !== controlDigest(m))
    throw Error("Private retirement manifest copy changed");
  const proof = verified<Candidate>(
    f.state,
    f.state.installation.role,
    "openmapx-retention-candidate-v1",
    json(f.slot, "proof.json", 65536),
  );
  sameFamily(f, proof);
  if (
    proof.role !== f.state.installation.role ||
    proof.localRecordSetDigest !== m.localRecordSetDigests[proof.role] ||
    Object.entries(proof.executionReceiptDigests).some(
      ([id, digest]) => m.executionReceiptDigests[id] !== digest,
    )
  )
    throw Error("Private terminal proof copy changed");
  if (proof.role === "ops-agent") {
    if (proof.stagedCoordinatorDependency) {
      const checked = verifiedStagedRetirementPacket(
        f,
        readProgress(f),
        proof.stagedCoordinatorDependency,
      );
      if (
        checked.value.contextMode !== "preparing" ||
        checked.value.manifestDigest !== null ||
        controlDigest(checked.packet) !== m.stagedCoordinatorDependencyDigest
      )
        throw Error("Staged candidate/manifest conflict");
    } else if (m.stagedCoordinatorDependencyDigest)
      throw Error("Original staged candidate required");
  }
}
async function step(f: Family): Promise<boolean> {
  if (f.state.fixedChildId) throw Error("Fixed children do not coordinate role-private retirement");
  let p = readProgress(f);
  const initialDecision =
    p.phase === "released" && p.sharedRelease
      ? verified<Decision>(
          f.state,
          f.meta.origin.issuer,
          "openmapx-retention-decision-v1",
          json(f.slot, "final.json", 8192),
        )
      : decision(f);
  let staged: StagedCoordinatorRetirementPacket | undefined;
  if (initialDecision.phase === "committed" || initialDecision.phase === "final") {
    const committedManifest =
      p.phase === "released" && p.sharedRelease
        ? verified<Manifest>(
            f.state,
            f.meta.origin.issuer,
            "openmapx-retention-manifest-v1",
            json(f.slot, "manifest.json", 32768),
          )
        : manifest(f);
    await prepareJournalPhase(f, p, "committed-cleanup", committedManifest);
  } else if (p.phase === "active" || p.phase === "prepared")
    staged = await prepareJournalPhase(f, p, "preparing");
  checkLocalIdentity(f);
  if (p.phase === "released" && f.state.installation.role !== f.meta.origin.issuer) {
    freeFamily(f, p);
    return true;
  }
  if (p.phase === "released" && p.sharedRelease) {
    const m = verified<Manifest>(
      f.state,
      f.meta.origin.issuer,
      "openmapx-retention-manifest-v1",
      json(f.slot, "manifest.json", 32768),
    );
    freeSharedWorkspace(f, p, m);
    freeFamily(f, p);
    return true;
  }
  const d = decision(f);
  if (d.phase === "active") {
    guard(f.slot, ".family-writer", () => {
      if (readProgress(f).sequence !== p.sequence)
        throw Error("Collector preparation sequence changed");
      return publishCandidate(f, p, staged);
    });
    if (!prepare(f, p)) return false;
    p = readProgress(f);
  }
  const m = manifest(f),
    md = controlDigest(m);
  if (decision(f).manifestDigest !== md) throw Error("Manifest/decision digest conflict");
  if (p.phase === "active" || p.phase === "prepared") {
    for (const e of records(f)) if (e.state !== "written") return false;
    if (
      recordSetDigest(records(f)) !== m.localRecordSetDigests[f.state.installation.role] ||
      !localProof(f, p)
    )
      return false;
    cell(f.slot, "manifest.json", json(f.shared, "manifest.json", 32768), 32768);
    cell(
      f.slot,
      "proof.json",
      json(f.shared, `candidate-${f.state.installation.role}.json`, 65536),
      65536,
    );
    p.manifestDigest = md;
    publishAck(f, p, m, "ready");
  }
  assertPrivateRetirementProof(f, m);
  if (f.state.installation.role === f.meta.origin.issuer && decision(f).phase === "prepared") {
    const readyDigests: Record<string, string> = {};
    for (const role of roleIds(m)) {
      const a = ack(f, role);
      if (!validateAck(f, m, a, "ready")) return false;
      readyDigests[role] = controlDigest(a);
    }
    const revalidation = await prepareJournalPhase(f, p, "before-commit", m);
    if (m.stagedCoordinatorDependencyDigest) {
      if (!revalidation) throw Error("Fresh staged retirement revalidation required");
      p.stagedCoordinatorRevalidation = revalidation;
      guard(f.slot, ".family-writer", () => progress(f, p));
    } else if (revalidation) throw Error("Unbound staged retirement revalidation");
    writeDecision(f, {
      version: 1,
      familyId: f.meta.familyId,
      generation: f.meta.generation,
      phase: "committed",
      manifestDigest: md,
      readyDigests,
      sequence: 2,
      ...(revalidation ? { stagedCoordinatorRevalidationDigest: controlDigest(revalidation) } : {}),
    });
  }
  if (decision(f).phase === "prepared") return false;
  if (p.phase === "ready" || p.phase === "committed") {
    const commit = decision(f);
    if (commit.phase !== "committed" && commit.phase !== "final") return false;
    assertStagedCommittedCleanup(f, p, m, commit);
    cell(f.slot, "commit.json", json(f.shared, "decision.json", 8192), 8192);
    advanceRetentionClock(f.state, f.meta.origin.notAfter);
    p.phase = "committed";
    progress(f, p);
    if (!cleanupLocalRecords(f, p, m)) return false;
    if (Object.values(p.executions).some((e) => e.requiresJournal) && !p.journalClean) {
      if (!f.state.retentionJournal) return false;
      p.journalCleanupPlanned = true;
      progress(f, p);
      await f.state.retentionJournal.retire(
        Object.values(p.executions)
          .filter((e) => e.requiresJournal)
          .map((e) => {
            if (!e.terminalDigest) throw Error("Missing retiring terminal digest");
            return {
              execution: e.execution,
              digest: e.terminalDigest,
              terminalAt: e.canonicalTerminalAt,
            };
          }),
        md,
      );
      p = readProgress(f);
      p.journalClean = true;
      progress(f, p);
    }
    publishAck(f, p, m, "clean");
  }
  if (f.state.installation.role === f.meta.origin.issuer && decision(f).phase === "committed") {
    const cleanDigests: Record<string, string> = {};
    for (const role of roleIds(m)) {
      const a = ack(f, role);
      if (!validateAck(f, m, a, "clean")) return false;
      cleanDigests[role] = controlDigest(a);
    }
    writeDecision(f, {
      version: 1,
      familyId: f.meta.familyId,
      generation: f.meta.generation,
      phase: "final",
      manifestDigest: md,
      cleanDigests,
      sequence: 3,
    });
  }
  if (decision(f).phase !== "final") return false;
  if (f.state.installation.role === f.meta.origin.issuer && !cleanupSharedRecords(f, p, m))
    return false;
  // Participants can release only after coordinator's final semantic cleanup.
  if (f.state.installation.role === f.meta.origin.issuer) {
    cell(
      f.shared,
      "decision.json",
      signed(f.state, "openmapx-retention-decision-v1", { ...decision(f), semanticClean: true }),
      8192,
    );
  }
  const final = decision(f) as Decision & { semanticClean?: boolean };
  if (!final.semanticClean) return false;
  cell(f.slot, "final.json", json(f.shared, "decision.json", 8192), 8192);
  if (p.phase !== "released") publishAck(f, p, m, "released");
  if (f.state.installation.role !== f.meta.origin.issuer) {
    freeFamily(f, p);
    return true;
  }
  for (const role of roleIds(m)) if (!validateAck(f, m, ack(f, role), "released")) return false;
  freeSharedWorkspace(f, p, m);
  freeFamily(f, p);
  return true;
}
export async function reconcileRetentionFamilies(
  state: InstallationState,
  options: { signal?: AbortSignal; maxFamilies?: number } = {},
): Promise<{ retired: number; pending: number; busy?: true }> {
  const max = options.maxFamilies ?? 16;
  if (!Number.isSafeInteger(max) || max < 1 || max > 64)
    throw Error("Invalid retention maxFamilies");
  options.signal?.throwIfAborted();
  try {
    mkdirSync(state.privateRoot.name(".retention-reconcile-writer"), { mode: 0o700 });
    fsyncSync(state.privateRoot.fd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      return { retired: 0, pending: 1, busy: true };
    throw error;
  }
  const held = state.privateRoot.directory(".retention-reconcile-writer"),
    expected = identity(held.stat);
  try {
    return await reconcileRetentionFamiliesLocked(state, options);
  } finally {
    held.close();
    state.privateRoot.removeDirectory(".retention-reconcile-writer", expected);
  }
}
async function reconcileRetentionFamiliesLocked(
  state: InstallationState,
  options: { signal?: AbortSignal; maxFamilies?: number } = {},
): Promise<{ retired: number; pending: number }> {
  const max = options.maxFamilies ?? 16;
  if (!Number.isSafeInteger(max) || max < 1 || max > 64)
    throw Error("Invalid retention maxFamilies");
  const clock = readRetentionClock(state);
  if (Date.now() < clock.lastRetirementWallTime)
    throw Error("Wall clock moved backward; retention recovery prerequisite");
  const recovered = resumeSlotRelease(state);
  const cursorName = "retention-cursor.json";
  let cursor = json<number>(state.privateRoot, cursorName, 64);
  if (!Number.isInteger(cursor) || cursor < 0 || cursor >= 1024)
    throw Error("Invalid retention cursor");
  let retired = recovered ? 1 : 0,
    pending = 0,
    seen = 0;
  let slots: AnchoredDirectory;
  try {
    slots = state.privateRoot.directory("retention-families");
  } catch (e) {
    if (missing(e)) return { retired, pending };
    throw e;
  }
  try {
    for (let scanned = 0; scanned < 1024 && seen < max; scanned++) {
      options.signal?.throwIfAborted();
      const name = `slot-${cursor}`;
      cursor = (cursor + 1) % 1024;
      let slot: AnchoredDirectory;
      try {
        slot = slots.directory(name);
      } catch (e) {
        if (missing(e)) continue;
        throw e;
      }
      let hash: string | undefined;
      try {
        const local = json<{ originHash?: string }>(slot, "identity.json", 2048);
        hash = local.originHash;
      } catch {
        seen++;
        pending++;
      } finally {
        slot.close();
      }
      if (!hash) {
        if (hash === undefined && seen === 0) {
          /* old partial index stays reserved */
        }
        continue;
      }
      seen++;
      try {
        const locations = state.privateRoot.directory("retention-locations");
        let meta: SharedIdentity;
        try {
          const loc = json<{ identity: unknown }>(locations, `${hash}.json`, 4096);
          const candidate = (loc.identity as { payload: SharedIdentity }).payload;
          meta = verifyControl(
            state.publicKeys[candidate.origin.issuer],
            "openmapx-retention-family-v1",
            loc.identity,
            sharedIdentitySchema,
          );
        } finally {
          locations.close();
        }
        const f = openFamily(state, meta.origin);
        try {
          if (await step(f)) retired++;
          else pending++;
        } catch (error) {
          try {
            guard(f.slot, ".family-writer", () => {
              const p = readProgress(f);
              p.lastError = String(error).slice(0, 512);
              progress(f, p);
            });
          } catch {}
          throw error;
        } finally {
          f.close();
        }
      } catch {
        pending++;
      }
    }
  } finally {
    cell(state.privateRoot, cursorName, cursor, 64);
    slots.close();
  }
  return { retired, pending };
}
/** Exact retained API dependency lookup; absence proof is bounded by the active family slots. */
export function retentionApiDependency(
  state: InstallationState,
  origin: ControlExecutionOrigin,
): ApiDependency | undefined {
  const f = openFamily(state, origin);
  try {
    return readProgress(f).api;
  } finally {
    f.close();
  }
}
/** Fixed staged-provenance reader. The role-signed API copy and complete
 * family membership must still be active; this grants no forward authority. */
export function readActiveStagedCoordinatorApiCopy(
  state: InstallationState,
  origin: ControlExecutionOrigin,
  execution: ExecutionRef,
  terminalDigest: string,
  parent: RetainedParentExecution,
  context?: ControlRetentionPreparationContext,
) {
  const f = openFamily(state, origin);
  try {
    const p = readProgress(f),
      d = decision(f),
      fact = p.executions[controlDigest(execution)],
      copy = apiCopy(f, p);
    const preparing = sourcePreparationContextAllows(context, state, origin, execution, p.sequence);
    if (
      (!preparing && (p.phase !== "active" || d.phase !== "active")) ||
      (preparing &&
        (!["active", "prepared", "ready"].includes(p.phase) ||
          !["active", "prepared"].includes(d.phase))) ||
      !fact?.known ||
      canonicalJson(fact.execution) !== canonicalJson(execution) ||
      fact.terminalDigest !== terminalDigest ||
      fact.canonicalDigest !== terminalDigest ||
      !fact.journalContained ||
      !copy ||
      copy.terminalDigest !== terminalDigest ||
      copy.operationKey !== execution.operationKey ||
      copy.fingerprint !== execution.fingerprint ||
      canonicalJson(p.api?.parent) !== canonicalJson(parent)
    )
      throw Error("Actual active staged coordinator API copy required");
    return {
      origin: f.meta.origin,
      familyId: f.meta.familyId,
      generation: f.meta.generation,
      apiCopyDigest: controlDigest(json(f.shared, "api-ack.json", 4096)),
    };
  } finally {
    f.close();
  }
}
export function acknowledgeRetentionDependency(
  state: InstallationState,
  origin: ControlExecutionOrigin,
  input: { operationKey: string; fingerprint: string; terminalDigest: string; proofDigest: string },
) {
  const f = openFamily(state, origin);
  try {
    guard(f.slot, ".family-writer", () => {
      const p = readProgress(f),
        dep = p.api,
        fact = Object.values(p.executions).find(
          (e) => e.execution.operationKey === input.operationKey,
        );
      if (
        !dep ||
        dep.operationKey !== input.operationKey ||
        dep.fingerprint !== input.fingerprint ||
        !fact?.terminalDigest ||
        fact.canonicalDigest !== fact.terminalDigest ||
        !fact.terminalAt ||
        fact.terminalDigest !== input.terminalDigest
      )
        throw Error("API terminal dependency conflict");
      const payload = apiCopySchema.parse({
        version: 1,
        installationId: f.meta.installationId,
        familyId: f.meta.familyId,
        generation: f.meta.generation,
        originDigest: f.originHash,
        parentDigest: controlDigest(dep.parent),
        ...input,
      });
      const old = apiCopy(f, p);
      if (old) {
        if (controlDigest(old) !== controlDigest(payload))
          throw Error("Conflicting API receipt acknowledgement");
        return;
      }
      if (decision(f).phase !== "active")
        throw Error("Missing committed API acknowledgement proof");
      p.apiAck = { terminalDigest: input.terminalDigest, proofDigest: input.proofDigest };
      progress(f, p);
      cell(
        f.shared,
        "api-ack.json",
        signed(state, "openmapx-retention-api-copy-v1", payload),
        4096,
      );
    });
  } finally {
    f.close();
  }
}
export function hasRetentionEvidence(
  state: InstallationState,
  origin: ControlExecutionOrigin,
): boolean {
  const hash = originHash(origin),
    transaction = json<{ originHash?: string } | null>(
      state.privateRoot,
      "retention-slot-transaction.json",
      4096,
    );
  if (transaction && (transaction.originHash === hash || !transaction.originHash)) return true;
  let locations: AnchoredDirectory | undefined;
  try {
    locations = state.privateRoot.directory("retention-locations");
    locations.fileIdentity(`${hash}.json`);
    return true;
  } catch (error) {
    if (!missing(error)) throw error;
  } finally {
    locations?.close();
  }
  let slots: AnchoredDirectory | undefined;
  try {
    slots = state.privateRoot.directory("retention-families");
    for (let n = 0; n < 1024; n++) {
      let slot: AnchoredDirectory;
      try {
        slot = slots.directory(`slot-${n}`);
      } catch (error) {
        if (missing(error)) continue;
        throw error;
      }
      try {
        let id: { originHash: string };
        try {
          id = json(slot, "identity.json", 2048);
        } catch {
          throw Error("Partial family index requires recovery");
        }
        if (!DIGEST.test(id.originHash)) throw Error("Corrupt partial family index");
        if (id.originHash === hash) return true;
      } finally {
        slot.close();
      }
    }
  } catch (error) {
    if (!missing(error)) throw error;
  } finally {
    slots?.close();
  }
  const opened: AnchoredDirectory[] = [];
  const own = (dir: AnchoredDirectory) => {
    opened.push(dir);
    return dir;
  };
  try {
    const root = own(new AnchoredDirectory(state.dataRoot)),
      control = own(root.directory(".admin-target-control"));
    try {
      const families = own(control.directory("retention-families")),
        shared = own(families.directory(hash));
      shared.check();
      return true;
    } catch (error) {
      if (!missing(error)) throw error;
    }
    try {
      const executions = own(control.directory("executions")),
        role = own(executions.directory(origin.issuer));
      for (const suffix of [
        ".json",
        ".lifecycle.json",
        ".children.json",
        ".keys.json",
        ".prepared.json",
      ])
        try {
          role.fileIdentity(`${origin.rootKey}${suffix}`);
          return true;
        } catch (error) {
          if (!missing(error)) throw error;
        }
    } catch (error) {
      if (!missing(error)) throw error;
    }
    return false;
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  } finally {
    for (const dir of opened.reverse()) dir.close();
  }
}
