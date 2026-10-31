/** Fixed, role-local receipt ownership and preallocated per-origin retirement cells. */
import { createHash, randomUUID } from "node:crypto";
import { fsyncSync, mkdirSync, statfsSync } from "node:fs";
import { z } from "zod";
import { canonicalJson } from "../ops/canonical-json";
import type { ControlExecutionOrigin } from "../ops/control-root-key";
import {
  type ControlIssuer,
  type ExecutionRef,
  executionFingerprint,
  type RetainedParentExecution,
} from "../ops/execution-identity";
import { executionRefSchema } from "../ops/execution-ref";
import {
  type ConfigurationSettlementFamilySlot,
  type ConfigurationSettlementProjection,
  type ConfigurationSettlementRecordDescriptor,
  configurationSettlementRecordDescriptors,
} from "./configuration-fence-settlement-descriptors";
import {
  configurationCommittedSettlementSchema,
  configurationDmCapacityCellSchema,
  configurationDmNoGuardRefusalSchema,
  configurationIssuedPrepareRefusedProofSchema,
  configurationIssuerUnusedSourceDigest,
  configurationNeverIssuedProofSchema,
  configurationNoGuardClosureSchema,
  configurationNoGuardIntentSchema,
  configurationSettlementAckSchema,
  configurationSettlementAdmissionSchema,
  configurationSettlementCapacitySchema,
  configurationSettlementCommitmentCellSchema,
  configurationSettlementControlCellSchema,
  configurationSettlementControlEnvelopeSchema,
  configurationSettlementDispatchSchema,
  configurationSettlementDomains,
  configurationSettlementEffectSchema,
  configurationSettlementPublishedTerminalSchema,
  configurationSettlementReservationProjectionSchema,
  configurationSettlementSenderAckCellSchema,
  configurationUnusedCapacityConfirmationSchema,
  configurationUnusedCapacityIntentSchema,
  deriveConfigurationFenceSettlementId,
  configurationSettlementDomains as domains,
  settlementRecordDigest,
} from "./configuration-fence-settlement-records";
import {
  assertConfigurationMaintenanceDecisionSource,
  configurationMaintenanceOwnerRecordSchema,
  configurationMaintenanceReleasedOwner,
  configurationMaintenanceSettleCompletion,
} from "./configuration-maintenance-owner-records";
// biome-ignore-start lint/suspicious/noImportCycles: Indexed completion repair and retirement require actual nominal authority from the same record owner. Parsed roots or caller flags cannot replace it; all calls are deferred.
import {
  type ControlInstallation,
  controlChildOperationKey,
  executionAuthorityState,
  installationState,
  readControlExecutionWitness,
  readPrivateRecord,
  restoreAdmittedControlExecution,
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
  writeRetainedRecord,
} from "./control-retention";
import {
  type ControlRetentionPreparationContext,
  coordinatorPullBaselineSchema,
  type StagedCoordinatorRetirementPacket,
  stagedCoordinatorRetirementDomain,
  stagedCoordinatorRetirementPacketSchema,
  stagedCoordinatorRetirementPayloadSchema,
} from "./coordinator-pull-records";
import { mirrorSchema } from "./data-configuration-fence-records";
import {
  dataConfigurationFencePreparedWitnessDomain,
  dataConfigurationFencePreparedWitnessSchema,
} from "./data-configuration-fence-witness-records";
import { AnchoredDirectory, type FileIdentity, identity, sameInode } from "./filesystem";
import { advanceRetentionClock, readRetentionClock } from "./retention-clock";
// biome-ignore-start lint/suspicious/noImportCycles: Index repair verifies actual physical release/full closure; physical closure verifies this same index. No constructor or verifier runs at module initialization.
import {
  verifyConfigurationFenceSettlementReleasedOwner,
  verifyConfigurationMaintenanceRootClosure,
  verifyRetainedArtifactTargetRootRelease,
} from "./target-lease";

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
  /** One fixed logical control. Its unbound address counts from PREPARE onward,
   * and never masquerades as an ordinary physical execution/lease member. */
  configurationSettlementSlot?: ConfigurationSettlementFamilySlot;
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

// One scoped read-only source observation per coordinator step. Verify outside
// family writers; inside them require the identical local indexed record set.
const preparedClosures = new WeakMap<
  Family,
  ReturnType<typeof readPreparedConfigurationSettlementRetirement> & {
    localRecordSetDigest: string;
  }
>();
function preparedClosure(f: Family, p: Progress) {
  const proof = preparedClosures.get(f);
  return p.configurationSettlementSlot?.state === "bound" &&
    proof &&
    proof.localRecordSetDigest === recordSetDigest(records(f))
    ? proof
    : null;
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
    Object.keys(p.executions).length +
      (p.configurationSettlementSlot?.role === "data-manager" &&
      p.configurationSettlementSlot.executionOrdinal !== null
        ? 1
        : 0) >
      LIMITS.executionsPerFamily ||
    Object.keys(p.intents).length +
      (p.configurationSettlementSlot && p.configurationSettlementSlot.intentOrdinal !== null
        ? 1
        : 0) >
      LIMITS.intentsPerFamily ||
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
function guard<T>(dir: AnchoredDirectory, name: string, run: () => T): T {
  mkdirSync(dir.name(name), { mode: 0o700 });
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
      !owner.inspection ||
      owner.noGuard
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
function settlementSlotTickets(
  f: Family,
  slot: ConfigurationSettlementFamilySlot,
  repairAllocation: boolean,
): void {
  const check = (kind: "executions" | "intents", ordinal: number, id: string) => {
    const dir = f.shared.directory(kind),
      expected = {
        id,
        generation: f.meta.generation,
        value: {
          purpose: "configurationSettlementSlot",
          role: slot.role,
          settlementId: slot.settlementId,
          projectionDigest: slot.projectionDigest,
          address: slot.proposedExecutionAddress,
          executionDigest: slot.executionDigest,
          controlBindingDigest: slot.controlBindingDigest,
          state: slot.state === "allocating" ? "reserved" : slot.state,
          ...(slot.state === "UNUSED" ? { unusedIntentDigest: slot.unusedIntentDigest } : {}),
        },
      };
    try {
      let stored: unknown;
      try {
        stored = json(dir, `slot-${ordinal}.json`, 4096);
      } catch (error) {
        if (!missing(error) || !repairAllocation || slot.state !== "allocating") throw error;
        // Original durable allocation transaction already fixed this ordinal
        // and charged its complete width; never select a replacement ordinal.
        cell(dir, `slot-${ordinal}.json`, expected, 4096, true);
        stored = expected;
      }
      if (canonicalJson(stored) !== canonicalJson(expected))
        throw Error("Original settlement capacity ticket changed");
    } finally {
      dir.close();
    }
  };
  if (slot.role === "data-manager" && slot.executionOrdinal !== null)
    check("executions", slot.executionOrdinal, slot.executionTicketId);
  if (slot.intentOrdinal !== null) check("intents", slot.intentOrdinal, slot.intentTicketId);
}
/** Closed logical-control capacity entry. Its caller is the fixed original
 * owner/verified PREPARE source, never ordinary execution registration. Tickets
 * retain the original address while late execution/binding digests are null. */
export function reserveConfigurationSettlementFamilySlot(
  state: InstallationState,
  projection: ConfigurationSettlementProjection,
  projectionDigest: string,
  prepareExecution: ExecutionRef | undefined,
  descriptors: readonly ConfigurationSettlementRecordDescriptor[],
  stage: "refusal-channel" | "complete" = "complete",
): ConfigurationSettlementFamilySlot {
  if (
    state.fixedChildId ||
    !["ops-agent", "data-manager"].includes(state.installation.role) ||
    projection.origin.issuer !== "ops-agent" ||
    projection.ownerPrepare.operationKey !== projection.origin.rootKey ||
    projection.installationId !== state.installation.installationId ||
    !DIGEST.test(projectionDigest) ||
    descriptors.length !== 6 ||
    descriptors.some(
      (item) =>
        item.role !== state.installation.role ||
        !safeName.test(item.name) ||
        !Number.isSafeInteger(item.cap) ||
        item.cap <= 0 ||
        item.cap > 16384,
    )
  )
    throw Error("Original fixed settlement capacity source required");
  const f = openFamily(state, projection.origin);
  try {
    return guard(f.shared, ".membership-writer", () =>
      guard(f.slot, ".family-writer", () => {
        checkLocalIdentity(f);
        const p = readProgress(f),
          role = state.installation.role as "ops-agent" | "data-manager",
          recordDescriptorsDigest = controlDigest(descriptors),
          address = projection.reservation.execution;
        if (p.configurationSettlementSlot) {
          const old = p.configurationSettlementSlot;
          if (
            old.settlementId !== projection.settlementId ||
            old.projectionDigest !== projectionDigest ||
            old.role !== role ||
            old.recordDescriptorsDigest !== recordDescriptorsDigest ||
            canonicalJson(old.proposedExecutionAddress) !== canonicalJson(address)
          )
            throw Error("Original settlement capacity slot conflict");
          if (
            !["refusal_channel", "capacity_refused", "allocating", "reserved"].includes(old.state)
          )
            throw Error("Settlement capacity already bound/closed");
          if (old.state !== "refusal_channel" || stage === "refusal-channel") {
            settlementSlotTickets(f, old, true);
            return structuredClone(old);
          }
        }
        if (
          p.phase !== "active" ||
          decision(f).phase !== "active" ||
          (role === "data-manager" && !prepareExecution) ||
          !p.executions[
            controlDigest(role === "ops-agent" ? projection.ownerPrepare : prepareExecution!)
          ]
        )
          throw Error("Original settlement family member required");
        const executionTicketId =
            role === "ops-agent"
              ? controlDigest(projection.ownerPrepare)
              : controlDigest({
                  purpose: "configurationSettlementSlot",
                  role,
                  settlementId: projection.settlementId,
                  member: "execution",
                }),
          intentTicketId = controlDigest({
            purpose: "configurationSettlementSlot",
            role,
            settlementId: projection.settlementId,
            member: "intent",
          });
        if (stage === "refusal-channel") {
          if (
            role !== "data-manager" ||
            descriptors[0]?.scope !== "shared" ||
            descriptors[0]?.cap !== 8192 ||
            !descriptors[0].name.endsWith(".configuration-settlement-capacity.json")
          )
            throw Error("Fixed DM refusal channel required");
          if (
            p.metadataBytes + descriptors[0].cap > LIMITS.familyMetadataBytes ||
            p.records >= LIMITS.recordsPerFamily ||
            p.sharedRecords >= 2048
          )
            throw Error("Minimum DM refusal channel unavailable; retain original owner unknown");
          const slot: ConfigurationSettlementFamilySlot = {
            version: 2,
            role,
            settlementId: projection.settlementId,
            projectionDigest,
            reservationDigest: projection.reservationDigest,
            ownerPrepareDigest: controlDigest(projection.ownerPrepare),
            proposedExecutionAddress: address,
            executionOrdinal: null,
            intentOrdinal: null,
            executionTicketId,
            intentTicketId,
            recordDescriptorsDigest,
            descriptors: structuredClone([...descriptors]),
            state: "refusal_channel",
            reservedMetadataBytes: descriptors[0].cap,
            refusalConstraint: null,
            executionDigest: null,
            controlBindingDigest: null,
            allocatedDescriptorDigests: [],
            unusedIntentDigest: null,
            unusedConfirmedAt: null,
          };
          p.configurationSettlementSlot = slot;
          p.metadataBytes += slot.reservedMetadataBytes;
          progress(f, p, true);
          return structuredClone(slot);
        }
        if (role === "data-manager") {
          const base = p.configurationSettlementSlot,
            descriptor = descriptors[0]!,
            retained = findRecord(f, { ...descriptor, container: descriptor.role });
          if (
            !base ||
            base.state !== "refusal_channel" ||
            !retained ||
            retained.state !== "written"
          )
            throw Error("Actual reserved DM refusal channel required before future capacity");
          const opened = recordDirectory(f, retained);
          try {
            const bytes = opened.dir.read(descriptor.name, descriptor.cap).toString("utf8");
            if (
              Buffer.byteLength(bytes) !== descriptor.cap ||
              controlDigest(bytes) !== retained.digest ||
              !sameInode(opened.dir.fileIdentity(descriptor.name), retained.inode)
            )
              throw Error("Original DM refusal channel changed");
          } finally {
            opened.close();
          }
          base.allocatedDescriptorDigests = [controlDigest(descriptor)];
        }
        const findOrdinal = (kind: "executions" | "intents", maximum: number) => {
          const dir = f.shared.directory(kind);
          try {
            for (let ordinal = 0; ordinal < maximum; ordinal++) {
              try {
                json(dir, `slot-${ordinal}.json`, 4096);
              } catch (error) {
                if (missing(error)) return ordinal;
                throw error;
              }
            }
            return null;
          } finally {
            dir.close();
          }
        };
        const executionOrdinal =
            role === "ops-agent"
              ? projection.issuerMembership.rootMemberOrdinal
              : findOrdinal("executions", LIMITS.executionsPerFamily),
          intentOrdinal = findOrdinal("intents", LIMITS.intentsPerFamily);
        // Reserve both ticket widths and every cell's final padded width now.
        const bytes =
          descriptors.reduce((sum, descriptor) => sum + descriptor.cap, 0) +
          (role === "data-manager" ? 8192 : 4096);
        const priorBytes = p.configurationSettlementSlot?.reservedMetadataBytes ?? 0,
          available = (directory: AnchoredDirectory) => {
            directory.check();
            const fs = statfsSync(directory.anchor, { bigint: true });
            directory.check();
            return fs.bavail * fs.bsize;
          },
          constraint: ConfigurationSettlementFamilySlot["refusalConstraint"] =
            Object.keys(p.executions).length + (role === "data-manager" ? 1 : 0) >
              LIMITS.executionsPerFamily ||
            Object.keys(p.intents).length + 1 > LIMITS.intentsPerFamily
              ? "members"
              : executionOrdinal === null || intentOrdinal === null
                ? "tickets"
                : p.metadataBytes + bytes - priorBytes > LIMITS.familyMetadataBytes
                  ? "metadata"
                  : p.records + descriptors.length - (role === "data-manager" ? 1 : 0) >
                        LIMITS.recordsPerFamily ||
                      p.sharedRecords +
                        descriptors.filter((item) => item.scope === "shared").length -
                        (role === "data-manager" ? 1 : 0) >
                        2048
                    ? "records"
                    : available(f.shared) < BigInt(bytes - priorBytes) ||
                        available(state.privateRoot) < BigInt(bytes - priorBytes)
                      ? "filesystem"
                      : null;
        if (constraint) {
          if (role !== "data-manager")
            throw Error(`Sender settlement capacity exhausted: ${constraint}`);
          const base = p.configurationSettlementSlot!;
          base.state = "capacity_refused";
          base.refusalConstraint = constraint;
          progress(f, p, true);
          return structuredClone(base);
        }
        const slot: ConfigurationSettlementFamilySlot = {
          version: 2,
          role,
          settlementId: projection.settlementId,
          projectionDigest,
          reservationDigest: projection.reservationDigest,
          ownerPrepareDigest: controlDigest(projection.ownerPrepare),
          proposedExecutionAddress: address,
          executionOrdinal,
          intentOrdinal,
          executionTicketId,
          intentTicketId,
          recordDescriptorsDigest,
          descriptors: structuredClone([...descriptors]),
          state: "allocating",
          reservedMetadataBytes: bytes,
          refusalConstraint: null,
          executionDigest: null,
          controlBindingDigest: null,
          allocatedDescriptorDigests:
            p.configurationSettlementSlot?.allocatedDescriptorDigests ?? [],
          unusedIntentDigest: null,
          unusedConfirmedAt: null,
        };
        p.configurationSettlementSlot = slot;
        p.metadataBytes += bytes - priorBytes;
        progress(f, p, true);
        settlementSlotTickets(f, slot, true);
        return structuredClone(slot);
      }),
    );
  } finally {
    f.close();
  }
}
/** After all fixed cells exist, verify their exact index/inode/width and seal
 * the original reservation. This never allocates a ticket or record. */
export function completeConfigurationSettlementFamilyReservation(
  state: InstallationState,
  projection: ConfigurationSettlementProjection,
): ConfigurationSettlementFamilySlot {
  const f = openFamily(state, projection.origin);
  try {
    return guard(f.shared, ".membership-writer", () =>
      guard(f.slot, ".family-writer", () => {
        checkLocalIdentity(f);
        const p = readProgress(f),
          slot = p.configurationSettlementSlot;
        if (
          !slot ||
          slot.settlementId !== projection.settlementId ||
          !["allocating", "reserved"].includes(slot.state) ||
          slot.executionOrdinal === null ||
          slot.intentOrdinal === null ||
          p.phase !== "active" ||
          decision(f).phase !== "active"
        )
          throw Error("Original unbound settlement reservation required");
        settlementSlotTickets(f, slot, false);
        for (const descriptor of slot.descriptors) {
          const entry = findRecord(f, {
            ...descriptor,
            container: descriptor.scope === "shared" ? descriptor.role : "",
          });
          if (!entry || entry.state !== "written")
            throw Error("Settlement record allocation incomplete");
          const source = recordDirectory(f, entry);
          try {
            const bytes = source.dir.read(descriptor.name, descriptor.cap).toString("utf8");
            if (
              Buffer.byteLength(bytes) !== descriptor.cap ||
              !sameInode(source.dir.fileIdentity(descriptor.name), entry.inode) ||
              controlDigest(bytes) !== entry.digest
            )
              throw Error("Original settlement reserved cell changed");
          } finally {
            source.close();
          }
        }
        const allocated = slot.descriptors.map((descriptor) => controlDigest(descriptor)).sort();
        if (slot.state === "reserved") {
          if (canonicalJson(slot.allocatedDescriptorDigests) !== canonicalJson(allocated))
            throw Error("Settlement allocation set changed");
        } else {
          slot.allocatedDescriptorDigests = allocated;
          slot.state = "reserved";
          progress(f, p, true);
        }
        return structuredClone(slot);
      }),
    );
  } finally {
    f.close();
  }
}
export function readConfigurationSettlementFamilySlot(
  state: InstallationState,
  projection: ConfigurationSettlementProjection,
): ConfigurationSettlementFamilySlot {
  const f = openFamily(state, projection.origin);
  try {
    return guard(f.slot, ".family-writer", () => {
      checkLocalIdentity(f);
      const p = readProgress(f),
        slot = p.configurationSettlementSlot;
      if (
        !slot ||
        slot.settlementId !== projection.settlementId ||
        slot.reservationDigest !== projection.reservationDigest ||
        canonicalJson(slot.proposedExecutionAddress) !==
          canonicalJson(projection.reservation.execution)
      )
        throw Error("Original settlement capacity slot unavailable");
      settlementSlotTickets(f, slot, false);
      return structuredClone(slot);
    });
  } finally {
    f.close();
  }
}
/** Fills ONLY the original PREPARE-reserved logical-control tickets. The full
 * immutable binding comes from this role's actual indexed private producer
 * cell, never from a supplied digest/execution/boolean. Partial ticket writes
 * can be repaired only to those exact original bytes and return no dispatch. */
export function bindOwnedConfigurationSettlementFamilySlot(
  state: InstallationState,
  projection: ConfigurationSettlementProjection,
): ConfigurationSettlementFamilySlot {
  if (state.fixedChildId || !["ops-agent", "data-manager"].includes(state.installation.role))
    throw Error("Fixed logical settlement role required");
  const f = openFamily(state, projection.origin);
  try {
    return guard(f.shared, ".membership-writer", () =>
      guard(f.slot, ".family-writer", () => {
        checkLocalIdentity(f);
        const p = readProgress(f),
          slot = p.configurationSettlementSlot;
        if (
          !slot ||
          !["reserved", "bound"].includes(slot.state) ||
          slot.settlementId !== projection.settlementId ||
          slot.projectionDigest !==
            settlementRecordDigest(configurationSettlementDomains.projection, projection) ||
          slot.reservationDigest !== projection.reservationDigest ||
          canonicalJson(slot.proposedExecutionAddress) !==
            canonicalJson(projection.reservation.execution) ||
          slot.intentOrdinal === null ||
          slot.executionOrdinal === null
        )
          throw Error("Original logical settlement reservation required");
        const descriptor = slot.descriptors.find(
          (value) =>
            value.scope === "private" &&
            value.name.endsWith(slot.role === "ops-agent" ? "-binding.json" : "-admission.json"),
        );
        if (!descriptor) throw Error("Original logical binding descriptor required");
        const entry = findRecord(f, { ...descriptor, container: "" });
        if (!entry || entry.state !== "written")
          throw Error("Original private binding source unavailable");
        const opened = recordDirectory(f, entry);
        let raw: unknown;
        try {
          const bytes = opened.dir.read(descriptor.name, descriptor.cap).toString("utf8");
          if (
            Buffer.byteLength(bytes) !== descriptor.cap ||
            controlDigest(bytes) !== entry.digest ||
            !sameInode(opened.dir.fileIdentity(descriptor.name), entry.inode)
          )
            throw Error("Original private binding source changed");
          raw = JSON.parse(bytes);
        } finally {
          opened.close();
        }
        const signed =
            slot.role === "ops-agent"
              ? raw
              : verifyControl(
                  state.installation.publicKey,
                  configurationSettlementDomains.admission,
                  raw,
                  configurationSettlementAdmissionSchema,
                ).controlEnvelope,
          envelope = verifyControl(
            state.publicKeys["ops-agent"],
            slot.role === "ops-agent"
              ? configurationSettlementDomains.binding
              : configurationSettlementDomains.control,
            signed,
            configurationSettlementControlEnvelopeSchema,
          ),
          executionDigest = controlDigest(envelope.execution),
          bindingDigest = settlementRecordDigest(configurationSettlementDomains.binding, envelope),
          {
            operationFingerprint: _fingerprint,
            fingerprint: _executionFingerprint,
            deadlineAt: _deadline,
            ...address
          } = envelope.execution;
        if (
          envelope.installationId !== state.installation.installationId ||
          canonicalJson(envelope.origin) !== canonicalJson(projection.origin) ||
          canonicalJson(envelope.ownerPrepare) !== canonicalJson(projection.ownerPrepare) ||
          envelope.admissionDigest !== projection.rootAdmissionDigest ||
          envelope.rootCertificateDigest !== projection.rootCertificateDigest ||
          envelope.settlementId !== projection.settlementId ||
          envelope.projectionDigest !== slot.projectionDigest ||
          envelope.reservationDigest !== slot.reservationDigest ||
          canonicalJson(envelope.operation) !== canonicalJson(projection.operation) ||
          canonicalJson(address) !== canonicalJson(slot.proposedExecutionAddress) ||
          envelope.execution.operationFingerprint !== projection.reservation.operationFingerprint ||
          canonicalJson(envelope.serviceIds) !== canonicalJson(projection.reservation.serviceIds)
        )
          throw Error("Original logical binding identity changed");
        if (slot.state === "reserved") {
          if (
            p.phase !== "active" ||
            decision(f).phase !== "active" ||
            slot.executionDigest !== null ||
            slot.controlBindingDigest !== null
          )
            throw Error("Original logical binding no longer available");
          settlementSlotTickets(f, slot, false);
          slot.state = "bound";
          slot.executionDigest = executionDigest;
          slot.controlBindingDigest = bindingDigest;
          progress(f, p);
        } else if (
          slot.executionDigest !== executionDigest ||
          slot.controlBindingDigest !== bindingDigest
        )
          throw Error("Immutable original logical binding changed");
        const finish = (kind: "executions" | "intents", ordinal: number, id: string) => {
          const directory = f.shared.directory(kind),
            base = {
              id,
              generation: f.meta.generation,
              value: {
                purpose: "configurationSettlementSlot",
                role: slot.role,
                settlementId: slot.settlementId,
                projectionDigest: slot.projectionDigest,
                address: slot.proposedExecutionAddress,
                executionDigest: null,
                controlBindingDigest: null,
                state: "reserved",
              },
            },
            next = {
              ...base,
              value: {
                ...base.value,
                executionDigest,
                controlBindingDigest: bindingDigest,
                state: "bound",
              },
            };
          try {
            const existing = json(directory, `slot-${ordinal}.json`, 4096);
            if (canonicalJson(existing) === canonicalJson(base))
              cell(directory, `slot-${ordinal}.json`, next, 4096);
            else if (canonicalJson(existing) !== canonicalJson(next))
              throw Error("Original logical bound ticket changed");
          } finally {
            directory.close();
          }
        };
        if (slot.role === "data-manager")
          finish("executions", slot.executionOrdinal, slot.executionTicketId);
        finish("intents", slot.intentOrdinal, slot.intentTicketId);
        settlementSlotTickets(f, slot, false);
        return structuredClone(slot);
      }),
    );
  } finally {
    f.close();
  }
}
/** Counterpart capacity publication is pinned-role signed. This checks its
 * retained original shared member/intent preimages, without DM-private reads. */
export function verifyPublishedDmConfigurationSettlementSlots(
  state: InstallationState,
  projection: ConfigurationSettlementProjection,
  capacity: {
    reservedExecutionOrdinal: number;
    reservedIntentOrdinal: number;
    projectionDigest: string;
  },
): void {
  if (state.installation.role !== "ops-agent" || state.fixedChildId)
    throw Error("Original issuer capacity observer required");
  const f = openFamily(state, projection.origin);
  try {
    guard(f.shared, ".membership-writer", () => {
      checkLocalIdentity(f);
      if (
        f.meta.familyId !== projection.issuerMembership.familyId ||
        decision(f).phase !== "active"
      )
        throw Error("Original reserved family unavailable");
      for (const [kind, ordinal, member] of [
        ["executions", capacity.reservedExecutionOrdinal, "execution"],
        ["intents", capacity.reservedIntentOrdinal, "intent"],
      ] as const) {
        if (
          !Number.isSafeInteger(ordinal) ||
          ordinal < 0 ||
          ordinal >= (kind === "executions" ? 128 : 256)
        )
          throw Error("Original DM capacity ordinal invalid");
        const dir = f.shared.directory(kind);
        try {
          const id = controlDigest({
              purpose: "configurationSettlementSlot",
              role: "data-manager",
              settlementId: projection.settlementId,
              member,
            }),
            expected = {
              id,
              generation: f.meta.generation,
              value: {
                purpose: "configurationSettlementSlot",
                role: "data-manager",
                settlementId: projection.settlementId,
                projectionDigest: capacity.projectionDigest,
                address: projection.reservation.execution,
                executionDigest: null,
                controlBindingDigest: null,
                state: "reserved",
              },
            };
          if (canonicalJson(json(dir, `slot-${ordinal}.json`, 4096)) !== canonicalJson(expected))
            throw Error("Original DM reserved capacity ticket changed");
        } finally {
          dir.close();
        }
      }
    });
  } finally {
    f.close();
  }
}
/** Read-only original DM member/intent binding. The actual signed capacity
 * and already published original envelope supply every expected field; this
 * creates no execution alias, membership, intent or authority handle. */
export function verifyPublishedBoundDmConfigurationSettlementSlots(
  state: InstallationState,
  projection: ConfigurationSettlementProjection,
  signedCapacity: unknown,
): void {
  if (state.installation.role !== "ops-agent" || state.fixedChildId)
    throw Error("Original logical settlement observer required");
  const capacity = verifyControl(
      state.publicKeys["data-manager"],
      configurationSettlementDomains.capacity,
      signedCapacity,
      configurationSettlementCapacitySchema,
    ),
    f = openFamily(state, projection.origin);
  try {
    guard(f.shared, ".membership-writer", () => {
      checkLocalIdentity(f);
      const entry = findRecord(f, {
        scope: "shared",
        namespace: "execution",
        container: "ops-agent",
        name: `${projection.ownerPrepare.operationKey}.configuration-settlement-control.json`,
      });
      if (!entry || entry.state !== "written") throw Error("Original shared control required");
      const source = recordDirectory(f, entry);
      let raw: unknown;
      try {
        const bytes = source.dir.read(entry.name, 8192).toString("utf8");
        if (
          controlDigest(bytes) !== entry.digest ||
          !sameInode(source.dir.fileIdentity(entry.name), entry.inode)
        )
          throw Error("Original shared control index changed");
        raw = JSON.parse(bytes);
      } finally {
        source.close();
      }
      const cell = verifyControl(
        state.installation.publicKey,
        configurationSettlementDomains.control,
        raw,
        configurationSettlementControlCellSchema.shape.payload,
      );
      if (
        !cell.binding ||
        "unused" in cell ||
        canonicalJson(cell.projection.payload) !== canonicalJson(projection)
      )
        throw Error("Original bound projection required");
      const envelope = verifyControl(
          state.installation.publicKey,
          configurationSettlementDomains.control,
          cell.binding,
          configurationSettlementControlEnvelopeSchema,
        ),
        expectedDescriptors = configurationSettlementRecordDescriptors(
          projection,
          controlChildOperationKey(
            projection.ownerPrepare.operationKey,
            "configuration-fence",
            projection.reservation.ordinal - 1,
          ),
        ).receiver;
      if (
        f.meta.familyId !== projection.issuerMembership.familyId ||
        capacity.installationId !== state.installation.installationId ||
        canonicalJson(capacity.origin) !== canonicalJson(projection.origin) ||
        capacity.ownerPrepareDigest !== controlDigest(projection.ownerPrepare) ||
        capacity.settlementId !== projection.settlementId ||
        capacity.projectionDigest !==
          settlementRecordDigest(configurationSettlementDomains.projection, projection) ||
        capacity.reservationDigest !== projection.reservationDigest ||
        canonicalJson(capacity.proposedExecutionAddress) !==
          canonicalJson(projection.reservation.execution) ||
        capacity.recordDescriptorsDigest !== controlDigest(expectedDescriptors) ||
        capacity.maxBytes !==
          expectedDescriptors.reduce((sum, descriptor) => sum + descriptor.cap, 0)
      )
        throw Error("Original bound DM capacity conflict");
      for (const [kind, ordinal, member] of [
        ["executions", capacity.reservedExecutionOrdinal, "execution"],
        ["intents", capacity.reservedIntentOrdinal, "intent"],
      ] as const) {
        const directory = f.shared.directory(kind),
          id = controlDigest({
            purpose: "configurationSettlementSlot",
            role: "data-manager",
            settlementId: projection.settlementId,
            member,
          }),
          expected = {
            id,
            generation: f.meta.generation,
            value: {
              purpose: "configurationSettlementSlot",
              role: "data-manager",
              settlementId: projection.settlementId,
              projectionDigest: capacity.projectionDigest,
              address: projection.reservation.execution,
              executionDigest: controlDigest(envelope.execution),
              controlBindingDigest: settlementRecordDigest(
                configurationSettlementDomains.binding,
                envelope,
              ),
              state: "bound",
            },
          };
        try {
          if (
            canonicalJson(json(directory, `slot-${ordinal}.json`, 4096)) !== canonicalJson(expected)
          )
            throw Error("Original bound DM ticket changed");
        } finally {
          directory.close();
        }
      }
    });
  } finally {
    f.close();
  }
}
export function verifyPublishedUnusedDmConfigurationSettlementSlots(
  state: InstallationState,
  projection: ConfigurationSettlementProjection,
  unused: {
    executionOrdinal: number | null;
    intentOrdinal: number | null;
    projectionDigest: string;
    intentDigest: string;
  },
): void {
  if (state.installation.role !== "ops-agent" || state.fixedChildId)
    throw Error("Original issuer UNUSED observer required");
  const f = openFamily(state, projection.origin);
  try {
    guard(f.shared, ".membership-writer", () => {
      checkLocalIdentity(f);
      if (f.meta.familyId !== projection.issuerMembership.familyId)
        throw Error("Original UNUSED family changed");
      for (const [kind, ordinal, member, maximum] of [
        ["executions", unused.executionOrdinal, "execution", 128],
        ["intents", unused.intentOrdinal, "intent", 256],
      ] as const) {
        const dir = f.shared.directory(kind),
          id = controlDigest({
            purpose: "configurationSettlementSlot",
            role: "data-manager",
            settlementId: projection.settlementId,
            member,
          });
        try {
          if (ordinal === null) {
            for (let n = 0; n < maximum; n++) {
              try {
                if (json<{ id: string }>(dir, `slot-${n}.json`, 4096).id === id)
                  throw Error("Unexpected allocated DM slot in null-capacity proof");
              } catch (error) {
                if (!missing(error)) throw error;
              }
            }
            continue;
          }
          if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= maximum)
            throw Error("Original UNUSED ordinal invalid");
          const expected = {
            id,
            generation: f.meta.generation,
            value: {
              purpose: "configurationSettlementSlot",
              role: "data-manager",
              settlementId: projection.settlementId,
              projectionDigest: unused.projectionDigest,
              address: projection.reservation.execution,
              executionDigest: null,
              controlBindingDigest: null,
              state: "UNUSED",
              unusedIntentDigest: unused.intentDigest,
            },
          };
          if (canonicalJson(json(dir, `slot-${ordinal}.json`, 4096)) !== canonicalJson(expected))
            throw Error("Original DM UNUSED ticket changed");
        } finally {
          dir.close();
        }
      }
    });
  } finally {
    f.close();
  }
}
/** Recovery DATA only: this cannot confirm a half-published UNUSED transition.
 * The fixed CAS below must still verify source intent and every shared ticket. */
export function readRefusedConfigurationSettlementCapacitySnapshot(
  state: InstallationState,
  projection: ConfigurationSettlementProjection,
): ConfigurationSettlementFamilySlot {
  if (state.installation.role !== "data-manager" || state.fixedChildId)
    throw Error("Original DM capacity snapshot required");
  const f = openFamily(state, projection.origin);
  try {
    return guard(f.slot, ".family-writer", () => {
      checkLocalIdentity(f);
      const slot = readProgress(f).configurationSettlementSlot;
      if (
        !slot ||
        slot.settlementId !== projection.settlementId ||
        slot.reservationDigest !== projection.reservationDigest ||
        canonicalJson(slot.proposedExecutionAddress) !==
          canonicalJson(projection.reservation.execution) ||
        !["reserved", "capacity_refused", "UNUSED"].includes(slot.state) ||
        slot.executionDigest !== null ||
        slot.controlBindingDigest !== null
      )
        throw Error("Original unbound DM capacity source required");
      return structuredClone(slot);
    });
  } finally {
    f.close();
  }
}
/** No caller intent/digest/outcome arguments. Read the actual already-signed
 * intent/refusal from the fixed indexed channel, check original private
 * canonical/effect facts and null future cells, then CAS the original slots.
 * Counts/ordinals remain reserved; no execution or terminal is manufactured. */
export function commitRefusedDataConfigurationSettlementSlotUnused(
  state: InstallationState,
  projection: ConfigurationSettlementProjection,
): ConfigurationSettlementFamilySlot {
  if (state.installation.role !== "data-manager" || state.fixedChildId)
    throw Error("Original DM unused-slot producer required");
  const f = openFamily(state, projection.origin),
    domainDigest = (domain: string, value: unknown) =>
      createHash("sha256")
        .update(`${domain}\0${canonicalJson(value)}`)
        .digest("hex");
  try {
    return guard(f.shared, ".membership-writer", () =>
      guard(f.slot, ".family-writer", () => {
        checkLocalIdentity(f);
        const p = readProgress(f),
          slot = p.configurationSettlementSlot;
        if (
          !slot ||
          slot.settlementId !== projection.settlementId ||
          slot.reservationDigest !== projection.reservationDigest ||
          !["reserved", "capacity_refused", "UNUSED"].includes(slot.state) ||
          slot.executionDigest !== null ||
          slot.controlBindingDigest !== null ||
          p.phase !== "active" ||
          decision(f).phase !== "active"
        )
          throw Error("Original unbound DM slots required");
        const read = (descriptor: ConfigurationSettlementRecordDescriptor): unknown => {
          const retained = findRecord(f, {
            ...descriptor,
            container: descriptor.scope === "shared" ? descriptor.role : "",
          });
          if (!retained || retained.state !== "written")
            throw Error("Original unused cell index missing");
          const opened = recordDirectory(f, retained);
          try {
            const bytes = opened.dir.read(descriptor.name, descriptor.cap).toString("utf8");
            if (
              Buffer.byteLength(bytes) !== descriptor.cap ||
              controlDigest(bytes) !== retained.digest ||
              !sameInode(opened.dir.fileIdentity(descriptor.name), retained.inode)
            )
              throw Error("Original unused cell replaced");
            return JSON.parse(bytes);
          } finally {
            opened.close();
          }
        };
        const compound = z
            .object({
              refusal: z.unknown(),
              unused: z.object({ intent: z.unknown() }).passthrough(),
            })
            .passthrough()
            .parse(read(slot.descriptors[0]!)),
          hash = z.string().regex(/^[a-f0-9]{64}$/),
          epoch = z.number().int().nonnegative().safe(),
          ordinal = z.number().int().min(0).max(255).nullable(),
          intent = verifyControl(
            state.installation.publicKey,
            "openmapx-configuration-unused-capacity-intent-v2",
            compound.unused.intent,
            z.strictObject({
              version: z.literal(2),
              installationId: z.uuid(),
              origin: controlOriginSchema,
              role: z.literal("data-manager"),
              ownerPrepareDigest: hash,
              prepareExecutionDigest: hash.nullable(),
              settlementId: hash,
              projectionDigest: hash,
              capacityReceiptDigest: hash.nullable(),
              sourceProofDigest: hash,
              executionOrdinal: ordinal,
              intentOrdinal: ordinal,
              recordDescriptorsDigest: hash,
              allocatedDescriptorDigests: z.array(hash).max(12),
              createdAt: epoch,
            }),
          ),
          refusal = verifyControl(
            state.installation.publicKey,
            "openmapx-dm-configuration-no-guard-refusal-v2",
            compound.refusal,
            z
              .object({
                version: z.literal(2),
                installationId: z.uuid(),
                origin: controlOriginSchema,
                settlementId: hash,
                projectionDigest: hash,
                reservationDigest: hash,
                prepareExecution: executionRefSchema,
                prepareAdmissionDigest: hash,
                refusalReceipt: z.unknown(),
                effectReceiptDigest: hash,
                effectSettlementDigest: hash,
                canonicalTerminalDigest: hash,
                canonicalTerminalAt: epoch,
                capacityReceiptDigest: hash.nullable(),
              })
              .passthrough(),
          );
        if (
          intent.installationId !== state.installation.installationId ||
          canonicalJson(intent.origin) !== canonicalJson(projection.origin) ||
          intent.ownerPrepareDigest !== controlDigest(projection.ownerPrepare) ||
          intent.prepareExecutionDigest !== controlDigest(refusal.prepareExecution) ||
          intent.settlementId !== slot.settlementId ||
          intent.projectionDigest !== slot.projectionDigest ||
          intent.capacityReceiptDigest !== refusal.capacityReceiptDigest ||
          intent.sourceProofDigest !==
            domainDigest("openmapx-dm-configuration-no-guard-refusal-v2", refusal) ||
          intent.executionOrdinal !== slot.executionOrdinal ||
          intent.intentOrdinal !== slot.intentOrdinal ||
          intent.recordDescriptorsDigest !== slot.recordDescriptorsDigest ||
          canonicalJson(intent.allocatedDescriptorDigests) !==
            canonicalJson(slot.allocatedDescriptorDigests) ||
          refusal.installationId !== state.installation.installationId ||
          canonicalJson(refusal.origin) !== canonicalJson(projection.origin) ||
          refusal.settlementId !== slot.settlementId ||
          refusal.projectionDigest !== slot.projectionDigest ||
          refusal.reservationDigest !== slot.reservationDigest ||
          slot.descriptors[0]?.scope !== "shared" ||
          slot.descriptors[0].namespace !== "execution" ||
          slot.descriptors[0].role !== "data-manager" ||
          slot.descriptors[0].name !==
            `${refusal.prepareExecution.operationKey}.configuration-settlement-capacity.json` ||
          slot.descriptors[0].cap !== 8192
        )
          throw Error("Original DM UNUSED intent source changed");
        const fact = p.executions[controlDigest(refusal.prepareExecution)];
        if (
          !fact ||
          !fact.known ||
          !fact.journalContained ||
          fact.receiptDigest !== refusal.prepareAdmissionDigest ||
          fact.canonicalDigest !== refusal.canonicalTerminalDigest ||
          fact.canonicalTerminalAt !== refusal.canonicalTerminalAt
        )
          throw Error("Original canonical DM refusal membership required");
        const observations = state.privateRoot.directory("observations"),
          effects = state.privateRoot.directory("effects");
        try {
          const canonical = verifyControl(
              state.installation.publicKey,
              "openmapx-data-fence-terminal-v1",
              json(observations, `terminal-${refusal.prepareExecution.operationKey}.json`, 8192),
              z
                .object({
                  phase: z.literal("canonical"),
                  execution: executionRefSchema,
                  admissionDigest: hash,
                  terminalDigest: hash,
                  terminalAt: epoch,
                })
                .passthrough(),
            ),
            effect = verifyControl(
              state.installation.publicKey,
              "openmapx-control-settlement-v1",
              json(effects, `${refusal.prepareExecution.operationKey}.json`, 65536),
              z
                .object({
                  identity: executionRefSchema,
                  outcome: z.literal("failed_without_effect"),
                  publication: z.literal("not_started"),
                  terminalReceiptDigest: hash,
                  receipt: z.unknown(),
                })
                .passthrough(),
            );
          if (
            canonicalJson(canonical.execution) !== canonicalJson(refusal.prepareExecution) ||
            canonical.admissionDigest !== fact.receiptDigest ||
            canonical.terminalDigest !== refusal.canonicalTerminalDigest ||
            canonical.terminalAt !== refusal.canonicalTerminalAt ||
            canonicalJson(effect.identity) !== canonicalJson(refusal.prepareExecution) ||
            canonicalJson(effect.receipt) !== canonicalJson(refusal.refusalReceipt) ||
            effect.terminalReceiptDigest !== refusal.effectReceiptDigest ||
            controlDigest(effect.receipt) !== refusal.effectReceiptDigest ||
            controlDigest(effect) !== refusal.effectSettlementDigest
          )
            throw Error("Original local canonical refusal preimages changed");
        } finally {
          effects.close();
          observations.close();
        }
        const actualAllocated = slot.descriptors.filter((descriptor) =>
          slot.allocatedDescriptorDigests.includes(controlDigest(descriptor)),
        );
        if (
          actualAllocated.length !== slot.allocatedDescriptorDigests.length ||
          actualAllocated[0] !== slot.descriptors[0]
        )
          throw Error("Original UNUSED descriptor set changed");
        for (const descriptor of actualAllocated.slice(1))
          if (read(descriptor) !== null)
            throw Error("Bound/attempted DM control cannot become UNUSED");
        const intentDigest = domainDigest(
          "openmapx-configuration-unused-capacity-intent-v2",
          intent,
        );
        if (slot.state === "UNUSED") {
          if (
            slot.unusedIntentDigest !== intentDigest ||
            !Number.isSafeInteger(slot.unusedConfirmedAt)
          )
            throw Error("Original UNUSED CAS changed");
        } else {
          settlementSlotTickets(f, slot, false);
          slot.state = "UNUSED";
          slot.unusedIntentDigest = intentDigest;
          slot.unusedConfirmedAt = Date.now();
          progress(f, p);
        }
        const finishTicket = (
          kind: "executions" | "intents",
          ordinal: number | null,
          id: string,
        ) => {
          if (ordinal === null) return;
          const dir = f.shared.directory(kind),
            base = {
              id,
              generation: f.meta.generation,
              value: {
                purpose: "configurationSettlementSlot",
                role: slot.role,
                settlementId: slot.settlementId,
                projectionDigest: slot.projectionDigest,
                address: slot.proposedExecutionAddress,
                executionDigest: null,
                controlBindingDigest: null,
                state: "reserved",
              },
            },
            next = {
              ...base,
              value: { ...base.value, state: "UNUSED", unusedIntentDigest: intentDigest },
            };
          try {
            const existing = json(dir, `slot-${ordinal}.json`, 4096);
            if (canonicalJson(existing) === canonicalJson(base))
              cell(dir, `slot-${ordinal}.json`, next, 4096);
            else if (canonicalJson(existing) !== canonicalJson(next))
              throw Error("Original UNUSED ticket replaced");
          } finally {
            dir.close();
          }
        };
        finishTicket("executions", slot.executionOrdinal, slot.executionTicketId);
        finishTicket("intents", slot.intentOrdinal, slot.intentTicketId);
        settlementSlotTickets(f, slot, false);
        return structuredClone(slot);
      }),
    );
  } finally {
    f.close();
  }
}
/** The actual fixed issuer freeze/intent is read from its signed private owner.
 * No caller closure, digest, slot list or requested outcome authorizes this CAS. */
export function commitFrozenConfigurationSettlementSlotUnused(
  state: InstallationState,
  projection: ConfigurationSettlementProjection,
): ConfigurationSettlementFamilySlot {
  if (state.installation.role !== "ops-agent" || state.fixedChildId)
    throw Error("Original frozen issuer required");
  const f = openFamily(state, projection.origin);
  try {
    return guard(f.shared, ".membership-writer", () =>
      guard(f.slot, ".family-writer", () => {
        checkLocalIdentity(f);
        const p = readProgress(f),
          slot = p.configurationSettlementSlot;
        if (
          !slot ||
          slot.role !== "ops-agent" ||
          slot.settlementId !== projection.settlementId ||
          slot.projectionDigest !==
            settlementRecordDigest(configurationSettlementDomains.projection, projection) ||
          !["reserved", "UNUSED"].includes(slot.state) ||
          slot.executionDigest !== null ||
          slot.controlBindingDigest !== null ||
          slot.intentOrdinal === null ||
          p.phase !== "active" ||
          decision(f).phase !== "active"
        )
          throw Error("Original unbound issuer slot required");
        const read = (
          record: {
            scope: "private" | "shared";
            namespace: string;
            name: string;
            container: string;
          },
          cap: number,
        ): unknown => {
          const retained = findRecord(f, record);
          if (!retained || retained.state !== "written")
            throw Error("Original issuer source index missing");
          const opened = recordDirectory(f, retained);
          try {
            const bytes = opened.dir.read(record.name, cap).toString("utf8");
            if (
              controlDigest(bytes) !== retained.digest ||
              !sameInode(opened.dir.fileIdentity(record.name), retained.inode)
            )
              throw Error("Original issuer source replaced");
            return JSON.parse(bytes);
          } finally {
            opened.close();
          }
        };
        const rawOwner = read(
            {
              scope: "private",
              namespace: "configuration-maintenance",
              name: `${projection.maintenanceId}.json`,
              container: "",
            },
            131072,
          ),
          owner = verifyControl(
            state.installation.publicKey,
            "openmapx-configuration-maintenance-owner-v2",
            rawOwner,
            z
              .object({
                admissionDigest: z.string(),
                sequence: z.number(),
                issuance: z.enum(["closing_without_guard", "closed_without_guard"]),
                noGuard: configurationNoGuardIntentSchema,
                guardSource: z.null(),
                final: z.null(),
                inspection: z.null(),
                receipt: z
                  .object({ dmFence: z.null(), generation: z.literal("not_started") })
                  .passthrough(),
              })
              .passthrough(),
          ),
          intent = verifyControl(
            state.installation.publicKey,
            configurationSettlementDomains.unusedIntent,
            owner.noGuard.issuerUnused.intent,
            configurationNoGuardIntentSchema.shape.issuerUnused.shape.intent.shape.payload,
          ),
          fact = p.executions[controlDigest(projection.ownerPrepare)];
        if (
          !fact ||
          owner.admissionDigest !== fact.receiptDigest ||
          owner.sequence !== owner.noGuard.ownerSequence ||
          intent.role !== "ops-agent" ||
          intent.installationId !== state.installation.installationId ||
          canonicalJson(intent.origin) !== canonicalJson(projection.origin) ||
          intent.ownerPrepareDigest !== controlDigest(projection.ownerPrepare) ||
          intent.settlementId !== slot.settlementId ||
          intent.projectionDigest !== slot.projectionDigest ||
          intent.sourceProofDigest !==
            configurationIssuerUnusedSourceDigest(owner.noGuard.noGuardEvidence) ||
          intent.executionOrdinal !== slot.executionOrdinal ||
          intent.intentOrdinal !== slot.intentOrdinal ||
          intent.recordDescriptorsDigest !== slot.recordDescriptorsDigest ||
          canonicalJson(intent.allocatedDescriptorDigests) !==
            canonicalJson(slot.allocatedDescriptorDigests)
        )
          throw Error("Original frozen issuer UNUSED source changed");
        for (const descriptor of slot.descriptors.filter(
          (value) => value.scope === "private" || value.name.endsWith("-ack.json"),
        )) {
          if (
            read(
              { ...descriptor, container: descriptor.scope === "shared" ? descriptor.role : "" },
              descriptor.cap,
            ) !== null
          )
            throw Error("Bound/attempted issuer control cannot become UNUSED");
        }
        const intentDigest = settlementRecordDigest(
          configurationSettlementDomains.unusedIntent,
          intent,
        );
        if (slot.state === "UNUSED") {
          if (
            slot.unusedIntentDigest !== intentDigest ||
            !Number.isSafeInteger(slot.unusedConfirmedAt)
          )
            throw Error("Original issuer UNUSED CAS conflict");
        } else {
          settlementSlotTickets(f, slot, false);
          slot.state = "UNUSED";
          slot.unusedIntentDigest = intentDigest;
          slot.unusedConfirmedAt = Date.now();
          progress(f, p);
        }
        const dir = f.shared.directory("intents"),
          base = {
            id: slot.intentTicketId,
            generation: f.meta.generation,
            value: {
              purpose: "configurationSettlementSlot",
              role: "ops-agent",
              settlementId: slot.settlementId,
              projectionDigest: slot.projectionDigest,
              address: slot.proposedExecutionAddress,
              executionDigest: null,
              controlBindingDigest: null,
              state: "reserved",
            },
          },
          next = {
            ...base,
            value: { ...base.value, state: "UNUSED", unusedIntentDigest: intentDigest },
          };
        try {
          const current = json(dir, `slot-${slot.intentOrdinal}.json`, 4096);
          if (canonicalJson(current) === canonicalJson(base))
            cell(dir, `slot-${slot.intentOrdinal}.json`, next, 4096);
          else if (canonicalJson(current) !== canonicalJson(next))
            throw Error("Original issuer UNUSED ticket changed");
        } finally {
          dir.close();
        }
        settlementSlotTickets(f, slot, false);
        return structuredClone(slot);
      }),
    );
  } finally {
    f.close();
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
/** Full public two-cell/source/physical closure, plus THIS role's actual
 * private canonical/UNUSED state. Never reads a sibling private directory and
 * never allocates, changes a counter, or manufactures an unjoined participant. */
function configurationNoGuardFamilyClosure(
  f: Family,
  p: Progress,
): { unusedExecutionTicketIds: string[]; unusedIntentTicketIds: string[] } | null {
  const slot = p.configurationSettlementSlot;
  if (
    !slot ||
    slot.state !== "UNUSED" ||
    slot.executionDigest !== null ||
    slot.controlBindingDigest !== null ||
    !slot.unusedIntentDigest ||
    slot.unusedConfirmedAt === null
  )
    return null;
  const domains = configurationSettlementDomains,
    same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b),
    need = (condition: unknown, message: string) => {
      if (!condition) throw Error(message);
    },
    opened: AnchoredDirectory[] = [],
    own = (directory: AnchoredDirectory) => {
      opened.push(directory);
      return directory;
    };
  const localRead = (
    address: Pick<FamilyRecord, "scope" | "namespace" | "name" | "container">,
    cap: number,
  ): unknown => {
    const indexed = findRecord(f, address);
    need(indexed && indexed.state === "written", "Original local NoGuard source index missing");
    const source = recordDirectory(f, indexed!);
    try {
      const bytes = source.dir.read(address.name, cap).toString("utf8");
      need(
        controlDigest(bytes) === indexed!.digest &&
          sameInode(source.dir.fileIdentity(address.name), indexed!.inode),
        "Original local NoGuard source replaced",
      );
      return JSON.parse(bytes);
    } finally {
      source.close();
    }
  };
  try {
    const controlRoot = own(f.root.directory(".admin-target-control")),
      executions = own(controlRoot.directory("executions")),
      sender = own(executions.directory("ops-agent")),
      senderKey = f.state.publicKeys["ops-agent"],
      readShared = (directory: AnchoredDirectory, name: string, cap: number) => {
        const bytes = directory.read(name, cap);
        need(bytes.length === cap, "Original NoGuard reserved width changed");
        return JSON.parse(bytes.toString("utf8"));
      },
      control = verifyControl(
        senderKey,
        domains.control,
        readShared(sender, `${f.meta.origin.rootKey}.configuration-settlement-control.json`, 8192),
        configurationSettlementControlCellSchema.shape.payload,
      ),
      projection = verifyControl(
        senderKey,
        domains.signedProjection,
        control.projection,
        configurationSettlementReservationProjectionSchema,
      ),
      bundle = verifyControl(
        senderKey,
        domains.reference,
        readShared(sender, `${f.meta.origin.rootKey}.configuration-settlement.json`, 16384),
        configurationSettlementCommitmentCellSchema.shape.payload,
      );
    if (bundle.phase !== "unused" || !("unused" in control) || control.binding !== null)
      return null;
    const closure = verifyControl(
        senderKey,
        domains.closure,
        bundle.closure,
        configurationNoGuardClosureSchema,
      ),
      identity = closure.identity,
      evidence = closure.noGuardEvidence,
      projectionDigest = settlementRecordDigest(domains.projection, projection),
      { closureDigest: ignoredClosureDigest, ...closureSource } = closure,
      freezeDomain = evidence.kind === "never_issued" ? domains.neverIssued : domains.issuedRefused,
      freeze =
        evidence.kind === "never_issued"
          ? verifyControl(
              senderKey,
              freezeDomain,
              bundle.issuerFreezeProof,
              configurationNeverIssuedProofSchema,
            )
          : verifyControl(
              senderKey,
              freezeDomain,
              bundle.issuerFreezeProof,
              configurationIssuedPrepareRefusedProofSchema,
            ),
      publications =
        "remainingPublicationStates" in freeze
          ? freeze.remainingPublicationStates
          : freeze.publicationStates,
      issuerIntent = verifyControl(
        senderKey,
        domains.unusedIntent,
        bundle.issuerUnused.intent,
        configurationUnusedCapacityIntentSchema,
      ),
      issuerConfirmation = verifyControl(
        senderKey,
        domains.unusedConfirmation,
        bundle.issuerUnused.confirmation,
        configurationUnusedCapacityConfirmationSchema,
      ),
      issuerIntentDigest = settlementRecordDigest(domains.unusedIntent, issuerIntent),
      issuerConfirmationDigest = settlementRecordDigest(
        domains.unusedConfirmation,
        issuerConfirmation,
      );
    need(
      projection.installationId === f.state.installation.installationId &&
        same(projection.origin, f.meta.origin) &&
        projection.ownerPrepare.operationKey === f.meta.origin.rootKey &&
        projection.issuerMembership.familyId === f.meta.familyId &&
        projection.issuerMembership.rootExecutionDigest ===
          controlDigest(projection.ownerPrepare) &&
        projection.issuerMembership.rootAdmissionDigest === projection.rootAdmissionDigest &&
        projection.reservationDigest ===
          settlementRecordDigest(domains.reservationTuple, projection.reservation) &&
        projection.reservation.operationFingerprint === controlDigest(projection.operation) &&
        projection.operation.version === 2 &&
        projection.operation.maintenanceId === projection.maintenanceId &&
        projection.operation.candidateId === projection.candidateId &&
        projection.operation.planDigest === projection.planDigest &&
        projection.operation.settlementId === projection.settlementId &&
        projection.settlementId ===
          deriveConfigurationFenceSettlementId({
            installationId: projection.installationId,
            ownerPrepare: projection.ownerPrepare,
            maintenanceId: projection.maintenanceId,
            candidateId: projection.candidateId,
            planDigest: projection.planDigest,
          }) &&
        same(identity, {
          installationId: projection.installationId,
          origin: projection.origin,
          ownerPrepare: projection.ownerPrepare,
          admissionDigest: projection.rootAdmissionDigest,
          rootCertificateDigest: projection.rootCertificateDigest,
          maintenanceId: projection.maintenanceId,
          candidateId: projection.candidateId,
          planDigest: projection.planDigest,
          settlementId: projection.settlementId,
        }) &&
        bundle.settlementId === projection.settlementId &&
        bundle.projectionDigest === projectionDigest &&
        closure.closureDigest === settlementRecordDigest(domains.closure, closureSource) &&
        same(freeze.identity, identity) &&
        freeze.issuerSequence === closure.ownerSequence &&
        freeze.frozenAt === closure.closedAt &&
        settlementRecordDigest(freezeDomain, freeze) === evidence.issuerFreezeProofDigest &&
        publications.length > 0 &&
        publications[0]!.phase === "configuration-commit" &&
        publications[0]!.ordinal === 0 &&
        publications.every(
          (value, index) =>
            [
              "configuration-commit",
              "maintenance-hardlinks",
              "maintenance-recreate",
              "maintenance-handoff",
              "configuration-fence",
              "configuration-fence-settle",
            ].includes(value.phase) &&
            (index === 0 || publications[index - 1]!.ordinal < value.ordinal),
        ) &&
        publications.some(
          (value) =>
            value.phase === "configuration-fence-settle" &&
            value.ordinal === projection.reservation.ordinal &&
            value.operationKey === projection.reservation.execution.operationKey,
        ),
      "Original family NoGuard identity/freeze preimages changed",
    );
    const fixedPhases = [
      "configuration-commit",
      "maintenance-hardlinks",
      "maintenance-recreate",
      "maintenance-handoff",
      "configuration-fence",
      "configuration-fence-settle",
    ] as const;
    for (const publication of publications) {
      const phase = fixedPhases.find((value) => value === publication.phase);
      if (
        !phase ||
        publication.operationKey !==
          controlChildOperationKey(projection.ownerPrepare.operationKey, phase, publication.ordinal)
      )
        throw Error("Original frozen family phase correlation changed");
    }
    const rootTicketDir = own(f.shared.directory("executions")),
      rootTicket = json<{ id: string; generation: string; value: unknown }>(
        rootTicketDir,
        `slot-${projection.issuerMembership.rootMemberOrdinal}.json`,
        4096,
      );
    need(
      rootTicket.id === controlDigest(projection.ownerPrepare) &&
        rootTicket.generation === f.meta.generation &&
        same(rootTicket.value, projection.ownerPrepare),
      "Original NoGuard issuer membership changed",
    );
    const leases = Object.values(p.leases).filter(
      (value) =>
        value.certificateDigest === identity.rootCertificateDigest &&
        value.ownerRole === "ops-agent",
    );
    let leaseId: string, ownAdoption: { delegationId: string } | undefined;
    if (f.state.installation.role === "ops-agent") {
      need(
        leases.length === 1,
        "Original NoGuard physical root membership required before family ready",
      );
      leaseId = leases[0]!.id;
    } else {
      const fact = Object.values(p.executions).find(
        (value) =>
          evidence.kind === "receiver_refused" &&
          controlDigest(value.execution) === evidence.prepareExecutionDigest,
      );
      need(
        fact && evidence.kind === "receiver_refused",
        "Actual original receiver member required",
      );
      const adoption = verifyControl(
        f.state.installation.publicKey,
        "openmapx-configuration-fence-adoption-v2",
        localRead(
          {
            scope: "private",
            namespace: "execution-adoptions",
            name: `${fact!.execution.operationKey}.json`,
            container: "",
          },
          8192,
        ),
        z.strictObject({
          version: z.literal(2),
          origin: controlOriginSchema,
          execution: executionRefSchema,
          admissionDigest: z.string(),
          leaseId: z.uuid(),
          delegationId: z.uuid(),
          certificateDigest: z.string(),
        }),
      );
      need(
        same(adoption.origin, f.meta.origin) &&
          same(adoption.execution, fact!.execution) &&
          adoption.admissionDigest === fact!.receiptDigest &&
          adoption.certificateDigest === identity.rootCertificateDigest,
        "Actual original receiver adoption changed",
      );
      leaseId = adoption.leaseId;
      ownAdoption = adoption;
    }
    const rootWitness = readControlExecutionWitness(f.state, projection.ownerPrepare, senderKey);
    need(
      rootWitness.kind === "configurationMaintenance.prepare" &&
        same(rootWitness.origin, f.meta.origin) &&
        rootWitness.authorityDigest === identity.admissionDigest,
      "Actual original shared root admission witness required",
    );
    const leaseRoot = own(controlRoot.directory("leases")),
      ledger = own(leaseRoot.directory(leaseId)),
      rootRaw = json<{ payload: { certificate: unknown } }>(ledger, "owner.json"),
      certificate = verifyControl(
        senderKey,
        "openmapx-lease-certificate-v2",
        rootRaw.payload.certificate,
        z
          .object({
            version: z.literal(2),
            origin: controlOriginSchema,
            installationId: z.uuid(),
            leaseId: z.uuid(),
            owner: executionRefSchema,
            ownerPublicKey: z.string(),
            dataRootIdentity: identitySchema,
            serviceIds: z.array(z.string()).max(256),
          })
          .passthrough(),
      ),
      root = verifyControl(
        certificate.ownerPublicKey,
        "openmapx-lease-owner-v2",
        rootRaw,
        z
          .object({
            phase: z.literal("settled"),
            certificate: z.unknown(),
            origin: controlOriginSchema,
            grantDigests: z.record(z.uuid(), z.string()),
            settlement: z
              .object({
                identity: executionRefSchema,
                outcome: z.literal("failed_without_effect"),
                publication: z.literal("not_started"),
                terminalReceiptDigest: z.string(),
              })
              .strict(),
          })
          .passthrough(),
      ),
      release = verifyControl(
        senderKey,
        "openmapx-admission-slots-v1",
        json(ledger, "admission.json", 4096),
        z
          .object({
            installationId: z.uuid(),
            leaseId: z.uuid(),
            certificateDigest: z.string(),
            releasedAt: z.number().int().positive(),
          })
          .passthrough(),
      );
    need(
      certificate.installationId === f.state.installation.installationId &&
        certificate.leaseId === leaseId &&
        same(certificate.origin, f.meta.origin) &&
        same(certificate.owner, projection.ownerPrepare) &&
        sameInode(certificate.dataRootIdentity, identityOfRoot(f)) &&
        controlDigest(rootRaw.payload.certificate) === identity.rootCertificateDigest &&
        same(root.origin, f.meta.origin) &&
        same(root.settlement.identity, projection.ownerPrepare) &&
        release.installationId === certificate.installationId &&
        release.leaseId === leaseId &&
        release.certificateDigest === identity.rootCertificateDigest,
      "Original released NoGuard root changed",
    );
    const ownReceipt = {
        kind: "configuration-no-guard",
        issuerFreezeProofDigest: evidence.issuerFreezeProofDigest,
        issuerUnusedConfirmationDigest: issuerConfirmationDigest,
      },
      ownContainmentDigest = controlDigest({ ...root.settlement, receipt: ownReceipt });
    need(
      root.settlement.terminalReceiptDigest === controlDigest(ownReceipt),
      "Original NoGuard root effect receipt changed",
    );
    let prepareKey: string,
      dmSlotProof:
        | { role: "data-manager"; intentDigest: string; confirmationDigest: string }
        | undefined,
      dmIntent: ReturnType<typeof configurationUnusedCapacityIntentSchema.parse> | undefined,
      dmConfirmation:
        | ReturnType<typeof configurationUnusedCapacityConfirmationSchema.parse>
        | undefined,
      dmContainmentDigest: string | undefined;
    if (evidence.kind === "never_issued") {
      const prepare = publications.find((value) => value.phase === "configuration-fence");
      need(
        prepare &&
          !("kind" in freeze) &&
          Object.keys(root.grantDigests).length === 0 &&
          evidence.publicationStatesDigest ===
            settlementRecordDigest(domains.neverIssued, freeze) &&
          evidence.issuerSequence === freeze.issuerSequence &&
          evidence.frozenAt === freeze.frozenAt &&
          !("kind" in freeze) &&
          evidence.prepareReservationDigest === freeze.prepareReservationDigest,
        "Original unjoined NeverIssued family source changed",
      );
      prepareKey = prepare!.operationKey;
      assertNoUnissuedConfigurationReceiverPublication(f.state, prepareKey);
    } else {
      need(
        "kind" in freeze && Object.keys(root.grantDigests).length === 1,
        "Original receiver-refused root grant source changed",
      );
      if (!("kind" in freeze)) throw Error("Original issued freeze required");
      const [delegationId, grantDigest] = Object.entries(root.grantDigests)[0]!,
        grants = own(ledger.directory("grants")),
        children = own(ledger.directory("children")),
        rawGrant = json<{ grant: unknown; transition: unknown }>(grants, `${delegationId}.json`),
        grant = verifyControl(
          certificate.ownerPublicKey,
          "openmapx-lease-grant-v2",
          rawGrant.grant,
          z
            .object({
              origin: controlOriginSchema,
              installationId: z.uuid(),
              leaseId: z.uuid(),
              ownerCertificateDigest: z.string(),
              delegationId: z.uuid(),
              parentNode: z.null(),
              parent: executionRefSchema,
              child: executionRefSchema,
              childKind: z.literal("configuration-maintenance.prepare"),
              phase: z.literal("configuration-fence"),
              childPublicKey: z.string(),
              recipient: z.literal("data-manager"),
              ordinal: z.number().int(),
              serviceIds: z.array(z.string()).max(256),
            })
            .passthrough(),
        ),
        transition = verifyControl(
          certificate.ownerPublicKey,
          "openmapx-lease-intent-v1",
          rawGrant.transition,
          z.strictObject({
            delegationId: z.uuid(),
            grantDigest: z.string(),
            sequence: z.literal(1),
            state: z.literal("attempted"),
          }),
        ),
        child = verifyControl(
          grant.childPublicKey,
          "openmapx-lease-child-v2",
          json(children, `${delegationId}.json`),
          z
            .object({
              origin: controlOriginSchema,
              delegationId: z.uuid(),
              grantDigest: z.string(),
              execution: executionRefSchema,
              phase: z.literal("settled"),
              grantDigests: z.record(z.uuid(), z.string()),
              settlement: z.strictObject({
                identity: executionRefSchema,
                outcome: z.literal("failed_without_effect"),
                publication: z.literal("not_started"),
                terminalReceiptDigest: z.string(),
              }),
            })
            .passthrough(),
        );
      prepareKey = grant.child.operationKey;
      const receiver = own(executions.directory("data-manager")),
        compound = configurationDmCapacityCellSchema.parse(
          readShared(receiver, `${prepareKey}.configuration-settlement-capacity.json`, 8192),
        );
      need(
        compound.refusal && compound.unused?.confirmation,
        "Original receiver refusal/UNUSED compound required",
      );
      const receiverKey = f.state.publicKeys["data-manager"],
        refusal = verifyControl(
          receiverKey,
          domains.refusal,
          compound.refusal,
          configurationDmNoGuardRefusalSchema,
        ),
        capacity =
          compound.capacity &&
          verifyControl(
            receiverKey,
            domains.capacity,
            compound.capacity,
            configurationSettlementCapacitySchema,
          ),
        refusalDigest = settlementRecordDigest(domains.refusal, refusal),
        descriptors = configurationSettlementRecordDescriptors(projection, prepareKey).receiver;
      dmIntent = verifyControl(
        receiverKey,
        domains.unusedIntent,
        compound.unused!.intent,
        configurationUnusedCapacityIntentSchema,
      );
      dmConfirmation = verifyControl(
        receiverKey,
        domains.unusedConfirmation,
        compound.unused!.confirmation,
        configurationUnusedCapacityConfirmationSchema,
      );
      const intentDigest = settlementRecordDigest(domains.unusedIntent, dmIntent),
        confirmationDigest = settlementRecordDigest(domains.unusedConfirmation, dmConfirmation),
        actualDescriptors = (capacity ? descriptors : [descriptors[0]!])
          .map((value) => controlDigest(value))
          .sort(),
        safeState = {
          executionOrdinal: capacity?.reservedExecutionOrdinal ?? null,
          intentOrdinal: capacity?.reservedIntentOrdinal ?? null,
          recordDescriptorsDigest: controlDigest(descriptors),
          allocatedDescriptorDigests: actualDescriptors,
          state: "UNUSED",
          intentDigest,
        };
      const receiverWitness = readControlExecutionWitness(f.state, grant.child, receiverKey);
      need(
        receiverWitness.kind === "configuration-maintenance.prepare" &&
          same(receiverWitness.origin, f.meta.origin) &&
          receiverWitness.authorityDigest === refusal.prepareAdmissionDigest &&
          (!ownAdoption || ownAdoption.delegationId === delegationId) &&
          grant.ordinal === projection.reservation.ordinal - 1 &&
          grant.child.operationKey ===
            controlChildOperationKey(
              projection.ownerPrepare.operationKey,
              "configuration-fence",
              grant.ordinal,
            ) &&
          same(grant.serviceIds, projection.reservation.serviceIds) &&
          same(grant.serviceIds, certificate.serviceIds) &&
          grant.installationId === identity.installationId &&
          same(grant.origin, f.meta.origin) &&
          grant.leaseId === leaseId &&
          grant.ownerCertificateDigest === identity.rootCertificateDigest &&
          grant.delegationId === delegationId &&
          grant.childPublicKey === f.state.publicKeys["data-manager"] &&
          same(grant.parent, projection.ownerPrepare) &&
          grantDigest === controlDigest(rawGrant.grant) &&
          grantDigest === freeze.prepareGrantDigest &&
          transition.delegationId === delegationId &&
          transition.grantDigest === grantDigest &&
          same(child.origin, f.meta.origin) &&
          child.delegationId === delegationId &&
          child.grantDigest === grantDigest &&
          same(child.execution, grant.child) &&
          same(child.settlement.identity, grant.child) &&
          Object.keys(child.grantDigests).length === 0 &&
          refusal.installationId === identity.installationId &&
          same(refusal.origin, f.meta.origin) &&
          same(refusal.ownerPrepare, projection.ownerPrepare) &&
          refusal.rootAdmissionDigest === identity.admissionDigest &&
          refusal.rootCertificateDigest === identity.rootCertificateDigest &&
          refusal.maintenanceId === identity.maintenanceId &&
          refusal.candidateId === identity.candidateId &&
          refusal.planDigest === identity.planDigest &&
          refusal.settlementId === identity.settlementId &&
          refusal.projectionDigest === projectionDigest &&
          refusal.reservationDigest === projection.reservationDigest &&
          same(refusal.prepareExecution, grant.child) &&
          refusal.refusalReceipt.maintenanceId === identity.maintenanceId &&
          refusal.effectReceiptDigest === controlDigest(refusal.refusalReceipt) &&
          child.settlement.terminalReceiptDigest === refusal.effectReceiptDigest &&
          refusal.effectSettlementDigest ===
            controlDigest({ ...child.settlement, receipt: refusal.refusalReceipt }) &&
          refusal.canonicalTerminalDigest ===
            controlDigest({ version: 1, refused: refusal.refusalReceipt }) &&
          evidence.prepareExecutionDigest === controlDigest(grant.child) &&
          evidence.prepareAdmissionDigest === refusal.prepareAdmissionDigest &&
          evidence.refusalProjectionDigest === refusalDigest &&
          evidence.effectSettlementDigest === refusal.effectSettlementDigest &&
          evidence.canonicalTerminalDigest === refusal.canonicalTerminalDigest &&
          evidence.canonicalTerminalAt === refusal.canonicalTerminalAt &&
          evidence.capacityReceiptDigest === refusal.capacityReceiptDigest &&
          freeze.prepareExecutionDigest === evidence.prepareExecutionDigest &&
          freeze.refusalProjectionDigest === refusalDigest &&
          evidence.dmUnusedIntentDigest === intentDigest &&
          evidence.dmUnusedConfirmationDigest === confirmationDigest &&
          dmIntent.role === "data-manager" &&
          dmIntent.installationId === identity.installationId &&
          same(dmIntent.origin, f.meta.origin) &&
          dmIntent.ownerPrepareDigest === controlDigest(projection.ownerPrepare) &&
          dmIntent.prepareExecutionDigest === controlDigest(grant.child) &&
          dmIntent.settlementId === identity.settlementId &&
          dmIntent.projectionDigest === projectionDigest &&
          dmIntent.capacityReceiptDigest === refusal.capacityReceiptDigest &&
          dmIntent.sourceProofDigest === refusalDigest &&
          dmIntent.executionOrdinal === safeState.executionOrdinal &&
          dmIntent.intentOrdinal === safeState.intentOrdinal &&
          dmIntent.recordDescriptorsDigest === safeState.recordDescriptorsDigest &&
          same(dmIntent.allocatedDescriptorDigests, actualDescriptors) &&
          dmConfirmation.role === "data-manager" &&
          dmConfirmation.installationId === identity.installationId &&
          same(dmConfirmation.origin, f.meta.origin) &&
          dmConfirmation.ownerPrepareDigest === dmIntent.ownerPrepareDigest &&
          dmConfirmation.settlementId === identity.settlementId &&
          dmConfirmation.projectionDigest === projectionDigest &&
          dmConfirmation.intentDigest === intentDigest &&
          dmConfirmation.slotStateDigest === controlDigest(safeState) &&
          dmConfirmation.confirmedAt >= dmIntent.createdAt,
        "Original receiver refusal/UNUSED family preimages changed",
      );
      if (capacity)
        need(
          capacity.installationId === identity.installationId &&
            same(capacity.origin, f.meta.origin) &&
            capacity.ownerPrepareDigest === dmIntent.ownerPrepareDigest &&
            capacity.settlementId === identity.settlementId &&
            capacity.projectionDigest === projectionDigest &&
            capacity.reservationDigest === projection.reservationDigest &&
            same(capacity.proposedExecutionAddress, projection.reservation.execution) &&
            capacity.recordDescriptorsDigest === controlDigest(descriptors) &&
            capacity.maxBytes === descriptors.reduce((sum, value) => sum + value.cap, 0) &&
            refusal.capacityReceiptDigest === settlementRecordDigest(domains.capacity, capacity),
          "Original receiver capacity family source changed",
        );
      else
        need(
          refusal.capacityReceiptDigest === null && refusal.refusalReceipt.reason === "capacity",
          "Actual capacity-null family source required",
        );
      dmSlotProof = { role: "data-manager", intentDigest, confirmationDigest };
      dmContainmentDigest = refusal.effectSettlementDigest;
    }
    const descriptors = configurationSettlementRecordDescriptors(projection, prepareKey),
      senderSlot = {
        executionOrdinal: issuerIntent.executionOrdinal,
        intentOrdinal: issuerIntent.intentOrdinal,
        recordDescriptorsDigest: controlDigest(descriptors.sender),
        allocatedDescriptorDigests: descriptors.sender.map((value) => controlDigest(value)).sort(),
        state: "UNUSED",
        intentDigest: issuerIntentDigest,
      };
    need(
      issuerIntent.role === "ops-agent" &&
        issuerIntent.installationId === identity.installationId &&
        same(issuerIntent.origin, f.meta.origin) &&
        issuerIntent.ownerPrepareDigest === controlDigest(projection.ownerPrepare) &&
        issuerIntent.settlementId === identity.settlementId &&
        issuerIntent.projectionDigest === projectionDigest &&
        issuerIntent.prepareExecutionDigest ===
          (evidence.kind === "receiver_refused" ? evidence.prepareExecutionDigest : null) &&
        issuerIntent.capacityReceiptDigest ===
          (evidence.kind === "receiver_refused" ? evidence.capacityReceiptDigest : null) &&
        issuerIntent.sourceProofDigest === configurationIssuerUnusedSourceDigest(evidence) &&
        issuerIntent.executionOrdinal === projection.issuerMembership.rootMemberOrdinal &&
        issuerIntent.intentOrdinal !== null &&
        issuerIntent.recordDescriptorsDigest === senderSlot.recordDescriptorsDigest &&
        same(issuerIntent.allocatedDescriptorDigests, senderSlot.allocatedDescriptorDigests) &&
        issuerConfirmation.role === "ops-agent" &&
        issuerConfirmation.installationId === identity.installationId &&
        same(issuerConfirmation.origin, f.meta.origin) &&
        issuerConfirmation.ownerPrepareDigest === issuerIntent.ownerPrepareDigest &&
        issuerConfirmation.settlementId === identity.settlementId &&
        issuerConfirmation.projectionDigest === projectionDigest &&
        issuerConfirmation.intentDigest === issuerIntentDigest &&
        issuerConfirmation.slotStateDigest === controlDigest(senderSlot) &&
        issuerConfirmation.confirmedAt >= issuerIntent.createdAt &&
        same(
          closure.originalContainmentDigests,
          [ownContainmentDigest, ...(dmContainmentDigest ? [dmContainmentDigest] : [])].sort(),
        ) &&
        same(closure.unusedSlotDigests, [
          ...(dmSlotProof ? [dmSlotProof] : []),
          {
            role: "ops-agent",
            intentDigest: issuerIntentDigest,
            confirmationDigest: issuerConfirmationDigest,
          },
        ]) &&
        same(control.unused, {
          bundleDigest: settlementRecordDigest(domains.bundle, bundle),
          closureDigest: closure.closureDigest,
          issuerFreezeProofDigest: evidence.issuerFreezeProofDigest,
          issuerUnusedIntentDigest: issuerIntentDigest,
          issuerUnusedConfirmationDigest: issuerConfirmationDigest,
        }),
      "Original family issuer UNUSED/bundle linkage changed",
    );
    const unusedExecutionTicketIds: string[] = [],
      unusedIntentTicketIds: string[] = [];
    const verifyUnusedTicket = (
      role: "ops-agent" | "data-manager",
      kind: "executions" | "intents",
      ordinal: number | null,
      intentDigest: string,
    ) => {
      const id = controlDigest({
          purpose: "configurationSettlementSlot",
          role,
          settlementId: identity.settlementId,
          member: kind === "executions" ? "execution" : "intent",
        }),
        directory = own(f.shared.directory(kind));
      if (ordinal === null) {
        for (
          let index = 0;
          index < (kind === "executions" ? LIMITS.executionsPerFamily : LIMITS.intentsPerFamily);
          index++
        ) {
          try {
            need(
              json<{ id: string }>(directory, `slot-${index}.json`, 4096).id !== id,
              "Unexpected allocated NoGuard null slot",
            );
          } catch (error) {
            if (!missing(error)) throw error;
          }
        }
        return;
      }
      const expected = {
        id,
        generation: f.meta.generation,
        value: {
          purpose: "configurationSettlementSlot",
          role,
          settlementId: identity.settlementId,
          projectionDigest,
          address: projection.reservation.execution,
          executionDigest: null,
          controlBindingDigest: null,
          state: "UNUSED",
          unusedIntentDigest: intentDigest,
        },
      };
      need(
        same(json(directory, `slot-${ordinal}.json`, 4096), expected),
        "Original NoGuard shared UNUSED ticket changed",
      );
      (kind === "executions" ? unusedExecutionTicketIds : unusedIntentTicketIds).push(id);
    };
    verifyUnusedTicket("ops-agent", "intents", issuerIntent.intentOrdinal, issuerIntentDigest);
    if (dmIntent && dmSlotProof) {
      verifyUnusedTicket(
        "data-manager",
        "executions",
        dmIntent.executionOrdinal,
        dmSlotProof.intentDigest,
      );
      verifyUnusedTicket(
        "data-manager",
        "intents",
        dmIntent.intentOrdinal,
        dmSlotProof.intentDigest,
      );
    }
    const localIntent = f.state.installation.role === "ops-agent" ? issuerIntent : dmIntent,
      localConfirmation =
        f.state.installation.role === "ops-agent" ? issuerConfirmation : dmConfirmation,
      localDescriptors =
        f.state.installation.role === "ops-agent" ? descriptors.sender : descriptors.receiver;
    need(
      localIntent &&
        localConfirmation &&
        slot.role === f.state.installation.role &&
        slot.projectionDigest === projectionDigest &&
        slot.settlementId === identity.settlementId &&
        slot.reservationDigest === projection.reservationDigest &&
        slot.ownerPrepareDigest === controlDigest(projection.ownerPrepare) &&
        same(slot.proposedExecutionAddress, projection.reservation.execution) &&
        same(slot.descriptors, localDescriptors) &&
        slot.recordDescriptorsDigest === localIntent!.recordDescriptorsDigest &&
        slot.executionOrdinal === localIntent!.executionOrdinal &&
        slot.intentOrdinal === localIntent!.intentOrdinal &&
        same(slot.allocatedDescriptorDigests, localIntent!.allocatedDescriptorDigests) &&
        slot.unusedIntentDigest === settlementRecordDigest(domains.unusedIntent, localIntent!) &&
        slot.unusedConfirmedAt === localConfirmation!.confirmedAt,
      "Actual role-private NoGuard slot differs from its published source",
    );
    settlementSlotTickets(f, slot, false);
    for (const descriptor of localDescriptors.filter(
      (value) =>
        slot.allocatedDescriptorDigests.includes(controlDigest(value)) &&
        (f.state.installation.role === "data-manager"
          ? value !== descriptors.receiver[0]
          : value.scope === "private" || value.name.endsWith("-ack.json")),
    ))
      need(
        localRead(
          { ...descriptor, container: descriptor.scope === "shared" ? descriptor.role : "" },
          descriptor.cap,
        ) === null,
        "Attempted future control cannot retire as UNUSED",
      );
    if (f.state.installation.role === "ops-agent") {
      const owner = verifyControl(
        senderKey,
        "openmapx-configuration-maintenance-owner-v2",
        localRead(
          {
            scope: "private",
            namespace: "configuration-maintenance",
            container: "",
            name: `${identity.maintenanceId}.json`,
          },
          131072,
        ),
        z
          .object({
            admissionDigest: z.string(),
            sequence: z.number(),
            issuance: z.literal("closed_without_guard"),
            guardSource: z.null(),
            final: z.null(),
            inspection: z.null(),
            noGuard: configurationNoGuardIntentSchema,
            receipt: z
              .object({ dmFence: z.null(), generation: z.literal("not_started") })
              .passthrough(),
          })
          .passthrough(),
      );
      need(
        owner.admissionDigest === identity.admissionDigest &&
          owner.sequence === closure.ownerSequence &&
          same(owner.noGuard.bundle?.payload, bundle) &&
          same(owner.noGuard.issuerFreezeProof, bundle.issuerFreezeProof) &&
          same(owner.noGuard.issuerUnused, bundle.issuerUnused),
        "Actual original issuer private closure changed",
      );
    } else {
      const fact = Object.values(p.executions).find(
        (value) => value.execution.operationKey === prepareKey,
      );
      need(
        fact &&
          evidence.kind === "receiver_refused" &&
          fact.receiptDigest === evidence.prepareAdmissionDigest &&
          fact.canonicalDigest === evidence.canonicalTerminalDigest &&
          fact.canonicalTerminalAt === evidence.canonicalTerminalAt &&
          fact.settlementDigest === evidence.effectSettlementDigest &&
          fact.known &&
          fact.journalContained,
        "Actual DM original canonical refusal family facts required",
      );
      need(
        fact!.canonicalDigest === fact!.terminalDigest &&
          f.state.retentionJournal?.contained(fact!.execution, fact!.terminalDigest),
        "Actual original DM refusal journal containment unavailable",
      );
    }
    return { unusedExecutionTicketIds, unusedIntentTicketIds };
  } finally {
    for (const directory of opened.reverse()) directory.close();
  }
}
function identityOfRoot(f: Family) {
  return identity(f.root.stat);
}
function localProof(f: Family, p: Progress): boolean {
  // A reserved logical control is a separate mandatory release/retirement
  // obligation. Ordinary terminal facts cannot stand in for its closure chain.
  if (
    p.configurationSettlementSlot &&
    !preparedClosure(f, p) &&
    !configurationNoGuardFamilyClosure(f, p)
  )
    return false;
  if (
    !Object.keys(p.executions).length ||
    Object.values(p.executions).some((e) => !e.known || e.terminalAt === undefined)
  )
    return false;
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
        json(effects, `${fact.execution.operationKey}.json`, 65536),
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
  const prepared = preparedClosure(f, p),
    terminalAt = Math.max(p.terminalAt, prepared?.terminalAt ?? 0);
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
      ...(prepared
        ? [
            {
              logicalControlTerminalDigest: prepared.terminalDigest,
              terminalAt: prepared.terminalAt,
            },
          ]
        : []),
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
    // Only the FULL source-verified disjoint closure can account an unbound
    // slot without inventing an execution/terminal receipt. Never filter by a
    // caller flag or a ticket's purpose/state in isolation.
    const noGuard = p.configurationSettlementSlot && configurationNoGuardFamilyClosure(f, p);
    const prepared = preparedClosure(f, p);
    if (p.configurationSettlementSlot && !noGuard && !prepared) return false;
    const excludedExecutions = noGuard
        ? noGuard.unusedExecutionTicketIds
        : (prepared?.logicalExecutionTicketIds ?? []),
      excludedIntents = noGuard
        ? noGuard.unusedIntentTicketIds
        : (prepared?.logicalIntentTicketIds ?? []);
    const executions = readAllTickets(f, "executions", LIMITS.executionsPerFamily).filter(
      (value) => !excludedExecutions.includes(value.id),
    );
    const intents = readAllTickets(f, "intents", LIMITS.intentsPerFamily).filter(
      (value) => !excludedIntents.includes(value.id),
    );
    if (
      Object.keys(receipts).length !== executions.length ||
      executions.some((t) => !receipts[t.id]) ||
      intents.some((t) => !receipts[(t.value as { childDigest: string }).childDigest])
    )
      return false;
    const intentDigests = Object.assign({}, ...candidates.map((c) => c.intentDigests)) as Record<
      string,
      string
    >;
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
  if (
    ["active", "prepared"].includes(p.phase) &&
    p.configurationSettlementSlot?.state === "bound"
  ) {
    const observed = readPreparedConfigurationSettlementRetirement(
      f.state.installation,
      f.meta.origin,
    );
    preparedClosures.set(f, { ...observed, localRecordSetDigest: recordSetDigest(records(f)) });
  }
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
): Promise<{ retired: number; pending: number }> {
  const max = options.maxFamilies ?? 16;
  if (!Number.isSafeInteger(max) || max < 1 || max > 64)
    throw Error("Invalid retention maxFamilies");
  options.signal?.throwIfAborted();
  try {
    mkdirSync(state.privateRoot.name(".retention-reconcile-writer"), { mode: 0o700 });
    fsyncSync(state.privateRoot.fd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return { retired: 0, pending: 1 };
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

// Fixed reserved cells and their retirement read the SAME guarded family index.
function directory(
  state: InstallationState,
  descriptor: ConfigurationSettlementRecordDescriptor,
  create: boolean,
) {
  if (
    descriptor.role !== state.installation.role ||
    state.fixedChildId ||
    descriptor.namespace !== (descriptor.scope === "private" ? "observations" : "execution")
  )
    throw Error("Fixed role-local settlement descriptor required");
  const opened: AnchoredDirectory[] = [],
    own = (dir: AnchoredDirectory) => {
      opened.push(dir);
      return dir;
    },
    close = () => {
      for (const dir of opened.reverse()) dir.close();
    };
  try {
    if (descriptor.scope === "private")
      return { dir: own(state.privateRoot.directory("observations", create, true)), close };
    const root = own(new AnchoredDirectory(state.dataRoot)),
      control = own(root.directory(".admin-target-control")),
      executions = own(control.directory("executions", create)),
      dir = own(executions.directory(descriptor.role, create));
    return { dir, close };
  } catch (error) {
    close();
    throw error;
  }
}
export function readConfigurationSettlementCell(
  state: InstallationState,
  projection: Pick<ConfigurationSettlementProjection, "origin">,
  descriptor: ConfigurationSettlementRecordDescriptor,
): unknown {
  const opened = directory(state, descriptor, false),
    dir = opened.dir;
  try {
    const bytes = dir.read(descriptor.name, descriptor.cap).toString("utf8");
    if (Buffer.byteLength(bytes) !== descriptor.cap)
      throw Error("Settlement cell reserved width changed");
    verifyFamilyOwnedRecord(
      state,
      projection.origin,
      { ...descriptor, container: descriptor.scope === "shared" ? descriptor.role : "" },
      bytes,
    );
    return JSON.parse(bytes);
  } finally {
    opened.close();
  }
}
/** Allocation is only called by original PREPARE-time reservation. Updates
 * require the existing indexed padded cell; no late namespace/index allocation. */
export function writeConfigurationSettlementCell(
  state: InstallationState,
  projection: ConfigurationSettlementProjection,
  descriptor: ConfigurationSettlementRecordDescriptor,
  value: unknown,
  allocate = false,
): void {
  const opened = directory(state, descriptor, allocate),
    dir = opened.dir;
  try {
    if (!allocate) readConfigurationSettlementCell(state, projection, descriptor);
    const encoded = canonicalJson(value),
      size = Buffer.byteLength(encoded);
    if (size > descriptor.cap) throw Error("Settlement packet exceeds original reserved cell");
    const bytes = encoded + " ".repeat(descriptor.cap - size);
    familyRecordWrite(
      state,
      projection.origin,
      { ...descriptor, container: descriptor.scope === "shared" ? descriptor.role : "" },
      bytes,
      (beforePublish) =>
        descriptor.scope === "private"
          ? writeRetainedRecord(
              dir,
              descriptor.name,
              bytes,
              allocate,
              CONTROL_RETENTION_LIMITS.recordsPerNamespace,
              beforePublish,
              descriptor.cap,
            )
          : dir.write(descriptor.name, bytes, allocate, beforePublish),
      allocate,
    );
  } finally {
    opened.close();
  }
}
export const configurationSettlementDescriptorDigest = (
  descriptors: readonly ConfigurationSettlementRecordDescriptor[],
) => controlDigest(descriptors);
/** A genuinely unjoined receiver has no role directory yet. Only ENOENT is
 * absence; unreadable/replaced directories and any original publication deny.
 * Callers still need the authentic frozen all-unissued source to use this fact. */
export function assertNoUnissuedConfigurationReceiverPublication(
  state: InstallationState,
  prepareKey: string,
): void {
  const opened: AnchoredDirectory[] = [],
    own = (value: AnchoredDirectory) => {
      opened.push(value);
      return value;
    };
  try {
    const root = own(new AnchoredDirectory(state.dataRoot)),
      control = own(root.directory(".admin-target-control")),
      executions = own(control.directory("executions"));
    let receiver: AnchoredDirectory;
    try {
      receiver = own(executions.directory("data-manager"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const name of [
      `${prepareKey}.configuration-settlement-capacity.json`,
      `${prepareKey}.data-terminal.json`,
      `${prepareKey}.json`,
    ]) {
      try {
        receiver.read(name, 65536);
        throw Error("NeverIssued has an actual original DM publication");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  } finally {
    for (const directory of opened.reverse()) directory.close();
  }
}

const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
function need(value: unknown, message: string): asserts value {
  if (!value) throw Error(message);
}
export function readPreparedConfigurationSettlementRetirement(
  installation: ControlInstallation,
  origin: ControlExecutionOrigin,
) {
  const local = installationState(installation),
    ownRole = installation.role;
  need(
    !local.fixedChildId &&
      ["ops-agent", "data-manager"].includes(ownRole) &&
      origin.issuer === "ops-agent",
    "Original prepared retirement role required",
  );
  const root = new AnchoredDirectory(local.dataRoot),
    opened: AnchoredDirectory[] = [root],
    own = (dir: AnchoredDirectory) => {
      opened.push(dir);
      return dir;
    };
  try {
    const sharedRoot = own(root.directory(".admin-target-control")),
      executions = own(sharedRoot.directory("executions")),
      directories = {
        "ops-agent": own(executions.directory("ops-agent")),
        "data-manager": own(executions.directory("data-manager")),
      },
      shared = (role: "ops-agent" | "data-manager", name: string, cap: number, padded = true) => {
        const bytes = directories[role].read(name, cap).toString("utf8");
        need(!padded || Buffer.byteLength(bytes) === cap, "Prepared retirement cell width changed");
        if (role === ownRole)
          verifyFamilyOwnedRecord(
            local,
            origin,
            { scope: "shared", namespace: "execution", container: role, name },
            bytes,
          );
        return JSON.parse(bytes);
      },
      senderKey = local.publicKeys["ops-agent"],
      dmKey = local.publicKeys["data-manager"],
      control = verifyControl(
        senderKey,
        domains.control,
        shared("ops-agent", `${origin.rootKey}.configuration-settlement-control.json`, 8192),
        configurationSettlementControlCellSchema.shape.payload,
      );
    need(control.binding && !("unused" in control), "Original prepared bound control required");
    const projection = verifyControl(
        senderKey,
        domains.signedProjection,
        control.projection,
        configurationSettlementReservationProjectionSchema,
      ),
      committed = verifyControl(
        senderKey,
        domains.reference,
        shared("ops-agent", `${origin.rootKey}.configuration-settlement.json`, 16384),
        configurationCommittedSettlementSchema,
      ),
      envelope = verifyControl(
        senderKey,
        domains.control,
        control.binding,
        configurationSettlementControlEnvelopeSchema,
      ),
      projectionDigest = settlementRecordDigest(domains.projection, projection),
      commitmentDigest = settlementRecordDigest(domains.commitment, committed),
      prepareKey = projection.ownerPrepare.operationKey,
      prepareOrdinal = projection.reservation.ordinal - 1,
      identity = committed.identity;
    // The actual prepared canonical witness supplies the original DM execution;
    // derive its fixed phase key, never scan or accept a caller lookup address.
    const dmPrepareKey = controlChildOperationKey(
        prepareKey,
        "configuration-fence",
        prepareOrdinal,
      ),
      prepared = verifyControl(
        dmKey,
        dataConfigurationFencePreparedWitnessDomain,
        shared("data-manager", `${dmPrepareKey}.data-terminal.json`, 8192, false),
        dataConfigurationFencePreparedWitnessSchema,
      ),
      descriptors = configurationSettlementRecordDescriptors(projection, dmPrepareKey),
      capacityCell = configurationDmCapacityCellSchema.parse(
        shared("data-manager", descriptors.receiver[0]!.name, descriptors.receiver[0]!.cap),
      );
    need(
      capacityCell.capacity && !capacityCell.refusal && !capacityCell.unused,
      "Actual prepared receiver capacity required",
    );
    const capacity = verifyControl(
        dmKey,
        domains.capacity,
        capacityCell.capacity,
        configurationSettlementCapacitySchema,
      ),
      signedTerminal = shared(
        "data-manager",
        descriptors.receiver[4]!.name,
        descriptors.receiver[4]!.cap,
      ),
      terminal = verifyControl(
        dmKey,
        domains.terminal,
        signedTerminal,
        configurationSettlementPublishedTerminalSchema,
      ),
      tuple = terminal.tuple,
      signedAck = shared("ops-agent", descriptors.sender[5]!.name, descriptors.sender[5]!.cap),
      ack = verifyControl(senderKey, domains.ack, signedAck, configurationSettlementAckSchema),
      {
        operationFingerprint: _body,
        fingerprint: _execution,
        deadlineAt: _deadline,
        ...address
      } = envelope.execution,
      { terminalDigest: _terminalDigest, ...tuplePreimage } = tuple;
    need(
      projection.installationId === installation.installationId &&
        same(projection.origin, origin) &&
        prepareKey === origin.rootKey &&
        projection.settlementId ===
          deriveConfigurationFenceSettlementId({
            installationId: installation.installationId,
            ownerPrepare: projection.ownerPrepare,
            maintenanceId: projection.maintenanceId,
            candidateId: projection.candidateId,
            planDigest: projection.planDigest,
          }) &&
        projection.reservationDigest ===
          settlementRecordDigest(domains.reservationTuple, projection.reservation) &&
        projection.reservation.operationFingerprint === controlDigest(projection.operation) &&
        same(projection.operation, {
          kind: "configuration-maintenance.settle",
          version: 2,
          maintenanceId: projection.maintenanceId,
          candidateId: projection.candidateId,
          planDigest: projection.planDigest,
          settlementId: projection.settlementId,
        }) &&
        same(identity, {
          installationId: installation.installationId,
          origin,
          ownerPrepare: projection.ownerPrepare,
          admissionDigest: projection.rootAdmissionDigest,
          rootCertificateDigest: projection.rootCertificateDigest,
          maintenanceId: projection.maintenanceId,
          candidateId: projection.candidateId,
          planDigest: projection.planDigest,
          settlementId: projection.settlementId,
        }) &&
        same(committed.final.identity, identity) &&
        same(committed.evidence.identity, identity) &&
        committed.referenceOperationFingerprint === projection.reservation.operationFingerprint &&
        committed.ownerReceiptDigest ===
          settlementRecordDigest(domains.ownerFinal, committed.final) &&
        committed.evidenceDigest ===
          settlementRecordDigest(domains.finalEvidence, committed.evidence) &&
        committed.final.evidenceDigest === committed.evidenceDigest &&
        committed.final.outcome === committed.evidence.outcome &&
        committed.committedAt === committed.final.settlingAt &&
        envelope.installationId === installation.installationId &&
        same(envelope.origin, origin) &&
        same(envelope.ownerPrepare, projection.ownerPrepare) &&
        envelope.admissionDigest === projection.rootAdmissionDigest &&
        envelope.rootCertificateDigest === projection.rootCertificateDigest &&
        envelope.settlementId === projection.settlementId &&
        envelope.projectionDigest === projectionDigest &&
        envelope.reservationDigest === projection.reservationDigest &&
        envelope.commitmentDigest === commitmentDigest &&
        same(envelope.operation, projection.operation) &&
        same(envelope.serviceIds, projection.reservation.serviceIds) &&
        same(address, projection.reservation.execution) &&
        envelope.execution.operationFingerprint === projection.reservation.operationFingerprint &&
        envelope.execution.fingerprint ===
          executionFingerprint({
            kind: projection.operation.kind,
            operationFingerprint: projection.reservation.operationFingerprint,
            deadlineAt: envelope.controlDeadlineAt,
            parent: {
              issuer: "ops-agent",
              operationKey: prepareKey,
              fingerprint: projection.ownerPrepare.fingerprint,
              deadlineAt: projection.ownerPrepare.deadlineAt,
              execution: projection.ownerPrepare,
            },
          }),
      "Prepared retirement root/reference preimages changed",
    );
    const rootWitness = readControlExecutionWitness(local, projection.ownerPrepare, senderKey),
      slot = readConfigurationSettlementFamilySlot(local, projection);
    need(
      rootWitness.authorityDigest === projection.rootAdmissionDigest &&
        same(rootWitness.origin, origin) &&
        capacity.installationId === installation.installationId &&
        same(capacity.origin, origin) &&
        capacity.ownerPrepareDigest === controlDigest(projection.ownerPrepare) &&
        capacity.settlementId === projection.settlementId &&
        capacity.projectionDigest === projectionDigest &&
        capacity.reservationDigest === projection.reservationDigest &&
        same(capacity.proposedExecutionAddress, projection.reservation.execution) &&
        capacity.recordDescriptorsDigest === controlDigest(descriptors.receiver) &&
        capacity.maxBytes === descriptors.receiver.reduce((sum, value) => sum + value.cap, 0) &&
        slot.state === "bound" &&
        slot.executionDigest === controlDigest(envelope.execution) &&
        slot.controlBindingDigest === settlementRecordDigest(domains.binding, envelope) &&
        slot.projectionDigest === projectionDigest &&
        slot.reservationDigest === projection.reservationDigest &&
        same(prepared.preparedReceipt, committed.evidence.guard.preparedReceipt) &&
        prepared.preparedReceiptDigest === committed.evidence.guard.preparedReceiptDigest &&
        prepared.preparedCanonicalDigest === committed.evidence.guard.preparedCanonicalDigest &&
        prepared.preparedTerminalAt === committed.evidence.guard.preparedTerminalAt &&
        same(prepared.preparedReceipt.ownerPrepare, projection.ownerPrepare) &&
        prepared.preparedReceipt.maintenanceId === projection.maintenanceId &&
        prepared.preparedReceipt.candidateId === projection.candidateId &&
        prepared.preparedReceipt.planDigest === projection.planDigest &&
        prepared.prepareExecution.operationKey === dmPrepareKey &&
        committed.final.expectedDmSequence === prepared.preparedReceipt.sequence,
      "Actual prepared retirement capacity/guard changed",
    );
    const admissionPayload = configurationSettlementAdmissionSchema.parse({
        version: 2,
        purpose: "configuration-fence-settlement",
        installationId: installation.installationId,
        origin,
        settlementId: projection.settlementId,
        projectionDigest,
        reservationDigest: projection.reservationDigest,
        prepareExecutionDigest: controlDigest(prepared.prepareExecution),
        prepareAdmissionDigest: prepared.prepareAdmissionDigest,
        preparedReceiptDigest: prepared.preparedReceiptDigest,
        capacityReceiptDigest: settlementRecordDigest(domains.capacity, capacity),
        rootCertificateDigest: projection.rootCertificateDigest,
        controlEnvelope: control.binding,
        commitmentDigest,
        executionOrdinal: capacity.reservedExecutionOrdinal,
        intentOrdinal: capacity.reservedIntentOrdinal,
        sqlSessionNonce: envelope.execution.executionId,
        boundAt: terminal.admissionSource.boundAt,
      }),
      signedAdmission = {
        payload: admissionPayload,
        signature: terminal.admissionSource.signature,
      },
      admission = verifyControl(
        dmKey,
        domains.admission,
        signedAdmission,
        configurationSettlementAdmissionSchema,
      ),
      signedEffect = {
        payload: { ...terminal.effectSource.fields, terminal: tuple },
        signature: terminal.effectSource.signature,
      },
      effect = verifyControl(
        dmKey,
        domains.effect,
        signedEffect,
        configurationSettlementEffectSchema,
      );
    need(
      same(terminal.origin, origin) &&
        same(tuple.execution, envelope.execution) &&
        tuple.settlementId === projection.settlementId &&
        tuple.commitmentDigest === commitmentDigest &&
        tuple.fenceId === prepared.preparedReceipt.fenceId &&
        same(tuple.result, {
          ...prepared.preparedReceipt,
          state: "settled",
          sequence: prepared.preparedReceipt.sequence + 1,
        }) &&
        tuple.terminalDigest === settlementRecordDigest(domains.terminal, tuplePreimage) &&
        tuple.terminalAt >= envelope.controlStartedAt &&
        tuple.terminalAt < envelope.controlDeadlineAt &&
        terminal.admissionDigest === settlementRecordDigest(domains.admission, admission) &&
        admission.boundAt >= envelope.controlStartedAt &&
        admission.boundAt < envelope.controlDeadlineAt &&
        effect.phase === "committed" &&
        same(effect.origin, origin) &&
        effect.settlementId === projection.settlementId &&
        effect.controlExecutionDigest === controlDigest(envelope.execution) &&
        effect.controlEnvelopeDigest === settlementRecordDigest(domains.binding, envelope) &&
        effect.admissionDigest === terminal.admissionDigest &&
        effect.commitmentDigest === commitmentDigest &&
        effect.preparedReceiptDigest === prepared.preparedReceiptDigest &&
        effect.expectedDmSequence === prepared.preparedReceipt.sequence &&
        effect.sqlSession.sessionNonce === envelope.execution.executionId &&
        effect.attemptedAt >= admission.boundAt &&
        effect.attemptedAt < envelope.controlDeadlineAt &&
        terminal.effectSettlementDigest === settlementRecordDigest(domains.effect, effect) &&
        ack.installationId === installation.installationId &&
        same(ack.origin, origin) &&
        ack.settlementId === projection.settlementId &&
        ack.controlExecutionDigest === controlDigest(envelope.execution) &&
        ack.commitmentDigest === commitmentDigest &&
        ack.terminalDigest === tuple.terminalDigest &&
        ack.terminalAt === tuple.terminalAt,
      "Actual logical control terminal/ACK required for retirement",
    );
    let releasedAt: number;
    if (ownRole === "ops-agent") {
      const raw = readPrivateRecord(
          local,
          "configuration-maintenance",
          `${projection.maintenanceId}.json`,
        ),
        owner = verifyControl(
          senderKey,
          "openmapx-configuration-maintenance-owner-v2",
          raw,
          configurationMaintenanceOwnerRecordSchema,
        ),
        authority = restoreAdmittedControlExecution(installation, projection.ownerPrepare);
      verifyFamilyOwnedRecord(
        local,
        origin,
        {
          scope: "private",
          namespace: "configuration-maintenance",
          container: "",
          name: `${projection.maintenanceId}.json`,
        },
        canonicalJson(raw),
      );
      assertConfigurationMaintenanceDecisionSource(owner);
      verifyConfigurationMaintenanceRootClosure(authority);
      releasedAt = verifyRetainedArtifactTargetRootRelease(authority).releasedAt;
      need(
        same(configurationMaintenanceSettleCompletion(owner, releasedAt), owner) &&
          owner.apiControls.decide?.receiptDelivery &&
          owner.apiControls.settle?.receiptDelivery &&
          owner.apiControls.steps.every((value) => value.receiptDelivery),
        "Original API canonical delivery required for retirement",
      );
      const binding = verifyControl(
          senderKey,
          domains.binding,
          readConfigurationSettlementCell(local, projection, descriptors.sender[1]!),
          configurationSettlementControlEnvelopeSchema,
        ),
        dispatch = verifyControl(
          senderKey,
          domains.dispatch,
          readConfigurationSettlementCell(local, projection, descriptors.sender[3]!),
          configurationSettlementDispatchSchema,
        ),
        copied = configurationSettlementSenderAckCellSchema.parse(
          readConfigurationSettlementCell(local, projection, descriptors.sender[4]!),
        );
      need(
        same(binding, envelope) &&
          dispatch.phase === "attempted" &&
          dispatch.dispatchId === envelope.dispatchId &&
          dispatch.controlExecutionDigest === controlDigest(envelope.execution) &&
          dispatch.controlEnvelopeDigest === settlementRecordDigest(domains.binding, envelope) &&
          dispatch.commitmentDigest === commitmentDigest &&
          same(copied.terminal, signedTerminal) &&
          same(copied.ack, signedAck),
        "Actual sender original control/copy required",
      );
    } else {
      const raw = readPrivateRecord(
          local,
          "configuration-maintenance",
          `${projection.maintenanceId}.json`,
          65536,
        ),
        mirror = verifyControl(dmKey, "openmapx-data-configuration-fence-v1", raw, mirrorSchema),
        saved = mirror.metadata,
        sql = saved.settlementControl;
      verifyFamilyOwnedRecord(
        local,
        origin,
        {
          scope: "private",
          namespace: "configuration-maintenance",
          container: "",
          name: `${projection.maintenanceId}.json`,
        },
        canonicalJson(raw),
      );
      need(
        saved.guardState === "settled" &&
          sql &&
          same(saved.receipt, prepared.preparedReceipt) &&
          same(saved.settlement, {
            version: 2,
            maintenanceId: projection.maintenanceId,
            candidateId: projection.candidateId,
            planDigest: projection.planDigest,
            settlementId: projection.settlementId,
          }) &&
          same(sql.tuple, tuple) &&
          sql.commitmentDigest === commitmentDigest &&
          sql.admissionDigest === terminal.admissionDigest &&
          sql.controlEnvelopeDigest === settlementRecordDigest(domains.binding, envelope) &&
          sql.preparedReceiptDigest === prepared.preparedReceiptDigest &&
          sql.expectedDmSequence === prepared.preparedReceipt.sequence &&
          sql.outcome === committed.final.outcome &&
          same(sql.sqlSession, effect.sqlSession) &&
          sql.attemptedAt === effect.attemptedAt &&
          same(
            readConfigurationSettlementCell(local, projection, descriptors.receiver[1]!),
            signedAdmission,
          ) &&
          same(
            readConfigurationSettlementCell(local, projection, descriptors.receiver[2]!),
            signedEffect,
          ) &&
          same(
            readConfigurationSettlementCell(local, projection, descriptors.receiver[3]!),
            signedTerminal,
          ) &&
          same(
            readConfigurationSettlementCell(local, projection, descriptors.receiver[5]!),
            signedAck,
          ),
        "Actual DM SQL mirror/private terminal/ACK required",
      );
      releasedAt = verifyConfigurationFenceSettlementReleasedOwner(
        installation,
        mirror.prepareAssertion,
        {
          ownerPrepare: projection.ownerPrepare,
          ownerCertificateDigest: projection.rootCertificateDigest,
          serviceIds: envelope.serviceIds,
        },
      );
    }
    return Object.freeze({
      terminalAt: Math.max(prepared.preparedTerminalAt, tuple.terminalAt, releasedAt),
      terminalDigest: tuple.terminalDigest,
      logicalExecutionTicketIds: [
        controlDigest({
          purpose: "configurationSettlementSlot",
          role: "data-manager",
          settlementId: projection.settlementId,
          member: "execution",
        }),
      ],
      logicalIntentTicketIds: ["ops-agent", "data-manager"].map((role) =>
        controlDigest({
          purpose: "configurationSettlementSlot",
          role,
          settlementId: projection.settlementId,
          member: "intent",
        }),
      ),
    });
  } finally {
    for (const directory of opened.reverse()) directory.close();
  }
}
