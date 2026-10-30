import { dataWorkflowReceiptSchema } from "../ops/job-evidence";
import {
  configurationHandoffIntentRecordSchema,
  configurationHandoffProgressSchema,
  configurationHandoffRecordDomains,
  configurationHandoffRecordName,
  configurationHandoffWorkerRecordSchema,
} from "./configuration-handoff-records";
import {
  type ControlChildPhase,
  type ControlRecipient,
  childPhaseKinds,
  controlChildOperationKey,
} from "./control-child-records";
import { dataUpdatePlanSchema } from "./data-update-records";
import { dataUpdateSourcesDigest } from "./data-update-sources";
import {
  LOCAL_CREDENTIAL_TEMPLATE_KIND,
  localCredentialTemplateFileMac,
  localCredentialTemplateOperationSchema,
  localCredentialTemplateReceiptSchema,
} from "./local-credential-template";

export {
  type ControlChildPhase,
  type ControlRecipient,
  childPhaseKinds,
  controlChildOperationKey,
} from "./control-child-records";

import {
  type ControlInstallation,
  controlDigest,
  controlOriginSchema,
  digest,
  type InstallationState,
  originRecordDomain,
  sameControlOrigin,
  signControl,
  targetSchema,
  uuid,
  validateOriginRecord,
  verifyControl,
} from "./control-records";
// biome-ignore-start lint/suspicious/noImportCycles: Exact and reserved children share the same live guards; phase schemas are lazy and these cross-module calls run after initialization.
import {
  closeArtifactTargetLeaseHandle,
  inspectArtifactTargetLeaseChildSettlement,
  restoreArtifactTargetLeaseForSettlement,
  verifyRetainedArtifactTargetRootRelease,
  verifyRetainedGenerationHardlinksSettlement,
} from "./target-lease";

// biome-ignore-end lint/suspicious/noImportCycles: Same exact deferred guard import.

export {
  type ControlInstallation,
  controlDigest,
  controlOriginSchema,
  digest,
  type InstallationState,
  originRecordDomain,
  sameControlOrigin,
  signControl,
  targetSchema,
  uuid,
  validateOriginRecord,
  verifyControl,
} from "./control-records";

import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  randomUUID,
} from "node:crypto";
import { existsSync, fsyncSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { z } from "zod";
import type { PreparedConfigurationRecord } from "../ops/configuration-preparation";
import {
  type OpsJobStatus,
  type OpsOperationKind,
  opsOperationSchema,
  opsResourceId,
  parseBoundedOpsResult,
  parseOpsJobStatus,
} from "../ops/contract";
import {
  controlTerminalReceiptDigest,
  verifyApiRetentionProof,
} from "../ops/control-retention-receipt";
import { type ControlExecutionOrigin, parseControlRootOperationKey } from "../ops/control-root-key";
import { coordinatorPullSubmissionDigest } from "../ops/coordinator-lifecycle-records";
import {
  type ControlIssuer,
  type ExecutionRef,
  executionFingerprint,
  executionRefSchema,
  opsExecutionMaximumMs,
  type RetainedParentExecution,
  retainedParentExecutionSchema,
} from "../ops/execution-identity";
import { canonicalJson, opsOperationFingerprint } from "../ops/fingerprint";
import { servicePullResultSchema } from "../ops/service-operation-records";
import { verifiedParentOrigins, verifiedParents } from "../ops/verified-parent-internal";
import {
  currentConfigurationGeneration,
  type OriginalConfigurationGenerationNonCommit,
  originalConfigurationGenerationNonCommitSource,
} from "../services/configuration-generation";
import { dataConfigurationFenceReceiptSchema } from "../services/data-manager/contracts/configuration-maintenance";
import {
  dataExecutionStatusSchema,
  startGenerationHardlinksExecutionSchema,
} from "../services/data-manager/contracts/executions";
// biome-ignore-start lint/suspicious/noImportCycles: Exact and reserved children share the same live guards; phase schemas are lazy and these cross-module calls run after initialization.
import {
  type ControlChildReservation,
  controlChildReservationSchema,
  initializeControlChildReservations,
  inspectControlChildPublication,
  lookupControlChildPhase,
  lookupControlChildPhaseAttempt,
  prepareControlChildPublication,
  resolveControlChildPlan,
  validateControlChildReservations,
} from "./child-phase";
import {
  configurationNoGuardIntentSchema,
  configurationSettlementDomains,
  settlementRecordDigest,
} from "./configuration-fence-settlement-records";
import {
  configurationMaintenanceForwardDomain,
  configurationMaintenanceForwardGraphSchema,
  configurationMaintenanceForwardSchema,
} from "./configuration-maintenance-forward-records";
import {
  assertConfigurationMaintenanceDecisionSource,
  configurationMaintenanceDecisionCommitmentDomain,
  configurationMaintenanceDecisionCommitmentPayloadSchema,
  configurationMaintenanceOwnerRecordSchema,
} from "./configuration-maintenance-owner-records";
// biome-ignore-end lint/suspicious/noImportCycles: Live protocol dependency described above.
import { CONTROL_RETENTION_LIMITS, writeRetainedRecord } from "./control-retention";
import {
  type ControlRetentionPreparationContext,
  type CoordinatorPullBaseline,
  coordinatorPullBaselineSchema,
  coordinatorPullObservationDomain,
  coordinatorPullWitnessPayloadSchema,
  coordinatorPullWitnessSchema,
  stagedCoordinatorObservationDomain,
  stagedCoordinatorObservationPayloadSchema,
  stagedCoordinatorSourceSchema,
} from "./coordinator-pull-records";
// biome-ignore-start lint/suspicious/noImportCycles: Fixed proof verification uses this module's original nominal authority and effect writer after initialization.
import {
  inspectFeedProxyValidationFailure,
  publishFeedProxyCanonicalTerminal,
  recordFeedProxyReloadAttempted,
} from "./data-execution-candidate";
// biome-ignore-end lint/suspicious/noImportCycles: Fixed live proof dependency described above.
import { AnchoredDirectory, identity } from "./filesystem";
import { buildFixedConfigurationMaintenancePlan } from "./fixed-configuration-maintenance";
import {
  assertOriginClockForward,
  bootstrapRetentionClock,
  readRetentionClock,
} from "./retention-clock";
// biome-ignore-start lint/suspicious/noImportCycles: Authority records and terminal repair share this sole per-origin index. Runtime calls must consume the same nominal owner, never a second authority map or callback.
import {
  acknowledgeRetentionDependency,
  assertFamilyCanonicalCompatibility,
  completeFamilyJournal,
  enlistFamilyIntent,
  familyRecordWrite,
  hasLocalRetentionFamily,
  hasRetentionEvidence,
  markFamilyTerminal,
  publishFamilyCanonicalTerminal,
  readActiveStagedCoordinatorApiCopy,
  reconcileRetentionFamilies,
  registerFamilyExecution,
  requireFamilyJournal,
  retentionApiDependency,
  verifyFamilyOwnedRecord,
} from "./retention-family";
// biome-ignore-end lint/suspicious/noImportCycles: Exact deferred original-owner/index guard join.
export const CONTROL_ROLES = ["ops-agent", "data-manager", "host-cli"] as const;
declare const authorityBrand: unique symbol,
  peerBrand: unique symbol,
  settlementBrand: unique symbol,
  recoveryBrand: unique symbol,
  assertionBrand: unique symbol;
export type VerifiedExecutionAuthority = Readonly<{
  execution: ExecutionRef;
  [authorityBrand]: true;
}>;
export type VerifiedControlPeer = Readonly<{ [peerBrand]: true }>;
export type VerifiedChildSettlement = Readonly<{ [settlementBrand]: true }>;
export type VerifiedRecoveryAuthority = Readonly<{ [recoveryBrand]: true }>;
export type ArtifactDelegationAssertion = string & { readonly [assertionBrand]: true };
export type ChildSettlement = {
  identity: ExecutionRef;
  outcome: "contained" | "committed" | "failed_without_effect" | "unknown";
  publication: "not_started" | "committed" | "unknown";
  terminalReceiptDigest: string;
};
export type { ControlExecutionOrigin } from "../ops/control-root-key";

const publicKey = z.string().max(256);
const bundleSchema = z.strictObject({
  installationId: uuid,
  publicKeys: z.strictObject({
    "ops-agent": publicKey,
    "data-manager": publicKey,
    "host-cli": publicKey,
  }),
});
const roleKeySchema = z.strictObject({
  version: z.literal(1),
  installationId: uuid,
  role: z.enum(CONTROL_ROLES),
  privateKey: z.string().max(512),
});

export function newControlKey() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKey,
    publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64url"),
  };
}
function parsePrivate(encoded: string) {
  const key = createPrivateKey({
    key: Buffer.from(encoded, "base64url"),
    format: "der",
    type: "pkcs8",
  });
  if (key.asymmetricKeyType !== "ed25519") throw Error("Invalid control key kind");
  return key;
}
export const encodePrivate = (key: KeyObject) =>
  key.export({ type: "pkcs8", format: "der" }).toString("base64url");
export async function provisionControlInstallation(infraDir: string): Promise<void> {
  const infra = new AnchoredDirectory(infraDir);
  let secrets: AnchoredDirectory | undefined, privateRoot: AnchoredDirectory | undefined;
  try {
    secrets = infra.directory("secrets", true);
    const names = secrets.list();
    const existing = names.filter(
      (n) =>
        n === "control-verifiers.json" ||
        /^control-(ops-agent|data-manager|host-cli)\.key$/.test(n),
    );
    if (existing.length && existing.length !== 4)
      throw Error(
        "Incomplete control installation trust; stop all writers/helpers and recover existing keys/verifiers, never regenerate",
      );
    const newInstallation = existing.length === 0;
    if (newInstallation) {
      if (existsSync(join(infraDir, "control-private"))) {
        const priorPrivate = infra.directory("control-private");
        try {
          if (priorPrivate.hasEntries())
            throw Error("Existing private control records require original installation trust");
        } finally {
          priorPrivate.close();
        }
      }
      if (existsSync(join(infraDir, "data/.admin-target-control")))
        throw Error("Existing control records require original installation trust");
      const installationId = randomUUID();
      const keys = Object.fromEntries(CONTROL_ROLES.map((role) => [role, newControlKey()]));
      for (const role of CONTROL_ROLES) {
        secrets.write(
          `control-${role}.key`,
          canonicalJson({
            version: 1,
            installationId,
            role,
            privateKey: encodePrivate(keys[role]?.privateKey),
          }),
          true,
        );
      }
      secrets.write(
        "control-verifiers.json",
        canonicalJson({
          installationId,
          publicKeys: Object.fromEntries(
            CONTROL_ROLES.map((role) => [role, keys[role]?.publicKey]),
          ),
        }),
        true,
      );
    }
    const bundle = bundleSchema.parse(
      JSON.parse(secrets.read("control-verifiers.json", 4096).toString("utf8")),
    );
    for (const role of CONTROL_ROLES) {
      const saved = roleKeySchema.parse(
        JSON.parse(secrets.read(`control-${role}.key`, 2048).toString("utf8")),
      );
      if (
        saved.role !== role ||
        saved.installationId !== bundle.installationId ||
        createPublicKey(parsePrivate(saved.privateKey))
          .export({ type: "spki", format: "der" })
          .toString("base64url") !== bundle.publicKeys[role]
      )
        throw Error("Control role key does not match fixed trust");
    }
    privateRoot = infra.directory("control-private", true, true);
    privateRoot.directory("empty", true, true).close();
    if (!privateRoot.list().includes("hidden-key")) privateRoot.write("hidden-key", "", true);
    for (const role of CONTROL_ROLES) {
      const roleRoot = privateRoot.directory(role, true, true);
      try {
        const saved = roleKeySchema.parse(
          JSON.parse(secrets.read(`control-${role}.key`, 2048).toString("utf8")),
        );
        if (newInstallation)
          bootstrapRetentionClock({
            installation: { role, installationId: bundle.installationId },
            privateRoot: roleRoot,
            privateKey: parsePrivate(saved.privateKey),
            publicKeys: bundle.publicKeys,
          });
      } finally {
        roleRoot.close();
      }
    }
  } finally {
    privateRoot?.close();
    secrets?.close();
    infra.close();
  }
}
const installations = new WeakMap<object, InstallationState>();
export function installationState(value: ControlInstallation): InstallationState {
  const state = installations.get(value);
  if (!state) throw Error("Unverified control installation");
  state.privateRoot.check();
  return state;
}
/** Called only at fixed host/service startup; infraDir is the configured installation, never a request field. */
export function openControlInstallation(options: {
  infraDir: string;
  role: ControlIssuer;
  serviceIds?: readonly string[];
  container?: boolean;
}): ControlInstallation {
  if (options.serviceIds?.length) targetSchema.parse([...new Set(options.serviceIds)].sort());
  const infra = options.container ? undefined : new AnchoredDirectory(options.infraDir);
  const secrets = options.container
    ? new AnchoredDirectory("/run/secrets", undefined, false, true)
    : (() => {
        if (!infra) throw Error("Missing fixed installation root");
        return infra.directory("secrets");
      })();
  let privateRoot: AnchoredDirectory | undefined;
  try {
    const bundle = bundleSchema.parse(
      JSON.parse(
        secrets
          .read(options.container ? "openmapx-control-verifiers" : "control-verifiers.json", 4096)
          .toString("utf8"),
      ),
    );
    const saved = roleKeySchema.parse(
      JSON.parse(
        secrets
          .read(
            options.container ? "openmapx-control-role-key" : `control-${options.role}.key`,
            2048,
          )
          .toString("utf8"),
      ),
    );
    const key = parsePrivate(saved.privateKey);
    if (
      saved.role !== options.role ||
      saved.installationId !== bundle.installationId ||
      createPublicKey(key).export({ type: "spki", format: "der" }).toString("base64url") !==
        bundle.publicKeys[options.role]
    )
      throw Error("Control role key/trust mismatch");
    privateRoot = new AnchoredDirectory(
      options.container
        ? "/var/lib/openmapx/control-private"
        : join(options.infraDir, "control-private", options.role),
      undefined,
      true,
    );
    const dataRoot =
      options.container && options.role === "data-manager"
        ? "/data"
        : join(options.infraDir, "data");
    const privateRelative = relative(realpathSync(dataRoot), realpathSync(privateRoot.path));
    if (!privateRelative || (!privateRelative.startsWith("../") && privateRelative !== ".."))
      throw Error("Role recovery material is inside the shared data mount");
    const data = new AnchoredDirectory(dataRoot);
    try {
      if (
        identity(data.stat).dev === identity(privateRoot.stat).dev &&
        identity(data.stat).ino === identity(privateRoot.stat).ino
      )
        throw Error("Role recovery material must be outside shared data");
    } finally {
      data.close();
    }
    const installation = Object.freeze({
      installationId: bundle.installationId,
      role: options.role,
      publicKey: bundle.publicKeys[options.role],
    }) as ControlInstallation;
    installations.set(installation, {
      installation,
      privateKey: key,
      publicKeys: bundle.publicKeys,
      privateRoot,
      dataRoot,
      registeredTargets: new Set(options.serviceIds ?? []),
    });
    privateRoot = undefined;
    return installation;
  } finally {
    privateRoot?.close();
    secrets.close();
    infra?.close();
  }
}
export function closeControlInstallation(installation: ControlInstallation) {
  const s = installationState(installation);
  s.privateRoot.close();
  installations.delete(installation);
}
export interface ControlPlannedChild {
  phase: ControlChildPhase;
  ordinal: number;
  kind: string;
  execution: ExecutionRef;
  serviceIds: readonly string[];
  recipient: ControlRecipient;
}
const plannedChildSchema = z.strictObject({
  phase: z.enum(Object.keys(childPhaseKinds) as [ControlChildPhase, ...ControlChildPhase[]]),
  ordinal: z.number().int().min(0).max(63),
  kind: z.string().max(128),
  execution: executionRefSchema,
  serviceIds: targetSchema,
  recipient: z.enum(["fixed-cli", "data-manager", "ops-agent", "configuration-helper"]),
});
export interface AuthorityState {
  installation: InstallationState;
  execution: ExecutionRef;
  kind: string;
  serviceIds: readonly string[];
  plan: readonly ControlPlannedChild[];
  reservations: readonly ControlChildReservation[];
  receiptDigest: string;
  origin?: ControlExecutionOrigin;
}
const authorities = new WeakMap<object, AuthorityState>();
export function executionAuthorityState(value: VerifiedExecutionAuthority) {
  const s = authorities.get(value);
  if (!s) throw Error("Unverified execution authority");
  s.installation.privateRoot.check();
  const current = readPrivateRecord(
    s.installation,
    `executions`,
    `${s.execution.operationKey}.json`,
    65536,
  );
  if (controlDigest(current) !== s.receiptDigest)
    throw Error("Durable execution authority changed");
  return s;
}
export function writePrivateRecord(
  state: InstallationState,
  namespace: string,
  name: string,
  value: unknown,
  exclusive = false,
  origin?: ControlExecutionOrigin,
) {
  const dir = state.privateRoot.directory(namespace, true, true);
  try {
    const bytes = canonicalJson(value);
    if (Buffer.byteLength(bytes) > (namespace === "hardlinks" ? 1024 * 1024 : 131072))
      throw Error("Private receipt limit");
    if (
      ![
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
      ].includes(namespace)
    )
      throw Error("Unknown fixed authority namespace");
    const write = (beforePublish?: (inode: import("./filesystem").FileIdentity) => void) =>
      writeRetainedRecord(
        dir,
        name,
        bytes,
        exclusive,
        CONTROL_RETENTION_LIMITS.recordsPerNamespace,
        beforePublish,
        namespace === "hardlinks" ? 1024 * 1024 : CONTROL_RETENTION_LIMITS.privateRecordBytes,
      );
    if (origin)
      familyRecordWrite(
        state,
        origin,
        { scope: "private", namespace, name, container: "" },
        bytes,
        write,
        exclusive,
      );
    else write();
  } finally {
    dir.close();
  }
}
export function retainedExecutionOrigin(
  state: InstallationState,
  execution: ExecutionRef,
): ControlExecutionOrigin | undefined {
  const raw = readPrivateRecord(state, "executions", `${execution.operationKey}.json`, 65536);
  const admitted = verifyControl(
    state.installation.publicKey,
    originRecordDomain("openmapx-control-execution", raw),
    raw,
    z
      .object({
        version: z.union([z.literal(1), z.literal(2)]),
        execution: executionRefSchema,
        origin: controlOriginSchema.optional(),
      })
      .passthrough(),
  );
  if (
    !validateOriginRecord(admitted) ||
    controlDigest(execution) !== controlDigest(admitted.execution)
  )
    throw Error("Execution origin identity mismatch");
  return admitted.origin;
}
export function reconcileControlRetention(
  installation: ControlInstallation,
  options?: { signal?: AbortSignal; maxFamilies?: number },
): Promise<{ retired: number; pending: number }> {
  return reconcileRetentionFamilies(installationState(installation), options);
}
/** No effect authority: binds the agent's retained API receipt dependency only. */
export function acknowledgeControlRetention(
  installation: ControlInstallation,
  input: {
    originRootKey: string;
    operationKey: string;
    fingerprint: string;
    terminalDigest: string;
    proof: string;
  },
  token: string,
): { acknowledged: true } {
  const state = installationState(installation);
  if (installation.role !== "ops-agent" || state.fixedChildId)
    throw Error("Fixed API receipt adapter required");
  if (Buffer.byteLength(canonicalJson(input)) > 16384)
    throw Error("Retention acknowledgement exceeds capacity");
  const proof = verifyApiRetentionProof(token, input.proof);
  if (
    proof.operationKey !== input.operationKey ||
    proof.fingerprint !== input.fingerprint ||
    proof.terminalDigest !== input.terminalDigest
  )
    throw Error("Receipt proof identity conflict");
  const parsed = parseControlRootOperationKey(input.originRootKey);
  const origin: ControlExecutionOrigin = {
    version: 1,
    rootKey: input.originRootKey,
    issuer: "ops-agent",
    notAfter: parsed.notAfter,
  };
  if (!hasRetentionEvidence(state, origin)) {
    if (
      input.originRootKey !== input.operationKey ||
      parsed.notAfter > readRetentionClock(state).rejectNotAfterThrough
    )
      throw Error("Receipt dependency recovery required");
    // This discharges no surviving dependency; it asserts no operation outcome.
    return { acknowledged: true };
  }
  const dependency = retentionApiDependency(state, origin);
  if (
    !dependency ||
    dependency.operationKey !== input.operationKey ||
    dependency.fingerprint !== input.fingerprint ||
    dependency.parent.apiJobId !== proof.apiJobId ||
    dependency.parent.apiOwnerVersion !== proof.originalApiOwnerVersion ||
    dependency.parent.attemptId !== proof.attemptId
  )
    throw Error("Receipt parent/attempt conflict");
  acknowledgeRetentionDependency(state, origin, {
    operationKey: input.operationKey,
    fingerprint: input.fingerprint,
    terminalDigest: input.terminalDigest,
    proofDigest: controlDigest(proof),
  });
  return { acknowledged: true };
}
const terminalCommitmentSchema = z.strictObject({
  version: z.literal(1),
  phase: z.enum(["prepared", "canonical"]),
  installationId: uuid,
  origin: controlOriginSchema,
  execution: executionRefSchema,
  admissionDigest: digest,
  terminalDigest: digest,
  terminalAt: z.number().int().positive().safe(),
});
const terminalCommitmentName = (execution: ExecutionRef) =>
  `terminal-${execution.operationKey}.json`;
function terminalIdentity(s: AuthorityState, status: OpsJobStatus) {
  const terminal = parseOpsJobStatus(status),
    execution = s.execution;
  const raw = readPrivateRecord(
    s.installation,
    "executions",
    `${execution.operationKey}.json`,
    65536,
  );
  const admitted = verifyControl(
    s.installation.installation.publicKey,
    originRecordDomain("openmapx-control-execution", raw),
    raw,
    z
      .object({ admittedAt: z.number().int().nonnegative().safe(), operation: opsOperationSchema })
      .passthrough(),
  );
  if (
    !s.origin ||
    s.installation.installation.role !== "ops-agent" ||
    s.installation.fixedChildId ||
    terminal.version !== 2 ||
    terminal.admittedAt !== admitted.admittedAt ||
    terminal.operationId !== execution.executionId ||
    terminal.operationKey !== execution.operationKey ||
    terminal.fingerprint !== execution.fingerprint ||
    terminal.deadlineAt !== execution.deadlineAt ||
    terminal.kind !== s.kind
  )
    throw Error("Original terminal identity required");
  return { terminal, admitted, digest: controlTerminalReceiptDigest(terminal) };
}
function readTerminalCommitment(s: AuthorityState) {
  const proof = verifyControl(
    s.installation.installation.publicKey,
    "openmapx-control-terminal-v1",
    readPrivateRecord(s.installation, "observations", terminalCommitmentName(s.execution), 4096),
    terminalCommitmentSchema,
  );
  if (
    proof.installationId !== s.installation.installation.installationId ||
    proof.admissionDigest !== s.receiptDigest ||
    controlDigest(proof.execution) !== controlDigest(s.execution) ||
    !sameControlOrigin(proof.origin, s.origin)
  )
    throw Error("Original terminal commitment identity changed");
  return proof;
}
/** Fixed live producer only: sign the full canonical tuple digest and original
 * time before its public journal row. This record makes no containment claim. */
export function retainControlTerminalCommitment(
  authority: VerifiedExecutionAuthority,
  status: OpsJobStatus,
  terminalAt: number,
): number {
  const s = executionAuthorityState(authority),
    value = terminalIdentity(s, status),
    origin = s.origin;
  if (!origin || !Number.isSafeInteger(terminalAt) || terminalAt < value.admitted.admittedAt)
    throw Error("Invalid original terminal time");
  return withPrivateEffectWriter(s, () => {
    const raw = readPrivateRecord(
      s.installation,
      "observations",
      terminalCommitmentName(s.execution),
      4096,
    );
    const prior = raw === null ? undefined : readTerminalCommitment(s);
    const originalTime = prior?.terminalAt ?? terminalAt;
    assertFamilyCanonicalCompatibility(
      s.installation,
      origin,
      s.execution,
      value.digest,
      originalTime,
    );
    if (prior) {
      if (prior.terminalDigest === value.digest) return originalTime;
      // Configuration results stay masked while confidential claim cleanup
      // refines their prepared result. A canonical receipt is never replaceable.
      if (prior.phase !== "prepared" || !("revisionId" in value.admitted.operation))
        throw Error("Original terminal tuple conflict");
    }
    const payload = terminalCommitmentSchema.parse({
      version: 1,
      phase: "prepared",
      installationId: s.installation.installation.installationId,
      origin,
      execution: s.execution,
      admissionDigest: s.receiptDigest,
      terminalDigest: value.digest,
      terminalAt: originalTime,
    });
    writePrivateRecord(
      s.installation,
      "observations",
      terminalCommitmentName(s.execution),
      signControl(s.installation.privateKey, "openmapx-control-terminal-v1", payload),
      false,
      origin,
    );
    return originalTime;
  });
}
function verifyAndSealTerminalCommitment(
  s: AuthorityState,
  status: OpsJobStatus,
  terminalAt?: number,
) {
  const value = terminalIdentity(s, status),
    proof = readTerminalCommitment(s),
    origin = s.origin;
  if (
    !origin ||
    proof.terminalDigest !== value.digest ||
    (terminalAt !== undefined && proof.terminalAt !== terminalAt)
  )
    throw Error("Original canonical terminal tuple/time changed");
  assertFamilyCanonicalCompatibility(
    s.installation,
    origin,
    s.execution,
    value.digest,
    proof.terminalAt,
  );
  if (proof.phase === "prepared")
    writePrivateRecord(
      s.installation,
      "observations",
      terminalCommitmentName(s.execution),
      signControl(s.installation.privateKey, "openmapx-control-terminal-v1", {
        ...proof,
        phase: "canonical" as const,
      }),
      false,
      origin,
    );
  return proof;
}
export function retainControlTerminalStatus(
  installation: ControlInstallation,
  execution: ExecutionRef,
  status: OpsJobStatus,
  terminalAt?: number,
): void {
  const authority = restoreAdmittedControlExecution(installation, execution),
    s = executionAuthorityState(authority);
  withPrivateEffectWriter(s, () => {
    const proof = verifyAndSealTerminalCommitment(s, status, terminalAt),
      origin = s.origin;
    if (!origin) throw Error("Missing terminal origin");
    if (s.kind === "feedProxy.validateAndReload")
      publishFeedProxyCanonicalTerminal(authority, status, proof.terminalAt);
    const settlement = childSettlementState(verifyControlEffectSettlement(installation, execution));
    publishFamilyCanonicalTerminal(
      s.installation,
      origin,
      execution,
      settlement.evidence.outcome !== "unknown" &&
        (status.state === "succeeded" || settlement.evidence.publication !== "committed"),
      proof.terminalDigest,
      proof.terminalAt,
    );
  });
}
/** Rejoin a terminal worker from its original signed admission and known effect
 * receipt. The fixed startup adapter separately proves borrowed/claim cleanup. */
export function repairControlJournalTerminal(
  installation: ControlInstallation,
  execution: ExecutionRef,
  status: OpsJobStatus,
  terminalAt: number,
): VerifiedExecutionAuthority {
  const authority = restoreAdmittedControlExecution(installation, execution),
    s = executionAuthorityState(authority);
  const terminal = parseOpsJobStatus(status);
  if (
    !s.origin ||
    installation.role !== "ops-agent" ||
    s.installation.fixedChildId ||
    terminal.version !== 2 ||
    terminal.admittedAt === undefined ||
    terminal.operationId !== execution.executionId ||
    terminal.operationKey !== execution.operationKey ||
    terminal.fingerprint !== execution.fingerprint ||
    terminal.deadlineAt !== execution.deadlineAt ||
    terminal.kind !== s.kind ||
    !Number.isSafeInteger(terminalAt) ||
    terminalAt < terminal.admittedAt
  )
    throw Error("Original terminal journal identity required");
  const origin = s.origin;
  withPrivateEffectWriter(s, () => {
    const admittedRaw = readPrivateRecord(
      s.installation,
      "executions",
      `${execution.operationKey}.json`,
      65536,
    );
    const admitted = verifyControl(
      installation.publicKey,
      originRecordDomain("openmapx-control-execution", admittedRaw),
      admittedRaw,
      z.object({ admittedAt: z.number().int().nonnegative().safe() }).passthrough(),
    );
    if (admitted.admittedAt !== terminal.admittedAt) throw Error("Original admission time changed");
    verifyControlEffectSettlement(installation, execution);
    const proof = verifyControl(
      installation.publicKey,
      "openmapx-control-settlement-v1",
      readPrivateRecord(s.installation, "effects", `${execution.operationKey}.json`, 65536),
      settlementSchema.extend({ receipt: effectObservationSchema }),
    );
    const succeeded =
      terminal.state === "succeeded" &&
      proof.outcome === "committed" &&
      proof.publication === "committed" &&
      proof.receipt.kind === "ops-result" &&
      controlDigest(proof.receipt.result) === controlDigest(terminal.result);
    const failedWithoutEffect =
      ["failed", "timed_out"].includes(terminal.state) &&
      proof.outcome === "failed_without_effect" &&
      proof.publication === "not_started" &&
      proof.receipt.kind === "not-started";
    const validationFailed =
      terminal.state === "failed" &&
      s.kind === "feedProxy.validateAndReload" &&
      proof.outcome === "contained" &&
      proof.publication === "not_started" &&
      proof.receipt.kind === "feed-proxy-validation-failure" &&
      inspectFeedProxyValidationFailure(authority, proof.receipt.commitmentDigest) !== null;
    const generationNotCommitted =
      terminal.state === "succeeded" &&
      proof.outcome === "contained" &&
      proof.publication === "not_started" &&
      proof.receipt.kind === "configuration-generation-not-committed" &&
      canonicalJson(proof.receipt.result) === canonicalJson(terminal.result) &&
      canonicalJson(inspectConfigurationGenerationNonCommit(installation, execution)) ===
        canonicalJson(proof.receipt);
    if (!succeeded && !failedWithoutEffect && !validationFailed && !generationNotCommitted)
      throw Error("Terminal worker containment is not proved");
    const committed = verifyAndSealTerminalCommitment(s, terminal, terminalAt);
    if (s.kind === "feedProxy.validateAndReload")
      publishFeedProxyCanonicalTerminal(authority, terminal, committed.terminalAt);
    publishFamilyCanonicalTerminal(
      s.installation,
      origin,
      execution,
      true,
      committed.terminalDigest,
      committed.terminalAt,
    );
    completeFamilyJournal(s.installation, origin, execution, terminalAt);
  });
  return authority;
}
/** Fixed agent adapter, installed before startup reconciliation; no request carries this capability. */
export function registerControlRetentionJournal(
  installation: ControlInstallation,
  journal: NonNullable<InstallationState["retentionJournal"]>,
): () => void {
  const s = installationState(installation);
  if (s.fixedChildId || installation.role !== "ops-agent" || s.retentionJournal)
    throw Error("Invalid journal retention adapter");
  s.retentionJournal = journal;
  return () => {
    if (s.retentionJournal === journal) s.retentionJournal = undefined;
  };
}
export function completeControlJournalExecution(authority: VerifiedExecutionAuthority): void {
  const s = executionAuthorityState(authority);
  if (!s.origin) throw Error("Missing journal origin");
  completeFamilyJournal(s.installation, s.origin, s.execution);
}
export function requireControlJournalRetention(authority: VerifiedExecutionAuthority): void {
  const s = executionAuthorityState(authority);
  if (!s.origin) throw Error("Legacy origin is observation-only");
  // Reserve the immutable terminal authentication cell before any effect.
  writePrivateRecord(
    s.installation,
    "observations",
    terminalCommitmentName(s.execution),
    null,
    true,
    s.origin,
  );
  requireFamilyJournal(s.installation, s.origin, s.execution);
}
export function hasRetainedControlOrigin(
  installation: ControlInstallation,
  rootKey: string,
): boolean {
  try {
    const parsed = parseControlRootOperationKey(rootKey);
    return hasRetentionEvidence(installationState(installation), {
      version: 1,
      rootKey,
      issuer: installation.role,
      notAfter: parsed.notAfter,
    });
  } catch {
    return true;
  } // Legacy, malformed, corrupt or partial evidence is never age-pruned by this adapter.
}
export function assertFreshControlRoot(
  installation: ControlInstallation,
  key: string,
  requestedDeadlineAt: number | undefined,
): void {
  const state = installationState(installation),
    parsed = parseControlRootOperationKey(key);
  if (requestedDeadlineAt !== parsed.notAfter || parsed.notAfter - Date.now() > 7 * 24 * 3600_000)
    throw Error(
      "Upgrade prerequisite: a persisted timed control root and exact deadline are required",
    );
  assertOriginClockForward(state, {
    version: 1,
    rootKey: key,
    issuer: installation.role,
    notAfter: parsed.notAfter,
  });
}
export function controlInstallationDataRoot(installation: ControlInstallation): string {
  return installationState(installation).dataRoot;
}
export function controlRegisteredServiceIds(installation: ControlInstallation): string[] {
  return [...installationState(installation).registeredTargets].sort();
}
export function controlRolePublicKey(
  installation: ControlInstallation,
  role: ControlIssuer,
): string {
  return installationState(installation).publicKeys[role];
}
function writeExecutionShared(
  state: InstallationState,
  execution: ExecutionRef,
  dir: AnchoredDirectory,
  name: string,
  bytes: string,
  exclusive = false,
  origin = retainedExecutionOrigin(state, execution),
) {
  if (origin)
    familyRecordWrite(
      state,
      origin,
      { scope: "shared", namespace: "execution", container: execution.executor, name },
      bytes,
      (beforePublish) => dir.write(name, bytes, exclusive, beforePublish),
      exclusive,
    );
  else dir.write(name, bytes, exclusive);
}
export function readPrivateRecord(
  state: InstallationState,
  namespace: string,
  name: string,
  max = 131072,
): unknown {
  const dir = state.privateRoot.directory(namespace);
  try {
    return JSON.parse(dir.read(name, max).toString("utf8"));
  } finally {
    dir.close();
  }
}
/** Fixed adapters call after their own durable admission, passing the complete typed operation, never only its IDs. */
export function retainAdmittedControlExecution(
  installation: ControlInstallation,
  input: {
    execution: ExecutionRef;
    kind: string;
    operation: unknown;
    admittedAt: number;
    requestedDeadlineAt?: number;
    parent?: RetainedParentExecution;
    serviceIds: readonly string[];
    plan?: readonly ControlPlannedChild[];
    reservations?: readonly ControlChildReservation[];
    coordinatorPullBaseline?: CoordinatorPullBaseline;
  },
): VerifiedExecutionAuthority {
  const state = installationState(installation);
  const execution = Object.freeze(executionRefSchema.parse(input.execution));
  const serviceIds = targetSchema.parse(input.serviceIds);
  if (
    (execution.executor !== installation.role &&
      !(state.fixedChildId && execution.executor === "host-cli")) ||
    serviceIds.some((id) => !state.registeredTargets.has(id))
  )
    throw Error("Unregistered execution role/targets");
  const parsed = opsOperationSchema.safeParse(input.operation);
  if (parsed.success) {
    if (
      parsed.data.kind !== input.kind ||
      opsOperationFingerprint(parsed.data) !== execution.operationFingerprint
    )
      throw Error("Admitted operation body mismatch");
  } else if (
    ![
      "transit-sync",
      "download-osm",
      "download-fonts",
      "convert-overpass",
      "overture-sync",
      "overture-pull",
      "overture-ingest",
      "overture-extract",
      "overture-conflate",
      "search-index-build",
      "notable-places-build",
      "catalog.activate",
      "catalog.validate",
      "catalog-pins.initialize",
      LOCAL_CREDENTIAL_TEMPLATE_KIND,
      "artifactTransfer.import",
      "artifactTransfer.export",
      "artifactTransfer.validate",
      "transit-maintenance",
      "generation-hardlinks",
      "configuration-maintenance.prepare",
      "configuration-maintenance.settle",
      "configurationMaintenance.prepare",
      "configurationHandoff.prepare",
      "configuration-helper",
    ].includes(input.kind) ||
    controlDigest(input.operation) !== execution.operationFingerprint
  )
    throw Error("Unsupported fixed control operation");
  if (
    !Number.isSafeInteger(input.admittedAt) ||
    execution.deadlineAt <= input.admittedAt ||
    execution.fingerprint !==
      executionFingerprint({
        kind: input.kind,
        operationFingerprint: execution.operationFingerprint,
        deadlineAt: execution.deadlineAt,
        ...(input.parent ? { parent: input.parent } : {}),
      })
  )
    throw Error("Immutable execution identity mismatch");
  const coordinatorPull =
    parsed.success && parsed.data.kind === "service.pull" && parsed.data.candidateId
      ? parsed.data
      : undefined;
  if (coordinatorPull || input.coordinatorPullBaseline) {
    const baseline = coordinatorPullBaselineSchema.parse(input.coordinatorPullBaseline);
    if (
      !coordinatorPull ||
      coordinatorPull.serviceId !== "data-manager" ||
      installation.role !== "ops-agent" ||
      state.fixedChildId ||
      input.parent?.issuer !== "api" ||
      input.parent.apiJobId === undefined ||
      baseline.candidateId !== coordinatorPull.candidateId ||
      baseline.configurationRevisionId !== coordinatorPull.expectedConfigurationRevisionId
    )
      throw Error("Original coordinator pull baseline required");
  }
  const plan = z
    .array(plannedChildSchema)
    .max(64)
    .parse(input.plan ?? []);
  const reservations = z
    .array(controlChildReservationSchema)
    .max(64)
    .parse(input.reservations ?? []);
  validateControlChildReservations({
    role: state.fixedChildId ? "fixed-cli" : installation.role,
    kind: input.kind,
    execution,
    serviceIds,
    plan,
    reservations,
  });
  if (
    input.kind === "catalog-pins.initialize" &&
    (state.fixedChildId ||
      input.parent ||
      plan.length ||
      reservations.length ||
      serviceIds.length !== 1 ||
      serviceIds[0] !== "motis" ||
      !["ops-agent", "host-cli"].includes(installation.role) ||
      controlDigest(input.operation) !== controlDigest({ kind: "catalog-pins.initialize" }))
  )
    throw Error("Fixed local catalog bootstrap only");
  if (input.kind === LOCAL_CREDENTIAL_TEMPLATE_KIND) {
    localCredentialTemplateOperationSchema.parse(input.operation);
    if (
      state.fixedChildId ||
      input.parent ||
      plan.length ||
      reservations.length ||
      installation.role !== "host-cli" ||
      execution.principal !== "host-cli" ||
      serviceIds.length !== 1 ||
      serviceIds[0] !== "motis"
    )
      throw Error("Fixed local host credential template only");
  }
  const budget = (() => {
    try {
      return opsExecutionMaximumMs(input.kind);
    } catch {
      if (
        [
          "configurationMaintenance.prepare",
          "configurationHandoff.prepare",
          "configuration-helper",
        ].includes(input.kind)
      )
        return 3600000;
      if (input.kind === "catalog-pins.initialize") return 60000;
      if (input.kind === LOCAL_CREDENTIAL_TEMPLATE_KIND) return 300000;
      if (
        ["configuration-maintenance.prepare", "configuration-maintenance.settle"].includes(
          input.kind,
        )
      )
        return 60000;
      throw Error("Unknown control kind budget");
    }
  })();
  if (execution.deadlineAt > input.admittedAt + budget)
    throw Error("Control execution exceeds kind budget");
  if (plan.length + reservations.length > 64) throw Error("Control child intent capacity");
  const keys = new Set<string>();
  for (const child of plan) {
    executionRefSchema.parse(child.execution);
    targetSchema.parse(child.serviceIds);
    if (
      !Number.isSafeInteger(child.ordinal) ||
      keys.has(child.execution.operationKey) ||
      child.execution.operationKey !==
        controlChildOperationKey(execution.operationKey, child.phase, child.ordinal) ||
      !childPhaseKinds[child.phase]?.includes(child.kind) ||
      child.execution.deadlineAt > execution.deadlineAt ||
      child.serviceIds.some((id) => !serviceIds.includes(id))
    )
      throw Error("Invalid fixed child plan");
    keys.add(child.execution.operationKey);
  }
  if (Object.hasOwn(input, "origin"))
    throw Error("Caller-supplied origin is not verified authority");
  const existingName = `${execution.operationKey}.json`;
  let existing: unknown;
  try {
    existing = readPrivateRecord(state, "executions", existingName, 65536);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  if (existing) {
    const stored = verifyControl(
      installation.publicKey,
      originRecordDomain("openmapx-control-execution", existing),
      existing,
      z
        .object({
          version: z.union([z.literal(1), z.literal(2)]),
          installationId: uuid,
          origin: controlOriginSchema.optional(),
        })
        .passthrough(),
    );
    if (!validateOriginRecord(stored)) throw Error("Legacy origin cannot be invented");
    const {
      version: _version,
      installationId: _installationId,
      origin: _origin,
      ...oldInput
    } = stored;
    if (
      controlDigest({ ...oldInput, reservations: oldInput.reservations ?? [] }) !==
      controlDigest({ ...input, execution, serviceIds, plan, reservations })
    )
      throw Error("Conflicting retained execution identity");
    return restoreAdmittedControlExecution(installation, execution);
  }
  let origin: ControlExecutionOrigin;
  const inherited = input.parent && verifiedParentOrigins.get(input.parent);
  if (inherited) {
    if (!input.parent || !verifiedParents.has(input.parent))
      throw Error("Unverified parent origin");
    origin = controlOriginSchema.parse(inherited);
  } else {
    if (input.parent && (input.parent.issuer !== "api" || !verifiedParents.has(input.parent)))
      throw Error("Missing signed inherited origin; legacy parent is observation-only");
    const parsed = parseControlRootOperationKey(execution.operationKey);
    const now = Date.now();
    if (parsed.notAfter <= now) throw Error("Expired control root expiry");
    if (parsed.notAfter - now > 7 * 24 * 3600_000 || input.requestedDeadlineAt !== parsed.notAfter)
      throw Error("Control root requested deadline must equal its expiry within seven days");
    origin = {
      version: 1,
      rootKey: execution.operationKey,
      issuer: execution.executor,
      notAfter: parsed.notAfter,
    };
  }
  if (execution.deadlineAt > origin.notAfter)
    throw Error("Control execution widens origin deadline");
  assertOriginClockForward(state, origin);
  const receipt = signControl(state.privateKey, "openmapx-control-execution-v2", {
    version: 2,
    installationId: installation.installationId,
    ...input,
    execution,
    serviceIds,
    plan,
    origin,
  });
  if (Buffer.byteLength(canonicalJson(receipt)) > 65536)
    throw Error("Execution authority receipt capacity");
  registerFamilyExecution(
    state,
    origin,
    execution,
    controlDigest(receipt),
    input.parent,
    !!input.coordinatorPullBaseline,
  );
  const name = `${execution.operationKey}.json`;
  let newlyAdmitted = false;
  try {
    const old = readPrivateRecord(state, "executions", name, 65536);
    if (controlDigest(old) !== controlDigest(receipt))
      throw Error("Conflicting retained execution identity");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    writePrivateRecord(state, "executions", name, receipt, true, origin);
    writePrivateRecord(state, "effects", name, null, true, origin);
    writePrivateRecord(state, "effect-started", name, null, true, origin);
    newlyAdmitted = true;
  }
  const authority = Object.freeze({ execution }) as VerifiedExecutionAuthority;
  authorities.set(authority, {
    installation: state,
    execution,
    kind: input.kind,
    serviceIds,
    plan,
    reservations,
    receiptDigest: controlDigest(receipt),
    origin,
  });
  if (newlyAdmitted) initializeControlChildReservations(authority);
  publishControlExecutionWitness(
    state,
    { execution, kind: input.kind, serviceIds, origin },
    controlDigest(receipt),
  );
  initializeLifecycle(state, execution, newlyAdmitted);
  return authority;
}
export interface PeerState {
  installation: InstallationState;
  role: ControlIssuer;
  local?: boolean;
  recipient: ControlRecipient;
  execution: ExecutionRef;
  kind: string;
  assertion: string;
  childPrivateKey: KeyObject;
  childPublicKey: string;
}
const peers = new WeakMap<object, PeerState>();
export function controlPeerState(peer: VerifiedControlPeer) {
  const s = peers.get(peer);
  if (!s) throw Error("Unverified control peer");
  return s;
}
export const assertionSchema = z.strictObject({
  version: z.literal(1),
  installationId: uuid,
  leaseId: uuid,
  ownerCertificateDigest: digest,
  delegationId: uuid,
  grantDigest: digest,
  ancestorDelegationIds: z.array(uuid).max(2),
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
});
export function parseControlAssertion(assertion: string) {
  if (Buffer.byteLength(assertion) > 4096 || !/^[A-Za-z0-9_-]+$/.test(assertion))
    throw Error("Invalid control assertion encoding/limit");
  const bytes = Buffer.from(assertion, "base64url");
  if (bytes.toString("base64url") !== assertion) throw Error("Invalid control assertion encoding");
  const parsed = assertionSchema.parse(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
  );
  if (Buffer.from(canonicalJson(parsed)).toString("base64url") !== assertion)
    throw Error("Noncanonical control assertion");
  return parsed;
}
export function controlHeaders(rawHeaders: readonly string[]): {
  delegation?: string;
  parent?: string;
} {
  const found = new Map<string, string>();
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = rawHeaders[i]?.toLowerCase();
    if (!["x-openmapx-control-delegation", "x-openmapx-parent-execution"].includes(name)) continue;
    if (found.has(name) || typeof rawHeaders[i + 1] !== "string")
      throw Error("Duplicate control header");
    const value = rawHeaders[i + 1];
    if (value === undefined) throw Error("Missing control header value");
    found.set(name, value);
  }
  const delegation = found.get("x-openmapx-control-delegation"),
    parent = found.get("x-openmapx-parent-execution");
  if (
    (delegation?.length ?? 0) + (parent?.length ?? 0) > 8192 ||
    (delegation?.length ?? 0) > 4096 ||
    (parent?.length ?? 0) > 4096
  )
    throw Error("Control header limit");
  return { delegation, parent };
}
/** Transport authentication is required by the fixed caller. Signature authentication finishes during anchored adoption. */
export function verifyControlPeer(
  installation: ControlInstallation,
  input: {
    rawHeaders: readonly string[];
    transportPrincipal: "data-manager" | "host-cli" | "shared-data-manager-bearer";
    execution: ExecutionRef;
    kind: string;
  },
): VerifiedControlPeer {
  const state = installationState(installation);
  const headers = controlHeaders(input.rawHeaders);
  const assertionText = headers.delegation ?? headers.parent;
  if (!assertionText) throw Error("Missing control assertion");
  const assertion = headers.delegation
    ? parseControlAssertion(assertionText)
    : parseParentAssertion(assertionText);
  if (assertion.installationId !== installation.installationId)
    throw Error("Foreign control installation");
  if (installation.role === "ops-agent" && input.transportPrincipal !== "data-manager")
    throw Error("Wrong peer transport principal");
  if (installation.role === "host-cli") throw Error("Host CLI is not an HTTP receiver");
  if (installation.role === "data-manager" && input.transportPrincipal === "data-manager")
    throw Error("Wrong peer transport principal");
  const peer = Object.freeze({}) as VerifiedControlPeer;
  peers.set(peer, {
    installation: state,
    role: installation.role === "ops-agent" ? "data-manager" : "ops-agent",
    recipient: installation.role,
    execution: executionRefSchema.parse(input.execution),
    kind: input.kind,
    assertion: assertionText,
    childPrivateKey: state.privateKey,
    childPublicKey: installation.publicKey,
  });
  return peer;
}
/** Same-agent maintenance continuations must match this role's private attempted intent. */
export function verifyRetainedLocalControlPeer(
  installation: ControlInstallation,
  input: { assertion: string; execution: ExecutionRef; kind: string },
): VerifiedControlPeer {
  const state = installationState(installation);
  const assertion = parseControlAssertion(input.assertion);
  if (installation.role !== "ops-agent" || state.fixedChildId)
    throw Error("Local agent continuation required");
  const saved = z
    .object({
      assertion: z.string(),
      grant: z.object({ payload: z.object({ child: executionRefSchema, childKind: z.string() }) }),
    })
    .parse(readPrivateRecord(state, "attempts", `${assertion.delegationId}.json`));
  if (
    saved.assertion !== input.assertion ||
    saved.grant.payload.childKind !== input.kind ||
    controlDigest(saved.grant.payload.child) !== controlDigest(input.execution)
  )
    throw Error("Local continuation intent mismatch");
  const peer = Object.freeze({}) as VerifiedControlPeer;
  peers.set(peer, {
    installation: state,
    role: "ops-agent",
    local: true,
    recipient: "ops-agent",
    execution: input.execution,
    kind: input.kind,
    assertion: input.assertion,
    childPrivateKey: state.privateKey,
    childPublicKey: installation.publicKey,
  });
  return peer;
}
export function prepareFixedControlChild(
  authority: VerifiedExecutionAuthority,
  delegationId: string,
): string {
  uuid.parse(delegationId);
  const s = executionAuthorityState(authority);
  if (s.installation.installation.role !== "ops-agent")
    throw Error("Only agent prepares fixed children");
  withExecutionWriter(s.installation, s.execution, (dir) => {
    const name = `${s.execution.operationKey}.keys.json`;
    let ids: string[] = [];
    try {
      ids = z
        .array(uuid)
        .max(64)
        .parse(JSON.parse(dir.read(name, 4096).toString("utf8")));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    if (
      ids.length >= Math.min(64, s.plan.length + s.reservations.length) ||
      ids.includes(delegationId)
    )
      throw Error("Fixed child key capacity/replay");
    writeExecutionShared(
      s.installation,
      s.execution,
      dir,
      name,
      canonicalJson([...ids, delegationId]),
    );
  });
  const key = newControlKey();
  writePrivateRecord(
    s.installation,
    "children",
    `${delegationId}.key`,
    { publicKey: key.publicKey, privateKey: encodePrivate(key.privateKey) },
    true,
    s.origin,
  );
  writePrivateRecord(
    s.installation,
    "child-keys",
    `${controlDigest(key.publicKey)}.json`,
    { delegationId, publicKey: key.publicKey, execution: s.execution },
    true,
    s.origin,
  );
  return key.publicKey;
}
export function fixedControlChildId(
  state: InstallationState,
  key: string,
  parent: ExecutionRef,
): string {
  const saved = z
    .strictObject({ delegationId: uuid, publicKey, execution: executionRefSchema })
    .parse(readPrivateRecord(state, "child-keys", `${controlDigest(key)}.json`, 2048));
  if (saved.publicKey !== key || controlDigest(saved.execution) !== controlDigest(parent))
    throw Error("Fixed child key index mismatch");
  const challenge = z
    .object({ publicKey })
    .parse(readPrivateRecord(state, "children", `${saved.delegationId}.key`, 2048));
  if (challenge.publicKey !== key) throw Error("Fixed child key challenge mismatch");
  return saved.delegationId;
}
export function verifyFixedCliControlPeer(
  installation: ControlInstallation,
  input: {
    assertion: string;
    execution: ExecutionRef;
    kind: string;
    recipient?: "fixed-cli" | "configuration-helper";
  },
): VerifiedControlPeer {
  const state = installationState(installation);
  const encoded = JSON.parse(Buffer.from(input.assertion, "base64url").toString("utf8")) as {
    leaseId?: unknown;
  };
  const assertion = encoded.leaseId
    ? parseControlAssertion(input.assertion)
    : parseParentAssertion(input.assertion);
  const fixedId = "delegationId" in assertion ? assertion.delegationId : assertion.attemptId;
  if (installation.role !== "ops-agent" || assertion.installationId !== installation.installationId)
    throw Error("Invalid fixed CLI installation");
  const saved = z
    .strictObject({ publicKey, privateKey: z.string().max(512) })
    .parse(readPrivateRecord(state, "children", `${fixedId}.key`, 2048));
  const key = parsePrivate(saved.privateKey);
  if (
    createPublicKey(key).export({ type: "spki", format: "der" }).toString("base64url") !==
    saved.publicKey
  )
    throw Error("Fixed child challenge mismatch");
  const peer = Object.freeze({}) as VerifiedControlPeer;
  peers.set(peer, {
    installation: state,
    role: "ops-agent",
    recipient: input.recipient ?? "fixed-cli",
    execution: executionRefSchema.parse(input.execution),
    kind: input.kind,
    assertion: input.assertion,
    childPrivateKey: key,
    childPublicKey: saved.publicKey,
  });
  return peer;
}
const settlements = new WeakMap<object, { state: InstallationState; evidence: ChildSettlement }>();
export function childSettlementState(evidence: VerifiedChildSettlement) {
  const result = settlements.get(evidence);
  if (!result) throw Error("Unverified child settlement");
  return result;
}
const settlementSchema = z.strictObject({
  identity: executionRefSchema,
  outcome: z.enum(["contained", "committed", "failed_without_effect", "unknown"]),
  publication: z.enum(["not_started", "committed", "unknown"]),
  terminalReceiptDigest: digest,
});
const effectObservationSchema = z.discriminatedUnion("kind", [
  localCredentialTemplateReceiptSchema,
  z.strictObject({ kind: z.literal("catalog-pins-initialized"), generationId: digest.nullable() }),
  z.strictObject({
    kind: z.literal("configuration-generation-not-committed"),
    revisionId: z.string().regex(/^cfg1_[A-Za-z0-9_-]{43}$/),
    expectedCurrentRevisionId: z.string().regex(/^cfg1_[A-Za-z0-9_-]{43}$/),
    result: z.strictObject({
      outcome: z.literal("not_committed"),
      reason: z.enum(["conflict", "busy", "failed"]),
      currentRevisionId: z
        .string()
        .regex(/^cfg1_[A-Za-z0-9_-]{43}$/)
        .nullable()
        .optional(),
      cleanupFailed: z.literal(false),
    }),
  }),
  z.strictObject({
    kind: z.literal("configuration-no-guard"),
    issuerFreezeProofDigest: digest,
    issuerUnusedConfirmationDigest: digest,
  }),
  z.strictObject({
    kind: z.literal("data-configuration-fence-refused"),
    maintenanceId: uuid,
    reason: z.enum(["busy", "capacity"]),
  }),
  z.strictObject({
    kind: z.literal("data-configuration-fence"),
    receipt: dataConfigurationFenceReceiptSchema,
    guardDigest: digest,
  }),
  z.strictObject({
    kind: z.literal("data-execution"),
    status: dataExecutionStatusSchema,
    workerId: uuid,
    childrenDigest: digest,
  }),
  z.strictObject({ kind: z.literal("data-command"), status: dataExecutionStatusSchema }),
  z.strictObject({ kind: z.literal("ops-result"), result: z.unknown() }),
  z.strictObject({ kind: z.literal("feed-proxy-validation-failure"), commitmentDigest: digest }),
  z.strictObject({ kind: z.literal("configuration-helper-completion"), completionDigest: digest }),
  z.strictObject({
    kind: z.literal("fixed-cli-exit"),
    args: z.array(z.string().max(256)).max(64),
    exitCode: z.literal(0),
  }),
  z.strictObject({ kind: z.literal("not-started") }),
  z.strictObject({ kind: z.literal("unresolved") }),
]);
/** Fixed writer producer only. A DTO, caller error or parsed result cannot
 * substitute for the actual completed native writer observation. */
export function retainConfigurationGenerationNonCommit(
  authority: VerifiedExecutionAuthority,
  observation: OriginalConfigurationGenerationNonCommit,
): void {
  const state = executionAuthorityState(authority),
    actual = originalConfigurationGenerationNonCommitSource(observation),
    admitted = readPrivateRecord(
      state.installation,
      "executions",
      `${state.execution.operationKey}.json`,
      65536,
    ) as { payload: { operation: unknown } },
    operation = opsOperationSchema.parse(admitted.payload.operation);
  if (
    state.installation.fixedChildId ||
    state.installation.installation.role !== "ops-agent" ||
    ![
      "stack.render",
      "serviceSelection.apply",
      "serviceConfig.apply",
      "integrationConfig.apply",
      "vault.apply",
    ].includes(state.kind) ||
    !("revisionId" in operation) ||
    !("expectedCurrentRevisionId" in operation) ||
    state.execution.operationKey !== actual.operationKey ||
    operation.revisionId !== actual.revisionId ||
    operation.expectedCurrentRevisionId !== actual.expectedCurrentRevisionId ||
    actual.installationId !== state.installation.installation.installationId ||
    controlDigest(admitted) !== state.receiptDigest
  )
    throw Error("Original writer/execution noncommit binding required");
  withPrivateEffectWriter(state, () => {
    const receipt = effectObservationSchema.parse({
        kind: "configuration-generation-not-committed",
        revisionId: actual.revisionId,
        expectedCurrentRevisionId: actual.expectedCurrentRevisionId,
        result: actual.result,
      }),
      payload = {
        identity: state.execution,
        outcome: "contained" as const,
        publication: "not_started" as const,
        terminalReceiptDigest: controlDigest(receipt),
        receipt,
      },
      name = `${state.execution.operationKey}.json`;
    const prior = readPrivateRecord(state.installation, "effects", name, 65536);
    if (prior !== null) {
      const retained = verifyControl(
        state.installation.installation.publicKey,
        "openmapx-control-settlement-v1",
        prior,
        settlementSchema.extend({ receipt: effectObservationSchema }),
      );
      if (canonicalJson(retained) !== canonicalJson(payload))
        throw Error("Original writer noncommit source changed");
      return;
    }
    settleExecutionLifecycle(state);
    writePrivateRecord(
      state.installation,
      "effects",
      name,
      signControl(state.installation.privateKey, "openmapx-control-settlement-v1", payload),
      false,
      state.origin,
    );
    if (state.origin)
      markFamilyTerminal(
        state.installation,
        state.origin,
        state.execution,
        true,
        controlDigest(payload),
      );
  });
}
/** Actual private source, not a caller outcome flag. */
export function inspectConfigurationGenerationNonCommit(
  installation: ControlInstallation,
  execution: ExecutionRef,
) {
  const local = installationState(installation),
    authority = restoreAdmittedControlExecution(installation, execution),
    state = executionAuthorityState(authority),
    raw = readPrivateRecord(local, "effects", `${execution.operationKey}.json`, 65536),
    effect = verifyControl(
      installation.publicKey,
      "openmapx-control-settlement-v1",
      raw,
      settlementSchema.extend({ receipt: effectObservationSchema }),
    );
  if (
    effect.receipt.kind !== "configuration-generation-not-committed" ||
    effect.outcome !== "contained" ||
    effect.publication !== "not_started" ||
    !state.origin ||
    canonicalJson(effect.identity) !== canonicalJson(execution) ||
    effect.terminalReceiptDigest !== controlDigest(effect.receipt)
  )
    throw Error("Actual original generation noncommit required");
  verifyFamilyOwnedRecord(
    local,
    state.origin,
    {
      scope: "private",
      namespace: "effects",
      container: "",
      name: `${execution.operationKey}.json`,
    },
    canonicalJson(raw),
  );
  return effect.receipt;
}
export function withPrivateEffectWriter<T>(s: AuthorityState, write: () => T): T {
  const guards = s.installation.privateRoot.directory("effect-writers", true, true);
  try {
    const name = s.execution.operationKey;
    mkdirSync(guards.name(name), { mode: 0o700 });
    fsyncSync(guards.fd);
    const guard = guards.directory(name);
    const held = identity(guard.stat);
    try {
      return write();
    } finally {
      guard.close();
      guards.removeDirectory(name, held);
    }
  } finally {
    guards.close();
  }
}
export function beginControlEffect(authority: VerifiedExecutionAuthority): void {
  const s = executionAuthorityState(authority);
  withControlExecutionForward(authority, () =>
    withPrivateEffectWriter(s, () => {
      try {
        if (
          readPrivateRecord(s.installation, "effects", `${s.execution.operationKey}.json`) !== null
        )
          throw Error("Settled execution cannot restart effects");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      const name = `${s.execution.operationKey}.json`;
      if (readPrivateRecord(s.installation, "effect-started", name) !== null)
        throw Error("Execution effects already started");
      writePrivateRecord(
        s.installation,
        "effect-started",
        name,
        { execution: s.execution, receiptDigest: s.receiptDigest },
        false,
        s.origin,
      );
    }),
  );
}
function configurationPreEffectState(authority: VerifiedExecutionAuthority) {
  const state = executionAuthorityState(authority),
    raw = readPrivateRecord(
      state.installation,
      "executions",
      `${state.execution.operationKey}.json`,
      65536,
    ),
    operation = opsOperationSchema.parse(
      (raw as { payload: { operation: unknown } }).payload.operation,
    );
  if (
    !state.origin ||
    state.installation.fixedChildId ||
    state.installation.installation.role !== "ops-agent" ||
    controlDigest(raw) !== state.receiptDigest ||
    opsOperationFingerprint(operation) !== state.execution.operationFingerprint ||
    !(
      operation.kind === "service.update" ||
      operation.kind === "service.image.stage" ||
      operation.kind === "backup.prune" ||
      operation.kind === "coreService.restart" ||
      operation.kind === "stack.start" ||
      (operation.kind === "service.start" && operation.serviceId !== "data-manager") ||
      (operation.kind === "service.pull" &&
        operation.serviceId === "data-manager" &&
        operation.candidateId)
    )
  )
    throw Error("Fixed managed configuration pre-effect source required");
  verifyFamilyOwnedRecord(
    state.installation,
    state.origin,
    {
      scope: "private",
      namespace: "executions",
      container: "",
      name: `${state.execution.operationKey}.json`,
    },
    canonicalJson(raw),
  );
  return state;
}
/** Existing not-started evidence, only after the original lifecycle is frozen
 * and every exact/reserved child remains unissued and unbound. */
export function retainConfigurationPreEffectRefusal(authority: VerifiedExecutionAuthority): void {
  const state = configurationPreEffectState(authority);
  if (
    cancelControlExecution(authority).length ||
    state.reservations.some((slot) => {
      const retained = inspectControlChildPublication(authority, slot);
      return retained.binding !== null || retained.publication.state !== "unissued";
    })
  )
    throw Error("Issued or bound managed configuration must remain fenced");
  retainControlEffectReceipt(authority, {
    outcome: "failed_without_effect",
    publication: "not_started",
    receipt: { kind: "not-started" },
  });
}
/** The transition/restart observer consumes the actual indexed signed effect;
 * an error class or caller status never qualifies nonissuance. */
export function inspectConfigurationPreEffectRefusal(authority: VerifiedExecutionAuthority): void {
  const state = configurationPreEffectState(authority),
    name = `${state.execution.operationKey}.json`,
    raw = readPrivateRecord(state.installation, "effects", name, 65536),
    effect = verifyControl(
      state.installation.installation.publicKey,
      "openmapx-control-settlement-v1",
      raw,
      settlementSchema.extend({ receipt: effectObservationSchema }),
    );
  if (
    !state.origin ||
    effect.receipt.kind !== "not-started" ||
    effect.outcome !== "failed_without_effect" ||
    effect.publication !== "not_started" ||
    controlDigest(effect.identity) !== controlDigest(state.execution) ||
    effect.terminalReceiptDigest !== controlDigest(effect.receipt)
  )
    throw Error("Actual unstarted managed configuration receipt required");
  verifyFamilyOwnedRecord(
    state.installation,
    state.origin,
    { scope: "private", namespace: "effects", container: "", name },
    canonicalJson(raw),
  );
  if (
    cancelControlExecution(authority).length ||
    state.reservations.some((slot) => {
      const retained = inspectControlChildPublication(authority, slot);
      return retained.binding !== null || retained.publication.state !== "unissued";
    })
  )
    throw Error("Unstarted managed configuration child source changed");
}
/** Recover only the exact failure ALREADY fixed by the original signed
 * terminal commitment. The interrupted journal is a locator, never authority;
 * neither a new error/time nor an uncommitted failure can pass this comparison. */
export function restoreConfigurationPreEffectTerminal(
  installation: ControlInstallation,
  execution: ExecutionRef,
  observed: OpsJobStatus,
): { status: OpsJobStatus; terminalAt: number } {
  const authority = restoreAdmittedControlExecution(installation, execution);
  inspectConfigurationPreEffectRefusal(authority);
  const state = configurationPreEffectState(authority),
    proof = readTerminalCommitment(state),
    proofName = terminalCommitmentName(state.execution),
    rawProof = readPrivateRecord(state.installation, "observations", proofName, 4096);
  if (
    !state.origin ||
    controlDigest((rawProof as { payload: unknown }).payload) !== controlDigest(proof)
  )
    throw Error("Original pre-effect terminal changed");
  verifyFamilyOwnedRecord(
    state.installation,
    state.origin,
    { scope: "private", namespace: "observations", container: "", name: proofName },
    canonicalJson(rawProof),
  );
  const rawAdmission = readPrivateRecord(
    state.installation,
    "executions",
    `${execution.operationKey}.json`,
    65536,
  );
  if (controlDigest(rawAdmission) !== state.receiptDigest)
    throw Error("Original pre-effect admission changed");
  const admitted = z
    .object({ admittedAt: z.number().int().nonnegative().safe(), operation: opsOperationSchema })
    .passthrough()
    .parse((rawAdmission as { payload: unknown }).payload);
  if ("revisionId" in admitted.operation || proof.terminalAt < admitted.admittedAt)
    throw Error("Immutable original pre-effect tuple required");
  // Startup may have added an expiry cancellation projection. Only the
  // original signed whole-tuple digest decides whether it was present.
  for (const terminationRequestedAt of new Set([undefined, observed.terminationRequestedAt])) {
    const status = parseOpsJobStatus({
      version: 2,
      admittedAt: admitted.admittedAt,
      deadlineAt: execution.deadlineAt,
      fingerprint: execution.fingerprint,
      operationId: execution.executionId,
      operationKey: execution.operationKey,
      kind: admitted.operation.kind,
      resourceId: opsResourceId(admitted.operation),
      state: "failed",
      submittedAt: new Date(admitted.admittedAt).toISOString(),
      updatedAt: new Date(proof.terminalAt).toISOString(),
      errorClass:
        admitted.operation.kind === "service.pull" ? "busy" : "configuration_prerequisite",
      failureResult: {},
      ...(terminationRequestedAt === undefined ? {} : { terminationRequestedAt }),
    });
    if (controlTerminalReceiptDigest(status) === proof.terminalDigest) {
      terminalIdentity(state, status);
      return { status, terminalAt: proof.terminalAt };
    }
  }
  throw Error("Original pre-effect terminal unavailable");
}
/** Fixed executor adapters supply their parsed result or exact fixed-command exit; arbitrary text is never proof. */
/** Original indexed progress is business evidence only. A success producer must
 * additionally prove its actual children/target tree before committing. */
function readDataWorkflowProgress(authority: VerifiedExecutionAuthority) {
  const s = executionAuthorityState(authority);
  if (s.kind !== "data.update" || !s.origin) throw Error("Original Full Update owner required");
  const name = `data-workflow-${s.execution.operationKey}.json`,
    raw = readPrivateRecord(s.installation, "observations", name, 65536);
  verifyFamilyOwnedRecord(
    s.installation,
    s.origin,
    { scope: "private", namespace: "observations", container: "", name },
    canonicalJson(raw),
  );
  const body = verifyControl(
    s.installation.installation.publicKey,
    "openmapx-admin-data-workflow-v1",
    raw,
    z.strictObject({
      version: z.literal(1),
      operationKey: z.string(),
      fingerprint: z.string(),
      receipt: dataWorkflowReceiptSchema,
    }),
  );
  if (
    body.operationKey !== s.execution.operationKey ||
    body.fingerprint !== s.execution.fingerprint
  )
    throw Error("Full Update checkpoint identity changed");
  return body.receipt;
}
export function retainControlEffectReceipt(
  authority: VerifiedExecutionAuthority,
  effect: {
    outcome: ChildSettlement["outcome"];
    publication: ChildSettlement["publication"];
    receipt: unknown;
  },
): void {
  const s = executionAuthorityState(authority);
  withPrivateEffectWriter(s, () => {
    const parsed = effectObservationSchema.safeParse(effect.receipt);
    if (!parsed.success) throw Error("Unsupported effect receipt evidence");
    const receipt = parsed.data;
    let outcome: ChildSettlement["outcome"] = "unknown",
      publication: ChildSettlement["publication"] = "unknown",
      helperCompletedAt: number | undefined;
    if (receipt.kind === "catalog-pins-initialized") {
      if (
        s.kind !== "catalog-pins.initialize" ||
        s.installation.fixedChildId ||
        !s.origin ||
        !["ops-agent", "host-cli"].includes(s.installation.installation.role)
      )
        throw Error("Original local catalog initialization required");
      const source = verifyControl(
        s.installation.installation.publicKey,
        "openmapx-catalog-pin-initialization-v1",
        readPrivateRecord(
          s.installation,
          "catalog-commits",
          `initialization-${s.execution.operationKey}.json`,
          65536,
        ),
        z.strictObject({
          version: z.literal(1),
          execution: executionRefSchema,
          generationId: digest.nullable(),
          pointerDigest: digest.nullable(),
        }),
      );
      if (
        controlDigest(source.execution) !== controlDigest(s.execution) ||
        source.generationId !== receipt.generationId
      )
        throw Error("Catalog initialization source mismatch");
      outcome = "committed";
      publication = "committed";
    } else if (receipt.kind === "feed-credential-template-written") {
      if (
        s.kind !== LOCAL_CREDENTIAL_TEMPLATE_KIND ||
        !s.origin ||
        s.installation.fixedChildId ||
        s.installation.installation.role !== "host-cli"
      )
        throw Error("Original local credential template required");
      const name = `${s.execution.operationKey}.json`,
        started = readPrivateRecord(s.installation, "effect-started", name);
      if (
        !started ||
        controlDigest((started as { execution: unknown }).execution) !==
          controlDigest(s.execution) ||
        (started as { receiptDigest: unknown }).receiptDigest !== s.receiptDigest
      )
        throw Error("Original started credential template required");
      verifyFamilyOwnedRecord(
        s.installation,
        s.origin,
        { scope: "private", namespace: "effect-started", container: "", name },
        canonicalJson(started),
      );
      const admitted = readPrivateRecord(s.installation, "executions", name, 65536) as {
        payload: { operation: unknown };
      };
      verifyFamilyOwnedRecord(
        s.installation,
        s.origin,
        { scope: "private", namespace: "executions", container: "", name },
        canonicalJson(admitted),
      );
      const operation = localCredentialTemplateOperationSchema.parse(admitted.payload.operation);
      if (
        receipt.fileMac !== operation.fileMac ||
        localCredentialTemplateFileMac(s.installation, operation) !== operation.fileMac
      )
        throw Error("Credential template file evidence changed");
      outcome = "committed";
      publication = "committed";
    } else if (receipt.kind === "ops-result") {
      receipt.result = parseBoundedOpsResult(s.kind as OpsOperationKind, receipt.result);
      if (s.kind === "data.update") {
        const actual = readDataWorkflowProgress(authority),
          result = receipt.result as { dataWorkflow?: unknown };
        if (
          actual.phase !== "complete" ||
          actual.children.length !== 3 ||
          actual.children.some((c) => c.status !== "succeeded") ||
          actual.failedBuildIds.length ||
          actual.skippedBuildIds.length ||
          !actual.revisionId ||
          canonicalJson(actual) !== canonicalJson(result.dataWorkflow)
        )
          throw Error("Actual completed Full Update workflow required");
        verifyDataUpdateCompletionSource(authority, actual);
      }
      const result = receipt.result as { outcome?: string };
      if (
        !result.outcome ||
        ["applied", "unchanged", "committed"].includes(result.outcome) ||
        (s.kind === "transitousLock.approve" && result.outcome === "activated") ||
        // These closed results settle their own awaited filesystem leaf. A
        // published install still holds its component lock until API bookkeeping
        // selects the separate commit/restore operation.
        (s.kind === "integration.install" && result.outcome === "published") ||
        (s.kind === "integration.remove" && result.outcome === "removed") ||
        (s.kind === "integration.settle" && result.outcome === "restored")
      ) {
        outcome = "committed";
        publication = "committed";
      }
    } else if (receipt.kind === "feed-proxy-validation-failure") {
      if (
        s.kind !== "feedProxy.validateAndReload" ||
        inspectFeedProxyValidationFailure(authority, receipt.commitmentDigest) === null
      )
        throw Error("Original contained validation failure required");
      outcome = "contained";
      publication = "not_started";
    } else if (receipt.kind === "data-command") {
      const slots = s.reservations.filter(
        (slot) => slot.recipient === "data-manager" && slot.phase === "data-step",
      );
      if (slots.length !== 1) throw Error("Exact single data command required");
      const bound = lookupControlChildPhase(authority, slots[0]!);
      if (
        !bound ||
        bound.execution.executionId !== receipt.status.id ||
        bound.execution.fingerprint !== receipt.status.fingerprint
      )
        throw Error("Bound data command identity required");
      verifyDeadlineEdge(s.kind, "data-step", "data-manager", receipt.status.kind);
      verifyDataControlTerminalWitness(
        s.installation.installation,
        bound.execution,
        receipt.status,
      );
      if (receipt.status.status === "ok") {
        outcome = "committed";
        publication = "committed";
      }
    } else if (receipt.kind === "configuration-helper-completion") {
      if (s.kind !== "configuration-helper" || !s.installation.fixedChildId || !s.origin)
        throw Error("Original fixed configuration helper required");
      const admitted = readPrivateRecord(
          s.installation,
          "executions",
          `${s.execution.operationKey}.json`,
          65536,
        ) as { payload: { operation: unknown } },
        body = z
          .strictObject({
            kind: z.literal("configuration-helper"),
            handoffId: uuid,
            intentDigest: digest,
          })
          .parse(admitted.payload.operation),
        intent = readConfigurationHandoffSpawnIntent(
          s.installation.installation,
          s.execution,
          body.handoffId,
        ),
        progressName = configurationHandoffRecordName(body.handoffId, "progress"),
        progressRaw = readPrivateRecord(s.installation, "observations", progressName),
        progress = verifyControl(
          s.installation.publicKeys["ops-agent"],
          configurationHandoffRecordDomains.progress,
          progressRaw,
          configurationHandoffProgressSchema,
        ),
        completionName = configurationHandoffRecordName(body.handoffId, "completion"),
        completionRaw = readPrivateRecord(s.installation, "observations", completionName),
        completion = verifyControl(
          s.installation.installation.publicKey,
          configurationHandoffRecordDomains.completion,
          completionRaw,
          configurationHandoffWorkerRecordSchema,
        ),
        spawnName = `${s.installation.fixedChildId}.json`,
        spawn = readPrivateRecord(s.installation, "spawn-started", spawnName) as {
          execution: unknown;
        },
        startedName = `${s.execution.operationKey}.json`,
        started = readPrivateRecord(s.installation, "effect-started", startedName) as {
          execution: unknown;
          receiptDigest: unknown;
        };
      for (const [namespace, name, value] of [
        ["executions", startedName, admitted],
        ["observations", progressName, progressRaw],
        ["observations", completionName, completionRaw],
        ["spawn-started", spawnName, spawn],
        ["effect-started", startedName, started],
      ] as const)
        verifyFamilyOwnedRecord(
          s.installation,
          s.origin,
          { scope: "private", namespace, container: "", name },
          canonicalJson(value),
        );
      if (
        body.intentDigest !== controlDigest(intent.operation) ||
        controlDigest(spawn.execution) !== controlDigest(s.execution) ||
        controlDigest(started.execution) !== controlDigest(s.execution) ||
        started.receiptDigest !== s.receiptDigest ||
        progress.intentDigest !== controlDigest(intent) ||
        progress.phase !== "launched" ||
        progress.launch.state !== "confirmed" ||
        completion.intentDigest !== controlDigest(intent) ||
        completion.preparationDigest !== controlDigest(progress) ||
        controlDigest(completion.execution) !== controlDigest(s.execution) ||
        completion.phase !== "applied" ||
        completion.completedAt === null ||
        completion.launch.containerId !== progress.launch.containerId ||
        receipt.completionDigest !== controlDigest(completion) ||
        completion.targets.length !== intent.operation.serviceIds.length ||
        completion.targets.some(
          (target) =>
            !intent.operation.serviceIds.includes(target.serviceId) ||
            target.expectedImageId !== intent.operation.expectedImageIdentities[target.serviceId] ||
            target.oldContainerId !==
              progress.targets.find((original) => original.serviceId === target.serviceId)
                ?.oldContainerId,
        )
      )
        throw Error("Actual original helper completion required");
      helperCompletedAt = completion.completedAt;
      outcome = "committed";
      publication = "committed";
    } else if (receipt.kind === "fixed-cli-exit") {
      if (!s.installation.fixedChildId)
        throw Error("Fixed command receipt requires certified child");
      readFixedCliSpawnIntent(s.installation.installation, s.execution, receipt.args);
      readPrivateRecord(s.installation, "spawn-started", `${s.installation.fixedChildId}.json`);
      for (const slot of s.reservations.filter(
        (item) =>
          item.recipient === "data-manager" &&
          ["data-step", "osm", "transit", "fonts"].includes(item.phase),
      )) {
        const binding = lookupControlChildPhase(authority, slot);
        if (
          !binding ||
          verifyDataControlTerminalWitness(s.installation.installation, binding.execution).status
            .status !== "ok"
        )
          throw Error("Actual backend data containment required before fixed command success");
      }
      if (s.kind === "data.update") {
        for (const slot of s.reservations.filter((value) => value.phase === "hardlinks")) {
          const bound = lookupControlChildPhase(authority, slot);
          if (
            !bound ||
            verifyDataControlTerminalWitness(s.installation.installation, bound.execution).status
              .status !== "ok"
          )
            throw Error("Actual Full Update hardlink containment required");
        }
        const workflow = readDataWorkflowProgress(authority),
          spawn = readFixedCliSpawnIntent(s.installation.installation, s.execution, receipt.args);
        const expected =
          spawn.dataUpdatePlan?.dataReservation.execution.operationKey === s.execution.operationKey
            ? "build"
            : "complete";
        if (workflow.phase !== expected) throw Error("Original Full Update checkpoint required");
      }
      outcome = "committed";
      publication = "committed";
    } else if (receipt.kind === "configuration-no-guard") {
      if (
        s.kind !== "configurationMaintenance.prepare" ||
        s.installation.fixedChildId ||
        !s.origin ||
        s.installation.installation.role !== "ops-agent"
      )
        throw Error("Original frozen maintenance effect source required");
      const admitted = readPrivateRecord(
          s.installation,
          "executions",
          `${s.execution.operationKey}.json`,
          65536,
        ) as { payload?: { operation?: { maintenanceId?: string } } },
        name = `${uuid.parse(admitted.payload?.operation?.maintenanceId)}.json`,
        raw = readPrivateRecord(s.installation, "configuration-maintenance", name),
        owner = verifyControl(
          s.installation.installation.publicKey,
          "openmapx-configuration-maintenance-owner-v2",
          raw,
          z
            .object({
              admissionDigest: digest,
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
        );
      verifyFamilyOwnedRecord(
        s.installation,
        s.origin,
        { scope: "private", namespace: "configuration-maintenance", name, container: "" },
        canonicalJson(raw),
      );
      const confirmation = owner.noGuard.issuerUnused.confirmation;
      if (
        owner.admissionDigest !== s.receiptDigest ||
        !confirmation ||
        receipt.issuerFreezeProofDigest !== owner.noGuard.noGuardEvidence.issuerFreezeProofDigest ||
        receipt.issuerUnusedConfirmationDigest !==
          settlementRecordDigest(
            configurationSettlementDomains.unusedConfirmation,
            confirmation.payload,
          )
      )
        throw Error("Actual frozen issuer UNUSED confirmation required");
      verifyControl(
        s.installation.installation.publicKey,
        configurationSettlementDomains.unusedConfirmation,
        confirmation,
        configurationNoGuardIntentSchema.shape.issuerUnused.shape.confirmation.unwrap().shape
          .payload,
      );
      outcome = "failed_without_effect";
      publication = "not_started";
    } else if (receipt.kind === "not-started") {
      try {
        if (
          readPrivateRecord(
            s.installation,
            "effect-started",
            `${s.execution.operationKey}.json`,
          ) !== null
        )
          throw Error("Started effects require containment evidence");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      if (s.installation.fixedChildId) throw Error("Fixed child cannot assert unused execution");
      outcome = "failed_without_effect";
      publication = "not_started";
    }
    if (effect.outcome !== outcome || effect.publication !== publication)
      throw Error("Effect evidence does not prove requested settlement");
    settleExecutionLifecycle(s);
    const payload = {
      identity: s.execution,
      outcome,
      publication,
      terminalReceiptDigest: controlDigest(receipt),
      receipt,
    };
    const signed = signControl(
      s.installation.privateKey,
      "openmapx-control-settlement-v1",
      payload,
    );
    const name = `${s.execution.operationKey}.json`;
    try {
      const raw = readPrivateRecord(s.installation, "effects", name, 65536);
      if (raw === null) {
        writePrivateRecord(s.installation, "effects", name, signed, false, s.origin);
        if (s.origin)
          markFamilyTerminal(
            s.installation,
            s.origin,
            s.execution,
            outcome !== "unknown",
            controlDigest(payload),
            helperCompletedAt,
          );
        return;
      }
      const prior = verifyControl(
        s.installation.installation.publicKey,
        "openmapx-control-settlement-v1",
        raw,
        settlementSchema.extend({ receipt: effectObservationSchema }),
      );
      if (controlDigest(prior) === controlDigest(payload)) {
        // A completed helper may have lost the write acknowledgement after
        // the signed effect landed but before its family terminal fact. Repair
        // only this exact source using its original signed completion time.
        if (s.origin && helperCompletedAt !== undefined)
          markFamilyTerminal(
            s.installation,
            s.origin,
            s.execution,
            true,
            controlDigest(payload),
            helperCompletedAt,
          );
        return;
      }
      // A later transport/journal failure must never erase proved committed effects.
      if (prior.outcome !== "unknown") return;
      writePrivateRecord(s.installation, "effects", name, signed, false, s.origin);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      writePrivateRecord(s.installation, "effects", name, signed, true, s.origin);
    }
    if (s.origin)
      markFamilyTerminal(
        s.installation,
        s.origin,
        s.execution,
        outcome !== "unknown",
        controlDigest(payload),
        helperCompletedAt,
      );
  });
}
export function verifyControlEffectSettlement(
  installation: ControlInstallation,
  execution: ExecutionRef,
): VerifiedChildSettlement {
  const s = installationState(installation);
  const evidence = verifyControl(
    installation.publicKey,
    "openmapx-control-settlement-v1",
    readPrivateRecord(s, "effects", `${execution.operationKey}.json`, 65536),
    settlementSchema.extend({ receipt: effectObservationSchema }),
  );
  if (evidence.terminalReceiptDigest !== controlDigest(evidence.receipt))
    throw Error("Effect receipt digest mismatch");
  if (controlDigest(evidence.identity) !== controlDigest(execution))
    throw Error("Settlement immutable identity mismatch");
  const verified = Object.freeze({}) as VerifiedChildSettlement;
  const { receipt: _privateReceipt, ...publicEvidence } = evidence;
  settlements.set(verified, { state: s, evidence: publicEvidence });
  return verified;
}
/** Fixed read-only source check for maintenance's pre-root ordinary DM Start.
 * It reads this role's actual original admission, canonical terminal, effect
 * result and released target tree. Candidate metadata alone proves nothing. */
export function verifyMaintenanceCoordinatorPrerequisite(
  installation: ControlInstallation,
  record: PreparedConfigurationRecord,
) {
  const local = installationState(installation),
    fixed = record.coordinatorPrerequisite;
  if (
    installation.role !== "ops-agent" ||
    local.fixedChildId ||
    !record.maintenanceId ||
    !fixed ||
    fixed.operation.kind !== "service.start" ||
    fixed.operation.serviceId !== "data-manager" ||
    fixed.root.operationKey === record.prepareOperationKey ||
    fixed.root.parent.operationKey !== record.parentOperationKey ||
    fixed.root.parent.fingerprint !== record.parentFingerprint ||
    fixed.root.parent.deadlineAt !== record.parentDeadlineAt
  )
    throw Error("Original maintenance coordinator prerequisite required");
  const raw = readPrivateRecord(local, "executions", `${fixed.root.operationKey}.json`, 65536);
  const admitted = verifyControl(
    installation.publicKey,
    originRecordDomain("openmapx-control-execution", raw),
    raw,
    z
      .object({
        execution: executionRefSchema,
        kind: z.literal("service.start"),
        operation: opsOperationSchema,
        admittedAt: z.number().int().nonnegative().safe(),
        requestedDeadlineAt: z.number().int().nonnegative().safe(),
        parent: retainedParentExecutionSchema.refine((parent) => parent.issuer === "api"),
      })
      .passthrough(),
  );
  if (
    admitted.execution.operationKey !== fixed.root.operationKey ||
    admitted.requestedDeadlineAt !== fixed.root.requestedDeadlineAt ||
    admitted.execution.deadlineAt > admitted.requestedDeadlineAt ||
    admitted.execution.deadlineAt <= admitted.admittedAt ||
    admitted.execution.operationFingerprint !== opsOperationFingerprint(fixed.operation) ||
    admitted.execution.fingerprint !==
      executionFingerprint({
        kind: "service.start",
        operationFingerprint: opsOperationFingerprint(fixed.operation),
        deadlineAt: admitted.execution.deadlineAt,
        parent: admitted.parent,
      }) ||
    canonicalJson(admitted.operation) !== canonicalJson(fixed.operation) ||
    admitted.parent.apiJobId !== record.apiJobId ||
    admitted.parent.operationKey !== record.parentOperationKey ||
    admitted.parent.fingerprint !== record.parentFingerprint ||
    admitted.parent.deadlineAt !== record.parentDeadlineAt
  )
    throw Error("Original coordinator admission changed");
  const authority = restoreAdmittedControlExecution(installation, admitted.execution),
    owner = executionAuthorityState(authority),
    canonical = readTerminalCommitment(owner),
    settled = verifyControlEffectSettlement(installation, admitted.execution),
    effect = verifyControl(
      installation.publicKey,
      "openmapx-control-settlement-v1",
      readPrivateRecord(local, "effects", `${fixed.root.operationKey}.json`, 65536),
      settlementSchema.extend({ receipt: effectObservationSchema }),
    );
  if (
    !owner.origin ||
    canonical.phase !== "canonical" ||
    effect.outcome !== "committed" ||
    effect.publication !== "committed" ||
    effect.receipt.kind !== "ops-result" ||
    (parseBoundedOpsResult("service.start", effect.receipt.result) as { changed: boolean })
      .changed !== true
  )
    throw Error("Conclusive successful coordinator prerequisite required");
  assertFamilyCanonicalCompatibility(
    local,
    owner.origin,
    admitted.execution,
    canonical.terminalDigest,
    canonical.terminalAt,
  );
  verifyRetainedArtifactTargetRootRelease(authority);
  return Object.freeze({
    execution: Object.freeze(admitted.execution),
    terminalDigest: canonical.terminalDigest,
    terminalAt: canonical.terminalAt,
    effectSettlementDigest: controlDigest(childSettlementState(settled).evidence),
  });
}

declare const stagedCoordinatorBrand: unique symbol;
export type VerifiedStagedCoordinatorOwnership = Readonly<{ [stagedCoordinatorBrand]: true }>;
const stagedCoordinatorProofs = new WeakMap<
  VerifiedStagedCoordinatorOwnership,
  {
    installation: ControlInstallation;
    origin: ControlExecutionOrigin;
    source: z.infer<typeof stagedCoordinatorSourceSchema>;
    status: OpsJobStatus;
  }
>();
export function verifiedStagedCoordinatorOwnershipState(proof: VerifiedStagedCoordinatorOwnership) {
  const value = stagedCoordinatorProofs.get(proof);
  if (!value) throw Error("Actual staged coordinator ownership required");
  return {
    installationId: value.installation.installationId,
    origin: structuredClone(value.origin),
    source: structuredClone(value.source),
  };
}
/** Journal tuples locate source bytes only. This verifies the actual first
 * signed admission, immutable canonical/effect settlement and role-signed API
 * copy without requiring or renewing an expired API candidate or its grants. */
export function readVerifiedStagedCoordinatorOwnership(
  installation: ControlInstallation,
  execution: ExecutionRef,
  input: OpsJobStatus,
  context?: ControlRetentionPreparationContext,
): VerifiedStagedCoordinatorOwnership {
  const local = installationState(installation);
  if (installation.role !== "ops-agent" || local.fixedChildId)
    throw Error("Production ops-agent staged source required");
  const raw = readPrivateRecord(local, "executions", `${execution.operationKey}.json`, 65536),
    admitted = verifyControl(
      installation.publicKey,
      originRecordDomain("openmapx-control-execution", raw),
      raw,
      z
        .object({
          version: z.literal(2),
          installationId: uuid,
          origin: controlOriginSchema,
          kind: z.literal("service.pull"),
          execution: executionRefSchema,
          operation: opsOperationSchema,
          admittedAt: z.number().int().nonnegative().safe(),
          requestedDeadlineAt: z.number().int().nonnegative().safe(),
          parent: retainedParentExecutionSchema,
          coordinatorPullBaseline: coordinatorPullBaselineSchema,
        })
        .passthrough(),
    ),
    baseline = admitted.coordinatorPullBaseline,
    operation = admitted.operation,
    parent = admitted.parent;
  if (
    admitted.installationId !== installation.installationId ||
    canonicalJson(admitted.execution) !== canonicalJson(execution) ||
    execution.executor !== "ops-agent" ||
    execution.principal !== "api" ||
    operation.kind !== "service.pull" ||
    operation.serviceId !== "data-manager" ||
    !operation.candidateId ||
    operation.candidateId !== baseline.candidateId ||
    operation.expectedConfigurationRevisionId !== baseline.configurationRevisionId ||
    execution.operationFingerprint !== opsOperationFingerprint(operation) ||
    parent.issuer !== "api" ||
    execution.deadlineAt > admitted.requestedDeadlineAt ||
    execution.deadlineAt <= admitted.admittedAt ||
    execution.fingerprint !==
      executionFingerprint({
        kind: "service.pull",
        operationFingerprint: execution.operationFingerprint,
        deadlineAt: execution.deadlineAt,
        parent,
      })
  )
    throw Error("Original staged coordinator admission changed");
  const authority = restoreAdmittedControlExecution(installation, execution),
    state = executionAuthorityState(authority),
    canonical = readTerminalCommitment(state),
    terminal = terminalIdentity(state, input),
    settlement = verifyControlEffectSettlement(installation, execution),
    effectRecord = readPrivateRecord(local, "effects", `${execution.operationKey}.json`, 65536),
    effect = verifyControl(
      installation.publicKey,
      "openmapx-control-settlement-v1",
      effectRecord,
      settlementSchema.extend({ receipt: effectObservationSchema }),
    );
  if (
    !state.origin ||
    canonicalJson(state.origin) !== canonicalJson(admitted.origin) ||
    canonical.phase !== "canonical" ||
    terminal.terminal.state !== "succeeded" ||
    canonical.terminalDigest !== terminal.digest ||
    effect.outcome !== "committed" ||
    effect.publication !== "committed" ||
    effect.receipt.kind !== "ops-result" ||
    canonicalJson(terminal.terminal.result) !== canonicalJson(effect.receipt.result)
  )
    throw Error("Actual successful contained staged coordinator source required");
  const result = servicePullResultSchema.parse(effect.receipt.result);
  if (
    result.revisionId !== baseline.configurationRevisionId ||
    result.imageReference !== baseline.configImageReference
  )
    throw Error("Original staged coordinator result changed");
  const canonicalRecord = readPrivateRecord(
    local,
    "observations",
    terminalCommitmentName(execution),
    4096,
  );
  for (const record of [
    { namespace: "executions", name: `${execution.operationKey}.json`, raw },
    { namespace: "effects", name: `${execution.operationKey}.json`, raw: effectRecord },
    { namespace: "observations", name: terminalCommitmentName(execution), raw: canonicalRecord },
  ])
    verifyFamilyOwnedRecord(
      local,
      state.origin,
      { scope: "private", namespace: record.namespace, container: "", name: record.name },
      canonicalJson(record.raw),
    );
  assertFamilyCanonicalCompatibility(
    local,
    state.origin,
    execution,
    canonical.terminalDigest,
    canonical.terminalAt,
  );
  const copy = readActiveStagedCoordinatorApiCopy(
      local,
      state.origin,
      execution,
      canonical.terminalDigest,
      parent,
      context,
    ),
    source = stagedCoordinatorSourceSchema.parse({
      execution,
      admittedAt: admitted.admittedAt,
      baseline,
      admissionDigest: controlDigest(raw),
      canonicalDigest: canonical.terminalDigest,
      effectDigest: controlDigest(childSettlementState(settlement).evidence),
      apiCopyDigest: copy.apiCopyDigest,
    }),
    proof = Object.freeze({}) as VerifiedStagedCoordinatorOwnership;
  stagedCoordinatorProofs.set(proof, {
    installation,
    origin: state.origin,
    source: structuredClone(source),
    status: structuredClone(input),
  });
  return proof;
}
declare const stagedOwnerBaselineBrand: unique symbol;
export type VerifiedStagedCoordinatorOwnerBaseline = Readonly<{ [stagedOwnerBaselineBrand]: true }>;
const stagedOwnerBaselines = new WeakMap<
  VerifiedStagedCoordinatorOwnerBaseline,
  {
    baseline: CoordinatorPullBaseline;
    expectedCurrentRevisionId: string;
    currentAuthorityRevision: string;
  }
>();
export function verifiedStagedCoordinatorOwnerBaselineState(
  proof: VerifiedStagedCoordinatorOwnerBaseline,
) {
  const value = stagedOwnerBaselines.get(proof);
  if (!value) throw Error("Actual staged original-owner provenance required");
  return structuredClone(value);
}
/** A separately bound historical observation, never this owner's pull or a
 * caller-selected current generation. All postcommit exceptions verify the
 * original actual canonical/effect/physical child under the same decision. */
export function ownedStagedCoordinatorBaseline(
  authority: VerifiedExecutionAuthority,
): VerifiedStagedCoordinatorOwnerBaseline {
  const state = executionAuthorityState(authority);
  if (
    state.kind !== "configurationMaintenance.prepare" ||
    !state.origin ||
    state.installation.fixedChildId ||
    state.installation.installation.role !== "ops-agent"
  )
    throw Error("Original staged maintenance owner required");
  const admitted = readPrivateRecord(
    state.installation,
    "executions",
    `${state.execution.operationKey}.json`,
    65536,
  ) as { payload?: { operation?: { maintenanceId?: string } } };
  const name = `${uuid.parse(admitted.payload?.operation?.maintenanceId)}.json`,
    raw = readPrivateRecord(state.installation, "configuration-maintenance", name);
  const owner = verifyControl(
    state.installation.installation.publicKey,
    "openmapx-configuration-maintenance-owner-v2",
    raw,
    configurationMaintenanceOwnerRecordSchema,
  );
  verifyFamilyOwnedRecord(
    state.installation,
    state.origin,
    { scope: "private", namespace: "configuration-maintenance", container: "", name },
    canonicalJson(raw),
  );
  const observation = verifyControl(
      state.installation.installation.publicKey,
      stagedCoordinatorObservationDomain,
      owner.stagedCoordinatorProvenance,
      stagedCoordinatorObservationPayloadSchema,
    ),
    baseline = observation.source.baseline;
  if (
    owner.coordinatorPull ||
    owner.plan.coordinatorImage?.action !== "apply" ||
    observation.installationId !== state.installation.installation.installationId ||
    owner.admissionDigest !== state.receiptDigest ||
    controlDigest(admitted) !== state.receiptDigest ||
    canonicalJson(owner.plan.prepare) !== canonicalJson(state.execution) ||
    canonicalJson(owner.origin) !== canonicalJson(state.origin) ||
    canonicalJson(observation.ownerPrepare) !== canonicalJson(state.execution) ||
    observation.candidateId !== owner.plan.operation.candidateId ||
    observation.planDigest !== owner.plan.planDigest ||
    baseline.configurationRevisionId !== owner.plan.operation.expectedCurrentRevisionId ||
    canonicalJson(owner.originalContainers.find((c) => c.serviceId === "data-manager")) !==
      canonicalJson(baseline.container)
  )
    throw Error("Original staged owner/source binding changed");
  let expectedCurrentRevisionId = baseline.configurationRevisionId;
  if (owner.receipt.generation === "committed") {
    const generation = owner.apiControls.steps.find((value) => value.ordinal === 0);
    if (
      !generation?.canonical ||
      !generation.receiptDelivery ||
      owner.receipt.appliedRevisionId !== owner.plan.operation.revisionId
    )
      throw Error("Original staged owner generation required");
    const child = verifyConfigurationMaintenanceChildTerminal(
        authority,
        0,
        generation.canonical.status,
        generation.canonical.terminalAt,
      ),
      verified = configurationMaintenanceChildState(child, authority),
      lease = restoreArtifactTargetLeaseForSettlement(authority);
    try {
      const physical = inspectArtifactTargetLeaseChildSettlement(lease, generation.execution);
      if (!physical || canonicalJson(physical) !== canonicalJson(verified.settlement))
        throw Error("Actual staged generation settlement required");
    } finally {
      closeArtifactTargetLeaseHandle(lease);
    }
    expectedCurrentRevisionId = owner.plan.operation.revisionId;
  } else if (
    owner.receipt.generation !== "not_started" &&
    owner.receipt.generation !== "not_committed"
  )
    throw Error("Unknown staged owner generation");
  const proof = Object.freeze({}) as VerifiedStagedCoordinatorOwnerBaseline;
  stagedOwnerBaselines.set(proof, {
    baseline: structuredClone(baseline),
    expectedCurrentRevisionId,
    currentAuthorityRevision: owner.plan.sourceAuthorityRevision,
  });
  return proof;
}
declare const coordinatorBaselineBrand: unique symbol;
export type VerifiedCoordinatorPullBaseline = Readonly<{ [coordinatorBaselineBrand]: true }>;
const baselineProofs = new WeakMap<
  VerifiedCoordinatorPullBaseline,
  Readonly<
    z.infer<typeof coordinatorPullWitnessPayloadSchema> & { expectedCurrentRevisionId: string }
  >
>();
const observedBaselineProofs = new WeakMap<object, VerifiedCoordinatorPullBaseline>();
export function verifiedCoordinatorPullBaselineState(proof: VerifiedCoordinatorPullBaseline) {
  const value = baselineProofs.get(proof);
  if (!value) throw Error("Verified original coordinator baseline required");
  // Return a copy so a consumer cannot mutate the authenticated private observation.
  return structuredClone(value);
}
export function observedCoordinatorPullBaseline(witness: object): VerifiedCoordinatorPullBaseline {
  const proof = observedBaselineProofs.get(witness);
  if (!proof) throw Error("Actual original pull observation required");
  return proof;
}
/** Recovery derives only from the exact indexed signed owner, after the initial
 * successful source copy. It does not depend on a retired normal pull family. */
export function ownedCoordinatorPullBaseline(
  authority: VerifiedExecutionAuthority,
): VerifiedCoordinatorPullBaseline {
  const state = executionAuthorityState(authority);
  if (
    state.kind !== "configurationMaintenance.prepare" ||
    state.installation.fixedChildId ||
    state.installation.installation.role !== "ops-agent" ||
    !state.origin
  )
    throw Error("Original maintenance owner required");
  const admitted = readPrivateRecord(
    state.installation,
    "executions",
    `${state.execution.operationKey}.json`,
    65536,
  ) as { payload?: { operation?: { maintenanceId?: string } } };
  const name = `${uuid.parse(admitted.payload?.operation?.maintenanceId)}.json`,
    raw = readPrivateRecord(state.installation, "configuration-maintenance", name);
  const owner = verifyControl(
    state.installation.installation.publicKey,
    "openmapx-configuration-maintenance-owner-v2",
    raw,
    configurationMaintenanceOwnerRecordSchema,
  );
  verifyFamilyOwnedRecord(
    state.installation,
    state.origin,
    { scope: "private", namespace: "configuration-maintenance", container: "", name },
    canonicalJson(raw),
  );
  const witness = verifyControl(
    state.installation.installation.publicKey,
    coordinatorPullObservationDomain,
    owner.coordinatorPull,
    coordinatorPullWitnessPayloadSchema,
  );
  if (
    owner.admissionDigest !== state.receiptDigest ||
    controlDigest(admitted) !== state.receiptDigest ||
    canonicalJson(owner.plan.prepare) !== canonicalJson(state.execution) ||
    canonicalJson(owner.origin) !== canonicalJson(state.origin) ||
    canonicalJson(witness.maintenancePrepare) !== canonicalJson(state.execution) ||
    witness.installationId !== state.installation.installation.installationId ||
    witness.candidateId !== owner.plan.operation.candidateId ||
    witness.maintenanceId !== owner.plan.operation.maintenanceId ||
    witness.baseline.candidateId !== witness.candidateId ||
    witness.baseline.sourceRevision !== witness.sourceRevision ||
    witness.baseline.configurationAuthorityRevision !== owner.plan.sourceAuthorityRevision ||
    witness.baseline.submissionDigest !== witness.submissionDigest ||
    canonicalJson(owner.originalContainers.find((c) => c.serviceId === "data-manager")) !==
      canonicalJson(witness.baseline.container) ||
    owner.plan.coordinatorImage?.imageId !== witness.imageId
  )
    throw Error("Original coordinator owner source changed");
  const proof = Object.freeze({}) as VerifiedCoordinatorPullBaseline;
  baselineProofs.set(
    proof,
    Object.freeze({
      ...structuredClone(witness),
      expectedCurrentRevisionId:
        owner.receipt.generation === "committed"
          ? owner.plan.operation.revisionId
          : witness.baseline.configurationRevisionId,
    }),
  );
  return proof;
}
/** Fixed source of this one pre-sealed normal pull. Its real signed admission
 * owns the assigned execution ID and effective deadline; neither is predicted. */
export function verifyCoordinatorPullAdmissionSource(
  installation: ControlInstallation,
  record: PreparedConfigurationRecord,
) {
  const state = installationState(installation),
    fixed = record.privateCoordinatorLifecycle;
  if (
    installation.role !== "ops-agent" ||
    state.fixedChildId ||
    fixed?.action !== "update" ||
    record.apiFollowUp !== "coordinator-update" ||
    !record.maintenanceId ||
    fixed.pull.operation.candidateId !== record.candidateId
  )
    throw Error("Original coordinator pull source required");
  const submission = fixed.pull,
    raw = readPrivateRecord(state, "executions", `${submission.operationKey}.json`, 65536),
    admitted = verifyControl(
      installation.publicKey,
      originRecordDomain("openmapx-control-execution", raw),
      raw,
      z
        .object({
          version: z.literal(2),
          installationId: uuid,
          origin: controlOriginSchema,
          kind: z.literal("service.pull"),
          execution: executionRefSchema,
          operation: opsOperationSchema,
          admittedAt: z.number().int().nonnegative().safe(),
          requestedDeadlineAt: z.number().int().nonnegative().safe(),
          parent: retainedParentExecutionSchema,
          coordinatorPullBaseline: coordinatorPullBaselineSchema,
        })
        .passthrough(),
    ),
    parent = admitted.parent,
    attempt = submission.attempt,
    execution = admitted.execution;
  if (
    admitted.installationId !== installation.installationId ||
    admitted.coordinatorPullBaseline.candidateId !== record.candidateId ||
    admitted.coordinatorPullBaseline.sourceRevision !== record.expectedSourceRevision ||
    admitted.coordinatorPullBaseline.configurationRevisionId !==
      submission.operation.expectedConfigurationRevisionId ||
    admitted.coordinatorPullBaseline.submissionDigest !==
      coordinatorPullSubmissionDigest(submission) ||
    parent.issuer !== "api" ||
    execution.executor !== "ops-agent" ||
    execution.principal !== "api" ||
    execution.operationKey !== submission.operationKey ||
    execution.operationFingerprint !== submission.operationFingerprint ||
    canonicalJson(admitted.operation) !== canonicalJson(submission.operation) ||
    admitted.requestedDeadlineAt !== submission.requestedDeadlineAt ||
    execution.deadlineAt > admitted.requestedDeadlineAt ||
    execution.deadlineAt <= admitted.admittedAt ||
    execution.fingerprint !==
      executionFingerprint({
        kind: "service.pull",
        operationFingerprint: submission.operationFingerprint,
        deadlineAt: execution.deadlineAt,
        parent,
      }) ||
    parent.apiJobId !== record.apiJobId ||
    parent.apiJobId !== attempt.apiJobId ||
    parent.apiOwnerVersion !== attempt.apiOwnerVersion ||
    parent.attemptId !== attempt.attemptId ||
    parent.operationKey !== record.parentOperationKey ||
    parent.operationKey !== attempt.parentOperationKey ||
    parent.fingerprint !== record.parentFingerprint ||
    parent.fingerprint !== attempt.parentFingerprint ||
    parent.deadlineAt !== record.parentDeadlineAt ||
    parent.deadlineAt !== attempt.parentDeadlineAt
  )
    throw Error("Original coordinator normal admission changed");
  restoreAdmittedControlExecution(installation, execution);
  return admitted;
}

/** Only a real immutable canonical terminal + contained effect can mint this
 * copied observation. The structural public status alone supplies no proof. */
export function observeCoordinatorPullForMaintenance(
  installation: ControlInstallation,
  record: PreparedConfigurationRecord,
  maintenancePrepare: ExecutionRef,
  status: OpsJobStatus,
) {
  const admitted = verifyCoordinatorPullAdmissionSource(installation, record),
    authority = restoreAdmittedControlExecution(installation, admitted.execution),
    state = executionAuthorityState(authority),
    canonical = readTerminalCommitment(state),
    terminal = terminalIdentity(state, status),
    settlement = verifyControlEffectSettlement(installation, admitted.execution),
    effect = verifyControl(
      installation.publicKey,
      "openmapx-control-settlement-v1",
      readPrivateRecord(
        state.installation,
        "effects",
        `${admitted.execution.operationKey}.json`,
        65536,
      ),
      settlementSchema.extend({ receipt: effectObservationSchema }),
    );
  if (
    !state.origin ||
    canonical.phase !== "canonical" ||
    terminal.terminal.state !== "succeeded" ||
    canonical.terminalDigest !== terminal.digest ||
    effect.outcome !== "committed" ||
    effect.publication !== "committed" ||
    effect.receipt.kind !== "ops-result" ||
    canonicalJson(terminal.terminal.result) !== canonicalJson(effect.receipt.result)
  )
    throw Error("Actual successful contained coordinator pull required");
  assertFamilyCanonicalCompatibility(
    state.installation,
    state.origin,
    admitted.execution,
    canonical.terminalDigest,
    canonical.terminalAt,
  );
  const { changed: _changed, ...result } = servicePullResultSchema.parse(effect.receipt.result),
    fixed = record.privateCoordinatorLifecycle!;
  if (
    fixed.action !== "update" ||
    result.revisionId !== fixed.pull.operation.expectedConfigurationRevisionId
  )
    throw Error("Original coordinator pull revision changed");
  const witness = coordinatorPullWitnessSchema.parse(
    signControl(
      state.installation.privateKey,
      coordinatorPullObservationDomain,
      coordinatorPullWitnessPayloadSchema.parse({
        version: 2,
        installationId: installation.installationId,
        maintenanceId: record.maintenanceId,
        candidateId: record.candidateId,
        maintenancePrepare,
        pull: admitted.execution,
        submissionDigest: coordinatorPullSubmissionDigest(fixed.pull),
        operationFingerprint: admitted.execution.operationFingerprint,
        apiParentDigest: controlDigest(admitted.parent),
        sourceRevision: record.expectedSourceRevision,
        ...result,
        terminalReceiptDigest: terminal.digest,
        effectReceiptDigest: controlDigest(childSettlementState(settlement).evidence),
        baseline: admitted.coordinatorPullBaseline,
        baselineAdmissionDigest: controlDigest(
          readPrivateRecord(
            state.installation,
            "executions",
            `${admitted.execution.operationKey}.json`,
            65536,
          ),
        ),
        verifiedAt: Date.now(),
      }),
    ),
  );
  const proof = Object.freeze({}) as VerifiedCoordinatorPullBaseline;
  baselineProofs.set(
    proof,
    Object.freeze({
      ...structuredClone(witness.payload),
      expectedCurrentRevisionId: admitted.coordinatorPullBaseline.configurationRevisionId,
    }),
  );
  observedBaselineProofs.set(witness, proof);
  return witness;
}
/** Copies actual retained source packets into the original indexed family.
 * The initial empty projection is allocated before the DM guard. No caller
 * supplies a decision, generation result, signature or authority digest. */
export function publishConfigurationMaintenanceForwardWitness(
  authority: VerifiedExecutionAuthority,
): void {
  const root = executionAuthorityState(authority);
  if (
    root.kind !== "configurationMaintenance.prepare" ||
    !root.origin ||
    root.installation.installation.role !== "ops-agent" ||
    root.installation.fixedChildId
  )
    throw Error("Original maintenance forward publisher required");
  const raw = readPrivateRecord(
      root.installation,
      "executions",
      `${root.execution.operationKey}.json`,
      65536,
    ) as { payload?: { operation?: { maintenanceId?: string } } },
    name = `${uuid.parse(raw.payload?.operation?.maintenanceId)}.json`,
    ownerRaw = readPrivateRecord(root.installation, "configuration-maintenance", name),
    owner = verifyControl(
      root.installation.installation.publicKey,
      "openmapx-configuration-maintenance-owner-v2",
      ownerRaw,
      configurationMaintenanceOwnerRecordSchema,
    );
  verifyFamilyOwnedRecord(
    root.installation,
    root.origin,
    { scope: "private", namespace: "configuration-maintenance", container: "", name },
    canonicalJson(ownerRaw),
  );
  assertConfigurationMaintenanceDecisionSource(owner);
  if (
    owner.admissionDigest !== root.receiptDigest ||
    controlDigest(raw) !== root.receiptDigest ||
    canonicalJson(owner.plan.prepare) !== canonicalJson(root.execution) ||
    canonicalJson(owner.origin) !== canonicalJson(root.origin)
  )
    throw Error("Original maintenance forward source changed");
  const receipt = owner.receipt,
    graph = configurationMaintenanceForwardGraphSchema.parse({
      version: 1,
      binding: receipt.binding,
      prepare: receipt.prepare,
      apiJobId: receipt.apiJobId,
      parentOperationKey: receipt.parentOperationKey,
      parentFingerprint: receipt.parentFingerprint,
      parentDeadlineAt: receipt.parentDeadlineAt,
      planDigest: receipt.planDigest,
      ...(owner.plan.coordinatorImage ? { coordinatorImage: owner.plan.coordinatorImage } : {}),
      ...(owner.plan.handoff ? { handoff: owner.plan.handoff } : {}),
      ...(owner.plan.release ? { release: owner.plan.release } : {}),
      serviceIds: receipt.serviceIds,
      steps: receipt.steps,
    });
  const decision = owner.apiControls.decide?.receiptDelivery
    ? owner.apiControls.decide.commitment
    : null;
  if (decision)
    verifyControl(
      root.installation.installation.publicKey,
      configurationMaintenanceDecisionCommitmentDomain,
      decision,
      configurationMaintenanceDecisionCommitmentPayloadSchema,
    );
  const source = owner.apiControls.steps.find((value) => value.ordinal === 0);
  let generation = null;
  if (source?.canonical && source.receiptDelivery && decision) {
    verifyConfigurationMaintenanceChildTerminal(
      authority,
      0,
      source.canonical.status,
      source.canonical.terminalAt,
    );
    generation = {
      admission: readPrivateRecord(
        root.installation,
        "executions",
        `${source.execution.operationKey}.json`,
        65536,
      ),
      terminal: readPrivateRecord(
        root.installation,
        "observations",
        `terminal-${source.execution.operationKey}.json`,
        8192,
      ),
      effect: readPrivateRecord(
        root.installation,
        "effects",
        `${source.execution.operationKey}.json`,
        65536,
      ),
      status: source.canonical.status,
    };
  }
  const packet = signControl(
      root.installation.privateKey,
      configurationMaintenanceForwardDomain,
      configurationMaintenanceForwardSchema.parse({
        version: 1,
        graph,
        rootAdmission: raw,
        decision,
        generation,
      }),
    ),
    bytes = canonicalJson(packet);
  if (Buffer.byteLength(bytes) > 65536)
    throw Error("Configuration maintenance forward witness capacity");
  const directory = executionWitnessDirectory(root.installation, "ops-agent", true);
  try {
    writeExecutionShared(
      root.installation,
      root.execution,
      directory.role,
      `${root.execution.operationKey}.configuration-maintenance.json`,
      bytes,
    );
  } finally {
    directory.close();
  }
}
/** DM reads ONLY shared original signed packets and its pinned role keys.
 * This does not inspect the sibling agent's private directory. The actual
 * verified transport parent and anchored depth-two grant must match the
 * exact original root graph, continue decision and committed generation. */
export function verifyConfigurationMaintenanceGenerationWitness(
  installation: ControlInstallation,
  value: unknown,
  parent: import("../ops/execution-identity").VerifiedParentExecution,
  grant: ReturnType<typeof import("./target-lease").inspectArtifactDelegation>,
  expected: {
    maintenanceId: string;
    candidateId: string;
    ownerPrepare: ExecutionRef;
    revisionId: string;
    hardlinkPlanDigest: string;
    coordinatorMode: "ensure-running" | "require-running";
    serviceIds: readonly string[];
    rootCertificateDigest: string;
  },
) {
  const local = installationState(installation),
    request = startGenerationHardlinksExecutionSchema.parse(value);
  if (
    installation.role !== "data-manager" ||
    local.fixedChildId ||
    !verifiedParents.has(parent) ||
    parent.issuer !== "ops-agent" ||
    !parent.execution ||
    canonicalJson(parent.execution) !== canonicalJson(grant.parent) ||
    canonicalJson(grant.owner) !== canonicalJson(expected.ownerPrepare) ||
    grant.ownerCertificateDigest !== expected.rootCertificateDigest
  )
    throw Error("Actual original maintenance middle parent required");
  const directory = executionWitnessDirectory(local, "ops-agent");
  try {
    const packet = verifyControl(
        local.publicKeys["ops-agent"],
        configurationMaintenanceForwardDomain,
        JSON.parse(
          directory.role
            .read(`${expected.ownerPrepare.operationKey}.configuration-maintenance.json`, 65536)
            .toString("utf8"),
        ),
        configurationMaintenanceForwardSchema,
      ),
      graph = packet.graph;
    const admissionSchema = z
      .object({
        version: z.literal(2),
        installationId: uuid,
        origin: controlOriginSchema,
        execution: executionRefSchema,
        kind: z.string(),
        operation: opsOperationSchema,
        parent: retainedParentExecutionSchema,
        admittedAt: z.number().int().nonnegative().safe(),
        requestedDeadlineAt: z.number().int().positive().safe(),
        serviceIds: targetSchema,
        plan: z.array(z.unknown()),
        reservations: z.array(z.lazy(() => controlChildReservationSchema)).optional(),
      })
      .passthrough();
    const root = verifyControl(
        local.publicKeys["ops-agent"],
        "openmapx-control-execution-v2",
        packet.rootAdmission,
        admissionSchema,
      ),
      original = readControlExecutionWitness(
        local,
        expected.ownerPrepare,
        local.publicKeys["ops-agent"],
      ),
      operation = root.operation,
      first = graph.steps[0];
    if (
      !packet.decision ||
      !packet.generation ||
      operation.kind !== "configurationMaintenance.prepare" ||
      !first ||
      root.installationId !== installation.installationId ||
      root.kind !== operation.kind ||
      root.parent.issuer !== "api" ||
      original.authorityDigest !== controlDigest(packet.rootAdmission) ||
      canonicalJson(root.origin) !== canonicalJson(original.origin) ||
      canonicalJson(root.execution) !== canonicalJson(expected.ownerPrepare) ||
      canonicalJson(graph.prepare) !== canonicalJson(root.execution) ||
      opsOperationFingerprint(operation) !== root.execution.operationFingerprint ||
      root.execution.fingerprint !==
        executionFingerprint({
          kind: operation.kind,
          operationFingerprint: root.execution.operationFingerprint,
          deadlineAt: root.execution.deadlineAt,
          parent: root.parent,
        }) ||
      root.parent.apiJobId !== graph.apiJobId ||
      root.parent.operationKey !== graph.parentOperationKey ||
      root.parent.fingerprint !== graph.parentFingerprint ||
      root.parent.deadlineAt !== graph.parentDeadlineAt ||
      operation.maintenanceId !== expected.maintenanceId ||
      operation.candidateId !== expected.candidateId ||
      operation.revisionId !== expected.revisionId ||
      operation.coordinatorMode !== expected.coordinatorMode ||
      request.input.planDigest !== expected.hardlinkPlanDigest ||
      request.input.revisionId !== expected.revisionId ||
      request.input.coordinatorMode !== expected.coordinatorMode ||
      canonicalJson(root.serviceIds) !== canonicalJson(expected.serviceIds) ||
      canonicalJson(graph.serviceIds) !== canonicalJson(root.serviceIds)
    )
      throw Error("Original maintenance forward graph identity conflict");
    const { kind: _kind, ...binding } = operation;
    if (canonicalJson(binding) !== canonicalJson(graph.binding))
      throw Error("Original maintenance graph binding conflict");
    // Private candidate digests/source metadata are deliberately NOT shared.
    // These placeholders do not enter the graph digest or reservations.
    const rebuilt = buildFixedConfigurationMaintenancePlan({
      installationId: installation.installationId,
      prepare: root.execution,
      operation,
      apiParent: root.parent,
      apply: first.operation as Parameters<
        typeof buildFixedConfigurationMaintenancePlan
      >[0]["apply"],
      candidateRecordDigest: "0".repeat(64),
      sourceAuthorityRevision: "not-shared",
      previewDigest: "0".repeat(64),
      ...(graph.coordinatorImage ? { coordinatorImage: graph.coordinatorImage } : {}),
      ...(graph.release ? { release: graph.release } : {}),
      ...(graph.handoff ? { handoff: graph.handoff } : {}),
      hardlinkPlan: request.plan,
      serviceIds: root.serviceIds,
      recreateServiceIds: graph.steps.flatMap((step) =>
        step.operation.kind === "service.recreate" ||
        step.operation.kind === "service.recreateIsolated"
          ? [step.operation.serviceId]
          : [],
      ),
    });
    const middle = rebuilt.steps.find((step) => step.phase === "maintenance-hardlinks"),
      middleReservation = rebuilt.reservations.find(
        (step) => step.phase === "maintenance-hardlinks",
      );
    if (
      !middle ||
      !middleReservation ||
      !rebuilt.nestedHardlinks ||
      graph.planDigest !== rebuilt.planDigest ||
      canonicalJson(graph.steps) !== canonicalJson(rebuilt.steps) ||
      canonicalJson(root.reservations) !== canonicalJson(rebuilt.reservations) ||
      parent.execution.operationKey !== middle.operationKey ||
      parent.execution.operationFingerprint !== middle.operationFingerprint ||
      parent.execution.deadlineAt > root.execution.deadlineAt ||
      parent.fingerprint !== parent.execution.fingerprint ||
      parent.execution.fingerprint !==
        executionFingerprint({
          kind: middle.operation.kind,
          operationFingerprint: middle.operationFingerprint,
          deadlineAt: parent.execution.deadlineAt,
          parent: retainedControlParent(root.execution),
        }) ||
      grant.phase !== "hardlinks" ||
      grant.kind !== "generation-hardlinks" ||
      grant.recipient !== "data-manager" ||
      canonicalJson(grant.execution) !==
        canonicalJson({
          ...rebuilt.nestedHardlinks.execution,
          deadlineAt: grant.execution.deadlineAt,
          operationFingerprint: rebuilt.nestedHardlinks.operationFingerprint,
          fingerprint: grant.execution.fingerprint,
        }) ||
      grant.execution.operationKey !== request.operationKey ||
      grant.execution.operationFingerprint !== controlDigest(request.input) ||
      grant.execution.deadlineAt !== request.requestedDeadlineAt ||
      grant.execution.deadlineAt > parent.deadlineAt ||
      grant.execution.fingerprint !==
        executionFingerprint({
          kind: "generation-hardlinks",
          operationFingerprint: controlDigest(request.input),
          deadlineAt: grant.execution.deadlineAt,
          parent,
        }) ||
      canonicalJson(grant.serviceIds) !== canonicalJson(root.serviceIds)
    )
      throw Error("Original frozen middle/sole leaf conflict");
    const decision = verifyControl(
        local.publicKeys["ops-agent"],
        configurationMaintenanceDecisionCommitmentDomain,
        packet.decision,
        configurationMaintenanceDecisionCommitmentPayloadSchema,
      ),
      identity = decision.identity;
    if (
      identity.installationId !== installation.installationId ||
      canonicalJson(identity.origin) !== canonicalJson(root.origin) ||
      canonicalJson(identity.ownerPrepare) !== canonicalJson(root.execution) ||
      identity.admissionDigest !== controlDigest(packet.rootAdmission) ||
      identity.rootCertificateDigest !== expected.rootCertificateDigest ||
      identity.maintenanceId !== expected.maintenanceId ||
      identity.candidateId !== expected.candidateId ||
      identity.planDigest !== graph.planDigest ||
      identity.settlementId !== rebuilt.dmSettle.settlementId ||
      decision.operation.decision !== "continue" ||
      decision.operation.maintenanceId !== expected.maintenanceId ||
      decision.operation.candidateId !== expected.candidateId ||
      decision.operation.planDigest !== graph.planDigest ||
      decision.operation.prepareOperationKey !== root.execution.operationKey ||
      decision.operation.prepareFingerprint !== root.execution.operationFingerprint ||
      decision.apiParent.apiJobId !== graph.apiJobId ||
      decision.apiParent.operationKey !== graph.parentOperationKey ||
      decision.apiParent.fingerprint !== graph.parentFingerprint ||
      decision.apiParent.deadlineAt !== graph.parentDeadlineAt ||
      decision.execution.operationFingerprint !== opsOperationFingerprint(decision.operation) ||
      decision.execution.fingerprint !==
        executionFingerprint({
          kind: decision.operation.kind,
          operationFingerprint: decision.execution.operationFingerprint,
          deadlineAt: decision.execution.deadlineAt,
          parent: decision.apiParent,
        }) ||
      decision.acceptedAt >= decision.execution.deadlineAt ||
      decision.result.decision?.decision !== "continue" ||
      decision.result.decision.decisionId !== decision.operation.decisionId ||
      decision.result.state !== "authorized" ||
      decision.result.dmFence?.state !== "prepared"
    )
      throw Error("Actual original continue commitment required");
    const generation = packet.generation,
      admitted = verifyControl(
        local.publicKeys["ops-agent"],
        "openmapx-control-execution-v2",
        generation.admission,
        admissionSchema,
      ),
      childWitness = readControlExecutionWitness(
        local,
        admitted.execution,
        local.publicKeys["ops-agent"],
      ),
      terminal = verifyControl(
        local.publicKeys["ops-agent"],
        "openmapx-control-terminal-v1",
        generation.terminal,
        terminalCommitmentSchema,
      ),
      effect = verifyControl(
        local.publicKeys["ops-agent"],
        "openmapx-control-settlement-v1",
        generation.effect,
        settlementSchema.extend({ receipt: effectObservationSchema }),
      ),
      status = generation.status;
    if (
      childWitness.authorityDigest !== controlDigest(generation.admission) ||
      admitted.installationId !== installation.installationId ||
      canonicalJson(admitted.origin) !== canonicalJson(root.origin) ||
      canonicalJson(admitted.operation) !== canonicalJson(first.operation) ||
      canonicalJson(admitted.parent) !== canonicalJson(retainedControlParent(root.execution)) ||
      admitted.execution.operationKey !== first.operationKey ||
      admitted.execution.operationFingerprint !== first.operationFingerprint ||
      admitted.execution.deadlineAt > root.execution.deadlineAt ||
      admitted.execution.fingerprint !==
        executionFingerprint({
          kind: first.operation.kind,
          operationFingerprint: first.operationFingerprint,
          deadlineAt: admitted.execution.deadlineAt,
          parent: admitted.parent,
        }) ||
      terminal.phase !== "canonical" ||
      terminal.installationId !== installation.installationId ||
      canonicalJson(terminal.origin) !== canonicalJson(root.origin) ||
      canonicalJson(terminal.execution) !== canonicalJson(admitted.execution) ||
      terminal.admissionDigest !== controlDigest(generation.admission) ||
      terminal.terminalDigest !== controlTerminalReceiptDigest(status) ||
      canonicalJson(effect.identity) !== canonicalJson(admitted.execution) ||
      effect.outcome !== "committed" ||
      effect.publication !== "committed" ||
      effect.terminalReceiptDigest !== controlDigest(effect.receipt) ||
      effect.receipt.kind !== "ops-result" ||
      canonicalJson(parseBoundedOpsResult(first.operation.kind, effect.receipt.result)) !==
        canonicalJson(status.result) ||
      status.state !== "succeeded" ||
      status.kind !== first.operation.kind ||
      status.operationId !== admitted.execution.executionId ||
      status.operationKey !== admitted.execution.operationKey ||
      status.fingerprint !== admitted.execution.fingerprint ||
      status.deadlineAt !== admitted.execution.deadlineAt ||
      (status.result as { outcome?: string; revisionId?: string })?.outcome !== "committed" ||
      (status.result as { revisionId?: string })?.revisionId !== expected.revisionId
    )
      throw Error("Actual original committed generation required");
    return Object.freeze({
      witnessDigest: controlDigest(packet),
      decisionId: decision.operation.decisionId,
      generation: Object.freeze(admitted.execution),
    });
  } finally {
    directory.close();
  }
}
declare const maintenanceChildBrand: unique symbol;
export type VerifiedConfigurationMaintenanceChild = Readonly<{ [maintenanceChildBrand]: true }>;
const maintenanceChildren = new WeakMap<
  VerifiedConfigurationMaintenanceChild,
  {
    rootDigest: string;
    ordinal: number;
    execution: ExecutionRef;
    status: OpsJobStatus;
    terminalDigest: string;
    terminalAt: number;
    effectSettlementDigest: string;
    settlement: ChildSettlement;
  }
>();
/** The status is only a canonical preimage. The actual original admission,
 * fixed phase, private effect, private canonical tuple/time and family index
 * must ALL agree; a public status/result/digest cannot create this proof. */
export function verifyConfigurationMaintenanceChildTerminal(
  authority: VerifiedExecutionAuthority,
  ordinal: number,
  input: OpsJobStatus,
  terminalAt: number,
): VerifiedConfigurationMaintenanceChild {
  const root = executionAuthorityState(authority);
  if (
    root.kind !== "configurationMaintenance.prepare" ||
    !root.origin ||
    root.installation.installation.role !== "ops-agent" ||
    root.installation.fixedChildId
  )
    throw Error("Original maintenance child source required");
  const admitted = readPrivateRecord(
      root.installation,
      "executions",
      `${root.execution.operationKey}.json`,
      65536,
    ) as { payload?: { operation?: { maintenanceId?: string } } },
    name = `${uuid.parse(admitted.payload?.operation?.maintenanceId)}.json`,
    raw = readPrivateRecord(root.installation, "configuration-maintenance", name),
    owner = verifyControl(
      root.installation.installation.publicKey,
      "openmapx-configuration-maintenance-owner-v2",
      raw,
      configurationMaintenanceOwnerRecordSchema,
    );
  verifyFamilyOwnedRecord(
    root.installation,
    root.origin,
    { scope: "private", namespace: "configuration-maintenance", container: "", name },
    canonicalJson(raw),
  );
  assertConfigurationMaintenanceDecisionSource(owner);
  const step = owner.plan.steps[ordinal],
    source = owner.apiControls.steps.find((value) => value.ordinal === ordinal),
    slot = root.reservations.find((value) => value.ordinal === ordinal),
    child = slot && lookupControlChildPhase(authority, slot);
  if (
    !step ||
    !source?.grant ||
    !child ||
    canonicalJson(owner.plan.prepare) !== canonicalJson(root.execution) ||
    owner.admissionDigest !== root.receiptDigest ||
    canonicalJson(source.execution) !== canonicalJson(child.execution)
  )
    throw Error("Original frozen maintenance child required");
  const childAuthority = restoreAdmittedControlExecution(
      root.installation.installation,
      child.execution,
    ),
    state = executionAuthorityState(childAuthority),
    admission = readPrivateRecord(
      root.installation,
      "executions",
      `${child.execution.operationKey}.json`,
      65536,
    ) as { payload?: { operation?: unknown; parent?: unknown } },
    canonical = readTerminalCommitment(state),
    status = parseOpsJobStatus(input),
    settlement = childSettlementState(
      verifyControlEffectSettlement(root.installation.installation, child.execution),
    ).evidence,
    effect = verifyControl(
      root.installation.installation.publicKey,
      "openmapx-control-settlement-v1",
      readPrivateRecord(
        root.installation,
        "effects",
        `${child.execution.operationKey}.json`,
        65536,
      ),
      settlementSchema.extend({ receipt: effectObservationSchema }),
    );
  const nonCommit =
      step.phase === "configuration-commit" &&
      effect.receipt.kind === "configuration-generation-not-committed" &&
      settlement.outcome === "contained" &&
      settlement.publication === "not_started" &&
      canonicalJson(
        inspectConfigurationGenerationNonCommit(root.installation.installation, child.execution)
          .result,
      ) === canonicalJson(status.result),
    committed =
      settlement.outcome === "committed" &&
      settlement.publication === "committed" &&
      effect.receipt.kind === "ops-result" &&
      canonicalJson(parseBoundedOpsResult(step.operation.kind, effect.receipt.result)) ===
        canonicalJson(status.result);
  if (
    canonical.phase !== "canonical" ||
    canonical.terminalAt !== terminalAt ||
    canonical.terminalDigest !== controlTerminalReceiptDigest(status) ||
    status.state !== "succeeded" ||
    status.kind !== step.operation.kind ||
    status.operationId !== child.execution.executionId ||
    status.operationKey !== child.execution.operationKey ||
    status.fingerprint !== child.execution.fingerprint ||
    status.deadlineAt !== child.execution.deadlineAt ||
    canonicalJson(admission.payload?.operation) !== canonicalJson(step.operation) ||
    canonicalJson(admission.payload?.parent) !==
      canonicalJson(retainedControlParent(root.execution)) ||
    !(committed || nonCommit)
  )
    throw Error("Actual committed maintenance child canonical/effect source required");
  if (
    step.phase === "configuration-commit" &&
    !nonCommit &&
    (!(status.result && typeof status.result === "object") ||
      (status.result as { outcome?: string }).outcome !== "committed" ||
      (status.result as { revisionId?: string }).revisionId !== owner.plan.operation.revisionId)
  )
    throw Error("Original candidate generation commit required");
  assertFamilyCanonicalCompatibility(
    root.installation,
    root.origin,
    child.execution,
    canonical.terminalDigest,
    canonical.terminalAt,
  );
  const { diagnostics: _diagnostics, ...safe } = status,
    value = Object.freeze({}) as VerifiedConfigurationMaintenanceChild;
  const freezeSource = <T>(data: T): T => {
    if (data && typeof data === "object" && !Object.isFrozen(data)) {
      for (const child of Object.values(data)) freezeSource(child);
      Object.freeze(data);
    }
    return data;
  };
  maintenanceChildren.set(
    value,
    freezeSource({
      rootDigest: root.receiptDigest,
      ordinal,
      execution: child.execution,
      status: safe,
      terminalDigest: canonical.terminalDigest,
      terminalAt: canonical.terminalAt,
      effectSettlementDigest: controlDigest(settlement),
      settlement,
    }),
  );
  return value;
}
export function configurationMaintenanceChildState(
  value: VerifiedConfigurationMaintenanceChild,
  authority: VerifiedExecutionAuthority,
) {
  const source = maintenanceChildren.get(value),
    root = executionAuthorityState(authority);
  if (
    !source ||
    source.rootDigest !== root.receiptDigest ||
    root.kind !== "configurationMaintenance.prepare"
  )
    throw Error("Actual original maintenance child proof required");
  return source;
}
const recovery = new WeakMap<object, { authority: AuthorityState; evidence: ChildSettlement }>();
export function verifyControlRecoveryAuthority(
  authority: VerifiedExecutionAuthority,
): VerifiedRecoveryAuthority {
  const s = executionAuthorityState(authority);
  const evidence = childSettlementState(
    verifyControlEffectSettlement(s.installation.installation, s.execution),
  ).evidence;
  const result = Object.freeze({}) as VerifiedRecoveryAuthority;
  recovery.set(result, { authority: s, evidence });
  return result;
}
export function recoveryAuthorityState(value: VerifiedRecoveryAuthority) {
  const s = recovery.get(value);
  if (!s) throw Error("Unverified recovery authority");
  return s;
}

/** Exact role parent identity is independent of the assertion that binds its child (no hash cycle). */
export function retainedControlParent(execution: ExecutionRef): RetainedParentExecution {
  const retained = executionRefSchema.parse(execution);
  return {
    issuer: retained.executor,
    execution: retained,
    operationKey: retained.operationKey,
    fingerprint: retained.fingerprint,
    deadlineAt: retained.deadlineAt,
  };
}

export const CONTROL_RECOVERY_INSTRUCTIONS =
  "Run openmapx compose render on the installation host to provision control trust. For missing or conflicting retained records: stop all relevant writers and helpers, inspect the original private receipts and publication state, and repair only the exact owned record; never delete locks by age.";
/** Availability is not authority. An unavailable signer leaves inspection/recovery HTTP routes intact. */
export function loadControlStartup(options: Parameters<typeof openControlInstallation>[0]): {
  installation?: ControlInstallation;
  reason?: string;
} {
  try {
    return { installation: openControlInstallation(options) };
  } catch {
    return { reason: CONTROL_RECOVERY_INSTRUCTIONS };
  }
}
export const controlAdoptionSchema = z.strictObject({
  leaseId: uuid,
  delegationId: uuid,
  phase: z.enum(["pending-adoption", "ready", "recovery_required"]),
});
export type ControlAdoption = z.infer<typeof controlAdoptionSchema>;

const parentAssertionSchema = z.strictObject({
  version: z.literal(1),
  installationId: uuid,
  issuer: z.enum(CONTROL_ROLES),
  operationKey: z.string().regex(/^opk1_[A-Za-z0-9_-]{16,64}$/),
  attemptId: uuid,
  grantDigest: digest,
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
});
const parentGrantSchema = z.strictObject({
  version: z.union([z.literal(1), z.literal(2)]),
  origin: controlOriginSchema.optional(),
  installationId: uuid,
  parent: executionRefSchema,
  child: executionRefSchema,
  kind: z.string().max(128),
  phase: z.enum(["data-workflow", "osm", "transit", "fonts", "data-step"]),
  recipient: z.enum(["fixed-cli", "data-manager"]),
  childPublicKey: z.string().max(256),
  attemptId: uuid,
  parentAssertion: z.string().max(4096).optional(),
  ordinal: z.number().int().min(0).max(63),
});
function parseParentAssertion(assertion: string) {
  if (assertion.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(assertion))
    throw Error("Invalid parent assertion");
  const parsed = parentAssertionSchema.parse(
    JSON.parse(Buffer.from(assertion, "base64url").toString("utf8")),
  );
  if (Buffer.from(canonicalJson(parsed)).toString("base64url") !== assertion)
    throw Error("Noncanonical parent assertion");
  return parsed;
}
function executionWitnessDirectory(
  state: InstallationState,
  issuer: ControlIssuer,
  create = false,
) {
  const data = new AnchoredDirectory(state.dataRoot),
    control = data.directory(".admin-target-control", create, true),
    executions = control.directory("executions", create, true),
    role = executions.directory(issuer, create, true);
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
const dataContainmentWitnessSchema = z.strictObject({
  version: z.literal(1),
  installationId: uuid,
  execution: executionRefSchema,
  status: dataExecutionStatusSchema,
  terminalAt: z.number().int().positive().safe(),
  terminalDigest: digest,
});
/** Fixed DM journal calls only after verifying its own DB tuple, private
 * original terminal commitment, all children and actual target release. */
export function publishDataControlTerminalWitness(
  authority: VerifiedExecutionAuthority,
  status: import("../services/data-manager/contracts/executions").DataExecutionStatus,
  terminalAt: number,
): void {
  const s = executionAuthorityState(authority);
  if (s.installation.installation.role !== "data-manager" || s.installation.fixedChildId)
    throw Error("Original data journal required");
  if (s.kind === "generation-hardlinks") verifyRetainedGenerationHardlinksSettlement(authority);
  else verifyRetainedArtifactTargetRootRelease(authority);
  const expected = controlDigest({ version: 1, status: dataExecutionStatusSchema.parse(status) });
  const original = verifyControl(
    s.installation.installation.publicKey,
    "openmapx-data-terminal-v1",
    readPrivateRecord(
      s.installation,
      "observations",
      `terminal-${s.execution.operationKey}.json`,
      8192,
    ),
    z
      .object({
        phase: z.literal("canonical"),
        execution: executionRefSchema,
        terminalDigest: digest,
        terminalAt: z.number(),
        admissionDigest: digest,
      })
      .passthrough(),
  );
  if (
    original.terminalDigest !== expected ||
    original.terminalAt !== terminalAt ||
    original.admissionDigest !== s.receiptDigest ||
    controlDigest(original.execution) !== controlDigest(s.execution)
  )
    throw Error("Original canonical data commitment required");
  const payload = dataContainmentWitnessSchema.parse({
      version: 1,
      installationId: s.installation.installation.installationId,
      execution: s.execution,
      status,
      terminalAt,
      terminalDigest: expected,
    }),
    directory = executionWitnessDirectory(s.installation, "data-manager");
  try {
    const name = `${s.execution.operationKey}.data-terminal.json`,
      bytes = canonicalJson(
        signControl(s.installation.privateKey, "openmapx-data-contained-terminal-v1", payload),
      );
    let prior: Buffer | undefined;
    try {
      prior = directory.role.read(name, 65536);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (prior) {
      if (prior.toString("utf8") !== bytes) throw Error("Canonical data witness changed");
      return;
    }
    writeExecutionShared(s.installation, s.execution, directory.role, name, bytes, true);
  } finally {
    directory.close();
  }
}
/** A parent verifies the pinned DM signature and exact bound execution; a GET
 * status or dead child process alone is never backend containment evidence. */
export function verifyDataControlTerminalWitness(
  installation: ControlInstallation,
  execution: ExecutionRef,
  status?: import("../services/data-manager/contracts/executions").DataExecutionStatus,
) {
  const local = installationState(installation),
    directory = executionWitnessDirectory(local, "data-manager");
  try {
    const proof = verifyControl(
      local.publicKeys["data-manager"],
      "openmapx-data-contained-terminal-v1",
      JSON.parse(
        directory.role.read(`${execution.operationKey}.data-terminal.json`, 65536).toString("utf8"),
      ),
      dataContainmentWitnessSchema,
    );
    if (
      proof.installationId !== installation.installationId ||
      controlDigest(proof.execution) !== controlDigest(execution) ||
      proof.terminalDigest !== controlDigest({ version: 1, status: proof.status }) ||
      (status && canonicalJson(status) !== canonicalJson(proof.status)) ||
      !["ok", "partial", "error", "canceled", "interrupted"].includes(proof.status.status) ||
      proof.status.publication === "unknown"
    )
      throw Error("Exact canonical data containment witness required");
    readControlExecutionWitness(local, execution, local.publicKeys["data-manager"]);
    return proof;
  } finally {
    directory.close();
  }
}
const lifecycleSchema = z.strictObject({
  version: z.literal(1),
  installationId: uuid,
  execution: executionRefSchema,
  sequence: z.number().int().nonnegative().safe(),
  phase: z.enum(["held", "cancel_pending", "recovery_required", "settled"]),
  childIntents: z.record(uuid, digest),
  leaseIntents: z
    .record(
      uuid,
      z.strictObject({
        child: executionRefSchema,
        leaseId: uuid,
        grantDigest: digest,
        attemptDigest: digest,
      }),
    )
    .optional(),
});
type ExecutionLifecycle = z.infer<typeof lifecycleSchema>;
function withExecutionWriter<T>(
  state: InstallationState,
  execution: ExecutionRef,
  run: (dir: AnchoredDirectory) => T,
): T {
  const d = executionWitnessDirectory(state, execution.executor, true);
  const name = `${execution.operationKey}.writer`;
  let guard: AnchoredDirectory | undefined;
  try {
    mkdirSync(d.role.name(name), { mode: 0o700 });
    fsyncSync(d.role.fd);
    guard = d.role.directory(name);
    return run(d.role);
  } finally {
    if (guard) {
      const held = identity(guard.stat);
      guard.close();
      d.role.removeDirectory(name, held);
    }
    d.close();
  }
}
function readLifecycle(
  state: InstallationState,
  dir: AnchoredDirectory,
  execution: ExecutionRef,
  verifier: string,
): ExecutionLifecycle {
  const raw = JSON.parse(
    dir.read(`${execution.operationKey}.lifecycle.json`, 65536).toString("utf8"),
  );
  const current = verifyControl(verifier, "openmapx-execution-lifecycle-v1", raw, lifecycleSchema);
  if (
    current.installationId !== state.installation.installationId ||
    controlDigest(current.execution) !== controlDigest(execution) ||
    Object.keys(current.childIntents).length + Object.keys(current.leaseIntents ?? {}).length > 64
  )
    throw Error("Execution lifecycle identity/capacity mismatch");
  const observationName = `${execution.executor}-${execution.operationKey}.json`;
  function compare(old: ExecutionLifecycle) {
    if (
      current.sequence < old.sequence ||
      (current.sequence === old.sequence && controlDigest(current) !== controlDigest(old))
    )
      throw Error("Execution lifecycle rollback or replacement");
  }
  if (verifier === state.installation.publicKey) {
    const local = verifyControl(
      verifier,
      "openmapx-execution-lifecycle-v1",
      readPrivateRecord(state, "execution-lifecycle", `${execution.operationKey}.json`, 65536),
      lifecycleSchema,
    );
    compare(local);
  }
  try {
    compare(
      lifecycleSchema.parse(
        readPrivateRecord(state, "lifecycle-observations", observationName, 65536),
      ),
    );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const origin = readControlExecutionWitness(state, execution, verifier).origin;
  if (!origin || hasLocalRetentionFamily(state, origin))
    writePrivateRecord(state, "lifecycle-observations", observationName, current, false, origin);
  return current;
}
function writeLifecycle(
  state: InstallationState,
  dir: AnchoredDirectory,
  lifecycle: ExecutionLifecycle,
  exclusive = false,
) {
  const signed = signControl(state.privateKey, "openmapx-execution-lifecycle-v1", lifecycle);
  const bytes = canonicalJson(signed);
  if (Buffer.byteLength(bytes) > 65536) throw Error("Execution lifecycle capacity");
  // Persist the private fence first. A crash before shared publication fails closed.
  writePrivateRecord(
    state,
    "execution-lifecycle",
    `${lifecycle.execution.operationKey}.json`,
    signed,
    exclusive,
    retainedExecutionOrigin(state, lifecycle.execution),
  );
  writeExecutionShared(
    state,
    lifecycle.execution,
    dir,
    `${lifecycle.execution.operationKey}.lifecycle.json`,
    bytes,
    exclusive,
  );
  readLifecycle(state, dir, lifecycle.execution, state.installation.publicKey);
}
function initializeLifecycle(
  state: InstallationState,
  execution: ExecutionRef,
  newlyAdmitted: boolean,
) {
  withExecutionWriter(state, execution, (dir) => {
    try {
      readLifecycle(state, dir, execution, state.installation.publicKey);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      if (!newlyAdmitted)
        throw Error("Missing retained execution lifecycle requires supervised recovery");
      // Never replace a private fence after partial publication.
      try {
        readPrivateRecord(state, "execution-lifecycle", `${execution.operationKey}.json`);
        throw Error("Incomplete execution lifecycle requires supervised recovery");
      } catch (missing) {
        if ((missing as NodeJS.ErrnoException).code !== "ENOENT") throw missing;
      }
      writeLifecycle(
        state,
        dir,
        {
          version: 1,
          installationId: state.installation.installationId,
          execution,
          sequence: 0,
          phase: "held",
          childIntents: {},
        },
        true,
      );
    }
  });
}
function withParentLifecycles<T>(
  state: InstallationState,
  assertion: string,
  run: (forward: boolean) => T,
): T {
  const chain: Array<{
    assertion: string;
    grant: z.infer<typeof parentGrantSchema>;
    verifier: string;
  }> = [];
  function collect(value: string) {
    const grant = readParentGrant(state, value);
    if (grant.parentAssertion) collect(grant.parentAssertion);
    const verifier = grant.parentAssertion
      ? readParentGrant(state, grant.parentAssertion).childPublicKey
      : state.publicKeys[grant.parent.executor];
    chain.push({ assertion: value, grant, verifier });
  }
  collect(assertion);
  function lock(index: number, forward: boolean): T {
    const item = chain[index];
    if (!item) return run(forward);
    return withExecutionWriter(state, item.grant.parent, (dir) => {
      const lifecycle = readLifecycle(state, dir, item.grant.parent, item.verifier);
      const parsed = parseParentAssertion(item.assertion);
      if (lifecycle.childIntents[parsed.attemptId] !== parsed.grantDigest)
        throw Error("Missing durable lifecycle child intent");
      return lock(
        index + 1,
        forward && lifecycle.phase === "held" && Date.now() < lifecycle.execution.deadlineAt,
      );
    });
  }
  return lock(0, true);
}
/** Narrow local runtime fence; exact duplicate admission alone never grants forward permission. */
export class ControlExecutionFencedError extends Error {}
export function markFeedProxyReloadAttempted(authority: VerifiedExecutionAuthority): void {
  withControlExecutionForward(authority, () => recordFeedProxyReloadAttempted(authority));
}
function withControlExecutionForward<T>(authority: VerifiedExecutionAuthority, run: () => T): T {
  const s = executionAuthorityState(authority);
  if (!s.origin)
    throw Error(
      "Legacy undated control authority is observation/settlement only; upgrade producer",
    );
  assertOriginClockForward(s.installation, s.origin);
  const check = () =>
    withExecutionWriter(s.installation, s.execution, (dir) => {
      const lifecycle = readLifecycle(
        s.installation,
        dir,
        s.execution,
        s.installation.installation.publicKey,
      );
      if (lifecycle.phase !== "held" || Date.now() >= s.execution.deadlineAt)
        throw new ControlExecutionFencedError(
          "Execution cannot restart effects; observation/settlement only; forward phase fenced",
        );
      return run();
    });
  const assertion = retainedParentAssertion(s);
  return assertion
    ? withParentLifecycles(s.installation, assertion, (forward) => {
        if (!forward)
          throw new ControlExecutionFencedError(
            "Canceled/terminal ancestor permits observation only",
          );
        return check();
      })
    : check();
}
/** Internal publication scope. All filesystem writes complete before guards
 * release; callers may not await HTTP/DB or acquire a lease from this scope. */
const publicationScopes = new WeakMap<VerifiedExecutionAuthority, AnchoredDirectory>();
/** Original maintenance recovery publication only. It serializes with every
 * ordinary grant, including after cancellation/expiry, and grants no dispatch. */
export function withControlMaintenanceNoGuardPublication<T>(
  authority: VerifiedExecutionAuthority,
  run: () => T,
): T {
  return withMaintenanceRecoveryPublication(authority, run);
}
function withMaintenanceRecoveryPublication<T>(
  authority: VerifiedExecutionAuthority,
  run: () => T,
): T {
  const s = executionAuthorityState(authority);
  if (
    s.kind !== "configurationMaintenance.prepare" ||
    !s.origin ||
    s.installation.fixedChildId ||
    s.installation.installation.role !== "ops-agent" ||
    s.origin.rootKey !== s.execution.operationKey
  )
    throw Error("Original maintenance issuance freeze required");
  const own = () =>
    withExecutionWriter(s.installation, s.execution, (directory) => {
      readLifecycle(s.installation, directory, s.execution, s.installation.installation.publicKey);
      return run();
    });
  const assertion = retainedParentAssertion(s);
  return assertion ? withParentLifecycles(s.installation, assertion, () => own()) : own();
}
/** Purpose-only metadata serialization for the original logical guard control.
 * This creates no forward authority, child binding or dispatch ticket. The
 * fixed producer still consumes its restored actual final proof. */
export function withControlMaintenanceSettlementPublication<T>(
  authority: VerifiedExecutionAuthority,
  run: () => T,
): T {
  return withMaintenanceRecoveryPublication(authority, () => {
    const state = executionAuthorityState(authority),
      admitted = readPrivateRecord(
        state.installation,
        "executions",
        `${state.execution.operationKey}.json`,
        65536,
      ) as { payload?: { operation?: { maintenanceId?: string } } },
      raw = readPrivateRecord(
        state.installation,
        "configuration-maintenance",
        `${uuid.parse(admitted.payload?.operation?.maintenanceId)}.json`,
      ),
      owner = verifyControl(
        state.installation.installation.publicKey,
        "openmapx-configuration-maintenance-owner-v2",
        raw,
        configurationMaintenanceOwnerRecordSchema,
      );
    verifyFamilyOwnedRecord(
      state.installation,
      state.origin!,
      {
        scope: "private",
        namespace: "configuration-maintenance",
        container: "",
        name: `${owner.plan.operation.maintenanceId}.json`,
      },
      canonicalJson(raw),
    );
    if (
      !owner.final ||
      !owner.inspection ||
      owner.noGuard ||
      owner.admissionDigest !== state.receiptDigest ||
      canonicalJson(owner.plan.prepare) !== canonicalJson(state.execution)
    )
      throw Error("Original final-only settlement publication required");
    return run();
  });
}
/** Initial private owner publication precedes the first ordinary grant. */
export function withControlMaintenanceInitialization<T>(
  authority: VerifiedExecutionAuthority,
  run: () => T,
): T {
  const s = executionAuthorityState(authority);
  if (
    s.kind !== "configurationMaintenance.prepare" ||
    s.installation.fixedChildId ||
    s.installation.installation.role !== "ops-agent"
  )
    throw Error("Original maintenance initialization required");
  return withControlExecutionForward(authority, run);
}
export function assertControlPublicationScope(
  authority: VerifiedExecutionAuthority,
): AnchoredDirectory {
  const directory = publicationScopes.get(authority);
  if (!directory) throw Error("Control publication scope is not held");
  return directory;
}
export function withControlDelegationPublication<T>(
  authority: VerifiedExecutionAuthority,
  phase: ControlChildPhase,
  run: (directory: AnchoredDirectory) => T,
): T {
  const s = executionAuthorityState(authority);
  if (!s.origin) throw Error("Legacy control admission cannot publish grants");
  assertOriginClockForward(s.installation, s.origin);
  const own = () =>
    withExecutionWriter(s.installation, s.execution, (directory) => {
      const current = readLifecycle(
        s.installation,
        directory,
        s.execution,
        s.installation.installation.publicKey,
      );
      if (s.kind === "configurationMaintenance.prepare") {
        const admission = readPrivateRecord(
            s.installation,
            "executions",
            `${s.execution.operationKey}.json`,
            65536,
          ) as { payload?: { operation?: { maintenanceId?: string } } },
          raw = readPrivateRecord(
            s.installation,
            "configuration-maintenance",
            `${uuid.parse(admission.payload?.operation?.maintenanceId)}.json`,
          ),
          owner = verifyControl(
            s.installation.installation.publicKey,
            "openmapx-configuration-maintenance-owner-v2",
            raw,
            configurationMaintenanceOwnerRecordSchema,
          );
        verifyFamilyOwnedRecord(
          s.installation,
          s.origin!,
          {
            scope: "private",
            namespace: "configuration-maintenance",
            container: "",
            name: `${admission.payload!.operation!.maintenanceId}.json`,
          },
          canonicalJson(raw),
        );
        if (
          owner.admissionDigest !== s.receiptDigest ||
          owner.issuance !== "open" ||
          canonicalJson(owner.plan.prepare) !== canonicalJson(s.execution) ||
          canonicalJson(owner.origin) !== canonicalJson(s.origin) ||
          canonicalJson(owner.plan.reservations) !== canonicalJson(s.reservations)
        )
          throw Error("Original maintenance issuer changed");
        assertConfigurationMaintenanceDecisionSource(owner);
        if (
          [
            "configuration-commit",
            "maintenance-hardlinks",
            "maintenance-recreate",
            "maintenance-handoff",
          ].includes(phase) &&
          (canonicalJson(owner.receipt.prepare) !== canonicalJson(s.execution) ||
            !["authorized", "applying"].includes(owner.receipt.state) ||
            owner.receipt.decision?.decision !== "continue" ||
            owner.receipt.dmFence?.state !== "prepared" ||
            owner.apiControls.decide?.operation.decision !== "continue" ||
            !owner.apiControls.decide.receiptDelivery)
        )
          throw new ControlExecutionFencedError(
            "Original authorized configuration decision required",
          );
      }
      const prepared =
        (s.kind === "configurationMaintenance.prepare" &&
          [
            "configuration-commit",
            "maintenance-hardlinks",
            "maintenance-recreate",
            "maintenance-handoff",
          ].includes(phase)) ||
        (s.kind === "configurationHandoff.prepare" && phase === "configuration-handoff");
      if (
        Date.now() >= s.execution.deadlineAt ||
        !(current.phase === "held" || (current.phase === "settled" && prepared))
      )
        throw new ControlExecutionFencedError(
          "Control grant publication is fenced; terminal or canceled execution prevents forward effects",
        );
      if (current.phase === "settled") verifyControlPreparedTerminal(s.installation, s.execution);
      if (publicationScopes.has(authority)) throw Error("Nested control publication scope");
      publicationScopes.set(authority, directory);
      try {
        return run(directory);
      } finally {
        publicationScopes.delete(authority);
      }
    });
  const assertion = retainedParentAssertion(s);
  return assertion
    ? withParentLifecycles(s.installation, assertion, (forward) => {
        if (!forward) throw Error("Canceled ancestor prevents grant publication");
        return own();
      })
    : own();
}
export function assertControlExecutionForward(authority: VerifiedExecutionAuthority): void {
  withControlExecutionForward(authority, () => {});
}
/** Only a prepared maintenance owner's finite metadata decision may use its
 * terminal preparation here. This scope issues no grant/forward handle and
 * does not alter ordinary execution normalization or terminal graph rules. */
export function withControlMaintenanceDecisionPublication<T>(
  authority: VerifiedExecutionAuthority,
  run: () => T,
): T {
  const s = executionAuthorityState(authority);
  if (s.kind !== "configurationMaintenance.prepare" || !s.origin)
    throw Error("Original prepared maintenance decision owner required");
  assertOriginClockForward(s.installation, s.origin);
  const own = () =>
    withExecutionWriter(s.installation, s.execution, (directory) => {
      const current = readLifecycle(
        s.installation,
        directory,
        s.execution,
        s.installation.installation.publicKey,
      );
      if (current.phase !== "settled" || Date.now() >= s.execution.deadlineAt)
        throw new ControlExecutionFencedError(
          "Original prepared maintenance forward decision is fenced",
        );
      verifyControlPreparedTerminal(s.installation, s.execution);
      return run();
    });
  const assertion = retainedParentAssertion(s);
  return assertion
    ? withParentLifecycles(s.installation, assertion, (forward) => {
        if (!forward)
          throw new ControlExecutionFencedError("Canceled ancestor prevents maintenance continue");
        return own();
      })
    : own();
}
/** Only the protocol's frozen terminal preparation edges may outlive their local worker. */
export function assertControlDelegationForward(
  authority: VerifiedExecutionAuthority,
  phase: ControlChildPhase,
): void {
  withControlDelegationPublication(authority, phase, () => {});
}
function retainedParentAssertion(s: AuthorityState): string | undefined {
  if (s.installation.fixedParentAssertion) return s.installation.fixedParentAssertion;
  // Retain the exact adopted assertion with the execution, never search history.
  try {
    return z
      .object({ assertion: z.string() })
      .parse(
        readPrivateRecord(s.installation, "execution-parents", `${s.execution.operationKey}.json`),
      ).assertion;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  return undefined;
}
/** Persist before a runtime publishes canceled state; return original attempted child identities for cancellation/lookup. */
export function cancelControlExecution(
  authority: VerifiedExecutionAuthority,
): readonly ExecutionRef[] {
  const s = executionAuthorityState(authority);
  return withExecutionWriter(s.installation, s.execution, (dir) => {
    const lifecycle = readLifecycle(
      s.installation,
      dir,
      s.execution,
      s.installation.installation.publicKey,
    );
    if (lifecycle.phase !== "settled" && lifecycle.phase !== "cancel_pending") {
      lifecycle.phase = "cancel_pending";
      lifecycle.sequence++;
      writeLifecycle(s.installation, dir, lifecycle);
    }
    const children = Object.keys(lifecycle.childIntents).map((id) => {
      const saved = z
        .object({ grant: z.unknown() })
        .parse(readPrivateRecord(s.installation, "parent-attempts", `${id}.json`));
      return Object.freeze(
        verifyControl(
          s.installation.installation.publicKey,
          originRecordDomain("openmapx-parent-grant", saved.grant),
          saved.grant,
          parentGrantSchema,
        ).child,
      );
    });
    for (const [id, intent] of Object.entries(lifecycle.leaseIntents ?? {})) {
      // The signed index is published before its private outbox. A crash in
      // that gap retains this exact identity for cancellation/lookup.
      let saved: unknown;
      try {
        saved = readPrivateRecord(s.installation, "parent-attempts", `${id}.json`, 8192);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (saved !== undefined && saved !== null) {
        const parsed = z
          .strictObject({ kind: z.literal("lease"), attempt: z.unknown() })
          .parse(saved);
        const value = verifyControl(
          s.installation.installation.publicKey,
          "openmapx-lease-execution-attempt-v2",
          parsed.attempt,
          leaseExecutionAttemptSchema,
        );
        if (
          value.installationId !== s.installation.installation.installationId ||
          controlDigest(value.origin) !== controlDigest(s.origin) ||
          controlDigest(value.parent) !== controlDigest(s.execution) ||
          controlDigest(parsed.attempt) !== intent.attemptDigest ||
          controlDigest(value.child) !== controlDigest(intent.child) ||
          value.leaseId !== intent.leaseId ||
          value.grantDigest !== intent.grantDigest
        )
          throw Error("Retained lease cancellation intent changed");
      }
      children.push(Object.freeze({ ...intent.child }));
    }
    for (const reserved of s.reservations) {
      const saved = inspectControlChildPublication(authority, reserved);
      if (saved.publication.state === "grant_prepared" && saved.binding)
        children.push(Object.freeze({ ...saved.binding.child.execution }));
    }
    const distinct = new Map<string, ExecutionRef>();
    for (const child of children) {
      const prior = distinct.get(child.operationKey);
      if (prior && controlDigest(prior) !== controlDigest(child))
        throw Error("Cancellation child identity disagreement");
      distinct.set(child.operationKey, child);
    }
    return Object.freeze([...distinct.values()]);
  });
}
const leaseExecutionAttemptSchema = z.strictObject({
  version: z.literal(2),
  installationId: uuid,
  origin: controlOriginSchema,
  parent: executionRefSchema,
  child: executionRefSchema,
  leaseId: uuid,
  delegationId: uuid,
  grantDigest: digest,
});
/** Fixed lease issuer only; exact identities become cancellation-visible before
 * outbox/shared exposure, including a crash before the parent node update. */
export function recordLeaseControlAttempt(
  authority: VerifiedExecutionAuthority,
  input: { child: ExecutionRef; leaseId: string; delegationId: string; grantDigest: string },
): void {
  const s = executionAuthorityState(authority),
    directory = assertControlPublicationScope(authority);
  if (!s.origin) throw Error("Lease attempt origin is missing");
  const lifecycle = readLifecycle(
    s.installation,
    directory,
    s.execution,
    s.installation.installation.publicKey,
  );
  const leases = lifecycle.leaseIntents ?? {};
  if (
    Object.keys(lifecycle.childIntents).length + Object.keys(leases).length >= 64 ||
    leases[input.delegationId]
  )
    throw Error("Execution cancellation intent capacity/replay");
  const attempt = signControl(
    s.installation.privateKey,
    "openmapx-lease-execution-attempt-v2",
    leaseExecutionAttemptSchema.parse({
      version: 2,
      installationId: s.installation.installation.installationId,
      origin: s.origin,
      parent: s.execution,
      ...input,
    }),
  );
  leases[input.delegationId] = {
    child: input.child,
    leaseId: input.leaseId,
    grantDigest: input.grantDigest,
    attemptDigest: controlDigest(attempt),
  };
  lifecycle.leaseIntents = leases;
  lifecycle.sequence++;
  writeLifecycle(s.installation, directory, lifecycle);
  writePrivateRecord(
    s.installation,
    "parent-attempts",
    `${input.delegationId}.json`,
    { kind: "lease", attempt },
    true,
    s.origin,
  );
}
export function settleExecutionLifecycle(s: AuthorityState) {
  withExecutionWriter(s.installation, s.execution, (dir) => {
    const lifecycle = readLifecycle(
      s.installation,
      dir,
      s.execution,
      s.installation.installation.publicKey,
    );
    if (lifecycle.phase !== "settled") {
      lifecycle.phase = "settled";
      lifecycle.sequence++;
      writeLifecycle(s.installation, dir, lifecycle);
    }
  });
}
export async function attestParentExecution(
  authority: VerifiedExecutionAuthority,
  child: {
    execution: ExecutionRef;
    phase: ControlChildPhase;
    serviceIds: readonly string[];
    recipient: ControlRecipient;
    childPublicKey: string;
  },
): Promise<string> {
  const s = executionAuthorityState(authority);
  if (Date.now() >= s.execution.deadlineAt) throw Error("Expired parent execution");
  const plan = resolveControlChildPlan(authority, child);
  if (!plan || !childPhaseKinds[child.phase].includes(plan.kind))
    throw Error("Child absent from retained plan");
  try {
    readPrivateRecord(s.installation, "execution-leases", `${s.execution.operationKey}.json`);
    throw Error("Deadline-only parent must not hold targets");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  if (
    child.recipient === "fixed-cli"
      ? child.phase !== "data-workflow" || s.installation.installation.role !== "ops-agent"
      : child.recipient !== "data-manager" ||
        !["osm", "transit", "fonts", "data-step"].includes(child.phase)
  )
    throw Error("Unauthorized deadline-only edge");
  if (["osm", "transit", "fonts"].includes(child.phase) && s.kind !== "data.update")
    throw Error("Only Full Update may delegate data phases");
  if (
    child.recipient === "data-manager" &&
    child.childPublicKey !== s.installation.publicKeys["data-manager"]
  )
    throw Error("Wrong child role key");
  verifyDeadlineEdge(s.kind, child.phase, child.recipient, plan.kind);
  let attemptId: string = randomUUID();
  if (child.recipient === "fixed-cli") {
    attemptId = fixedControlChildId(s.installation, child.childPublicKey, s.execution);
  }
  if (!s.origin) throw Error("Legacy parent origin is observation-only");
  assertOriginClockForward(s.installation, s.origin);
  const grant = parentGrantSchema.parse({
    version: 2,
    origin: s.origin,
    installationId: s.installation.installation.installationId,
    parent: s.execution,
    child: child.execution,
    kind: plan.kind,
    phase: child.phase,
    recipient: child.recipient,
    childPublicKey: child.childPublicKey,
    attemptId,
    ordinal: plan.ordinal,
    ...(s.installation.fixedParentAssertion
      ? { parentAssertion: s.installation.fixedParentAssertion }
      : {}),
  });
  const signed = signControl(s.installation.privateKey, "openmapx-parent-grant-v2", grant);
  const fields = {
    version: 1 as const,
    installationId: grant.installationId,
    issuer: s.execution.executor,
    operationKey: s.execution.operationKey,
    attemptId,
    grantDigest: controlDigest(signed),
  };
  const assertion = Buffer.from(
    canonicalJson({
      ...fields,
      signature: signControl(s.installation.privateKey, "openmapx-parent-assertion-v1", fields)
        .signature,
    }),
  ).toString("base64url");
  parseParentAssertion(assertion);
  return withControlDelegationPublication(authority, child.phase, (dir) => {
    const lifecycle = readLifecycle(
      s.installation,
      dir,
      s.execution,
      s.installation.installation.publicKey,
    );
    if (lifecycle.phase !== "held" || Date.now() >= s.execution.deadlineAt)
      throw Error("Canceled/terminal execution cannot authorize forward children");
    const name = `${s.execution.operationKey}.children.json`;
    let witness: Record<string, unknown> = {};
    try {
      witness = z
        .record(uuid, z.unknown())
        .parse(JSON.parse(dir.read(name, 65536).toString("utf8")));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    for (const value of Object.values(witness)) {
      const previous = verifyControl(
        s.installation.installation.publicKey,
        originRecordDomain("openmapx-parent-grant", value),
        value,
        parentGrantSchema,
      );
      if (previous.child.operationKey === child.execution.operationKey)
        throw Error("Attempted parent child cannot be replayed");
    }
    if (Object.keys(witness).length + Object.keys(lifecycle.leaseIntents ?? {}).length >= 64)
      throw Error("Parent attempt capacity");
    witness[attemptId] = signed;
    const bytes = canonicalJson(witness);
    if (Buffer.byteLength(bytes) > 65536) throw Error("Parent witness capacity");
    if (!s.origin) throw Error("Legacy origin is observation-only");
    enlistFamilyIntent(
      s.installation,
      s.origin,
      attemptId,
      child.execution,
      child.recipient === "data-manager" ? "data-manager" : "ops-agent",
    );
    prepareControlChildPublication(authority, plan, {
      delegationId: attemptId,
      grantDigest: fields.grantDigest,
      leaseId: null,
    });
    writePrivateRecord(
      s.installation,
      "parent-attempts",
      `${attemptId}.json`,
      { grant: signed, assertion },
      true,
      s.origin,
    );
    lifecycle.childIntents[attemptId] = fields.grantDigest;
    lifecycle.sequence++;
    writeLifecycle(s.installation, dir, lifecycle);
    writeExecutionShared(s.installation, s.execution, dir, name, bytes);
    return assertion;
  });
}

export function readParentGrant(
  state: InstallationState,
  assertion: string,
  depth = 0,
): z.infer<typeof parentGrantSchema> {
  if (depth > 1) throw Error("Parent assertion chain limit");
  const parsed = parseParentAssertion(assertion);
  if (parsed.installationId !== state.installation.installationId)
    throw Error("Foreign parent installation");
  const d = executionWitnessDirectory(state, parsed.issuer);
  let signed: unknown;
  try {
    const attempts = z
      .record(uuid, z.unknown())
      .parse(
        JSON.parse(d.role.read(`${parsed.operationKey}.children.json`, 65536).toString("utf8")),
      );
    signed = attempts[parsed.attemptId];
  } finally {
    d.close();
  }
  if (!signed || controlDigest(signed) !== parsed.grantDigest)
    throw Error("Missing exact retained parent attempt");
  const candidate = z.object({ payload: parentGrantSchema }).parse(signed).payload;
  let verifier = state.publicKeys[parsed.issuer];
  if (candidate.parentAssertion) {
    const ancestor = readParentGrant(state, candidate.parentAssertion, depth + 1);
    if (
      ancestor.recipient !== "fixed-cli" ||
      controlDigest(ancestor.child) !== controlDigest(candidate.parent) ||
      candidate.recipient !== "data-manager"
    )
      throw Error("Invalid fixed parent certification");
    verifier = ancestor.childPublicKey;
  }
  const { signature, ...fields } = parsed;
  verifyControl(
    verifier,
    "openmapx-parent-assertion-v1",
    { payload: fields, signature },
    parentAssertionSchema.omit({ signature: true }),
  );
  const grant = verifyControl(
    verifier,
    originRecordDomain("openmapx-parent-grant", signed),
    signed,
    parentGrantSchema,
  );
  const parent = readControlExecutionWitness(state, grant.parent, verifier);
  if (
    !validateOriginRecord(grant) ||
    !sameControlOrigin(grant.origin, parent.origin) ||
    grant.parent.executor !== parsed.issuer ||
    grant.parent.operationKey !== parsed.operationKey ||
    grant.attemptId !== parsed.attemptId ||
    grant.child.operationKey !==
      controlChildOperationKey(grant.parent.operationKey, grant.phase, grant.ordinal) ||
    !childPhaseKinds[grant.phase].includes(grant.kind)
  )
    throw Error("Parent immutable phase binding mismatch");
  verifyDeadlineEdge(parent.kind, grant.phase, grant.recipient, grant.kind);
  return grant;
}
export function verifyDeadlineEdge(
  parentKind: string,
  phase: ControlChildPhase,
  recipient: ControlRecipient,
  childKind: string,
) {
  const dataKinds: Record<string, string> = {
    "data.downloadOsm": "download-osm",
    "data.downloadFonts": "download-fonts",
    "data.convertOverpass": "convert-overpass",
    "data.overtureSync": "overture-sync",
    "data.overturePull": "overture-pull",
    "data.overtureIngest": "overture-ingest",
    "data.overtureExtract": "overture-extract",
    "data.overtureConflate": "overture-conflate",
    "data.searchIndexBuild": "search-index-build",
    "data.notablePlacesBuild": "notable-places-build",
  };
  if (
    recipient === "fixed-cli" &&
    phase === "data-workflow" &&
    childKind === parentKind &&
    childPhaseKinds[phase].includes(parentKind)
  )
    return;
  if (
    recipient === "data-manager" &&
    ((["osm", "transit", "fonts"].includes(phase) && parentKind === "data.update") ||
      (phase === "data-step" && dataKinds[parentKind] === childKind))
  )
    return;
  throw Error("Unauthorized deadline-only child kind");
}
export function verifyParentExecution(
  assertion: string,
  peer: VerifiedControlPeer,
  retainedAttempt: { execution: ExecutionRef; kind: string; requestedDeadlineAt: number },
): import("../ops/execution-identity").VerifiedParentExecution {
  const p = controlPeerState(peer);
  const parsed = parseParentAssertion(assertion);
  if (
    assertion !== p.assertion ||
    parsed.installationId !== p.installation.installation.installationId
  )
    throw Error("Foreign parent assertion");
  const grant = readParentGrant(p.installation, assertion);
  if (
    grant.parent.operationKey !== parsed.operationKey ||
    grant.attemptId !== parsed.attemptId ||
    grant.childPublicKey !== p.childPublicKey ||
    grant.recipient !== p.recipient ||
    grant.kind !== retainedAttempt.kind ||
    controlDigest(grant.child) !== controlDigest(retainedAttempt.execution) ||
    grant.child.deadlineAt !== retainedAttempt.requestedDeadlineAt ||
    grant.child.deadlineAt > grant.parent.deadlineAt
  )
    throw Error("Parent child identity mismatch");
  withParentLifecycles(p.installation, assertion, (forward) => {
    const name = `${parsed.attemptId}.json`;
    let retained = false;
    try {
      if (
        controlDigest(readPrivateRecord(p.installation, "parent-adoptions", name)) !==
        controlDigest(grant)
      )
        throw Error("Parent attempt replay conflict");
      retained = true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    if (!retained) {
      if (!grant.origin) throw Error("Legacy parent is observation-only; upgrade producer");
      assertOriginClockForward(p.installation, grant.origin);
      if (!forward) throw Error("Canceled/terminal parent permits observation only");
      if (Date.now() >= grant.child.deadlineAt) throw Error("Expired parent grant");
      writePrivateRecord(
        p.installation,
        "execution-parents",
        `${grant.child.operationKey}.json`,
        { assertion },
        true,
        grant.origin,
      );
      writePrivateRecord(p.installation, "parent-adoptions", name, grant, true, grant.origin);
    }
    const binding = z
      .strictObject({ assertion: z.string() })
      .parse(
        readPrivateRecord(p.installation, "execution-parents", `${grant.child.operationKey}.json`),
      );
    if (binding.assertion !== assertion)
      throw Error("Incomplete/conflicting parent adoption binding");
  });
  const parent = Object.freeze(
    retainedControlParent(grant.parent),
  ) as import("../ops/execution-identity").VerifiedParentExecution;
  verifiedParents.add(parent);
  if (grant.origin) verifiedParentOrigins.set(parent, Object.freeze(grant.origin));
  return parent;
}

/** The child opens its ephemeral key, never the installation role private key. */
export function openFixedChildInstallation(options: {
  infraDir: string;
  assertion: string;
  container?: boolean;
}): ControlInstallation {
  const encoded = JSON.parse(Buffer.from(options.assertion, "base64url").toString("utf8")) as {
    leaseId?: unknown;
  };
  const envelope = encoded.leaseId
    ? parseControlAssertion(options.assertion)
    : parseParentAssertion(options.assertion);
  const id = "delegationId" in envelope ? envelope.delegationId : envelope.attemptId;
  const infra = options.container ? undefined : new AnchoredDirectory(options.infraDir);
  const secrets = options.container
    ? new AnchoredDirectory("/run/secrets", undefined, false, true)
    : (() => {
        if (!infra) throw Error("Missing fixed installation root");
        return infra.directory("secrets");
      })();
  let recovery: AnchoredDirectory | undefined;
  try {
    const bundle = bundleSchema.parse(
      JSON.parse(
        secrets
          .read(options.container ? "openmapx-control-verifiers" : "control-verifiers.json", 4096)
          .toString("utf8"),
      ),
    );
    if (bundle.installationId !== envelope.installationId)
      throw Error("Foreign fixed child installation");
    recovery = new AnchoredDirectory(
      options.container
        ? "/var/lib/openmapx/control-private"
        : join(options.infraDir, "control-private/ops-agent"),
      undefined,
      true,
    );
    const privateRelative = relative(
      realpathSync(join(options.infraDir, "data")),
      realpathSync(recovery.path),
    );
    if (!privateRelative || (!privateRelative.startsWith("../") && privateRelative !== ".."))
      throw Error("Fixed child recovery material is inside shared data");
    const children = recovery.directory("children");
    let saved: { publicKey: string; privateKey: string };
    try {
      saved = z
        .strictObject({ publicKey, privateKey: z.string().max(512) })
        .parse(JSON.parse(children.read(`${id}.key`, 2048).toString("utf8")));
    } finally {
      children.close();
    }
    const key = parsePrivate(saved.privateKey);
    if (
      createPublicKey(key).export({ type: "spki", format: "der" }).toString("base64url") !==
      saved.publicKey
    )
      throw Error("Fixed child key mismatch");
    const installation = Object.freeze({
      installationId: bundle.installationId,
      role: "ops-agent",
      publicKey: saved.publicKey,
    }) as ControlInstallation;
    installations.set(installation, {
      installation,
      privateKey: key,
      publicKeys: bundle.publicKeys,
      privateRoot: recovery,
      dataRoot: join(options.infraDir, "data"),
      registeredTargets: new Set(),
      fixedChildId: id,
      ...("attemptId" in envelope ? { fixedParentAssertion: options.assertion } : {}),
    });
    recovery = undefined;
    return installation;
  } finally {
    recovery?.close();
    secrets.close();
    infra?.close();
  }
}
export function retainFixedCliSpawnIntent(
  authority: VerifiedExecutionAuthority,
  input: {
    delegationId: string;
    execution: ExecutionRef;
    operation: unknown;
    args: readonly string[];
    plan?: readonly ControlPlannedChild[];
    reservations?: readonly ControlChildReservation[];
    dataUpdatePlan?: import("./data-update-records").DataUpdatePlan;
    dataWorkflowInitial?: import("../ops/job-evidence").DataWorkflowReceipt;
  },
): void {
  const s = executionAuthorityState(authority);
  const id = uuid.parse(input.delegationId);
  const operation = opsOperationSchema.parse(input.operation);
  const slot = [...s.plan, ...s.reservations].find(
    (p) => p.execution.executionId === input.execution.executionId && p.recipient === "fixed-cli",
  );
  const plan = slot
    ? resolveControlChildPlan(authority, {
        phase: slot.phase,
        execution: input.execution,
        recipient: "fixed-cli",
      })
    : undefined;
  if (
    !plan ||
    opsOperationFingerprint(operation) !== input.execution.operationFingerprint ||
    operation.kind !== plan.kind ||
    canonicalJson(fixedCliArguments(operation)) !== canonicalJson(input.args)
  )
    throw Error("Fixed command does not match retained child plan");
  writePrivateRecord(
    s.installation,
    "spawns",
    `${id}.json`,
    {
      execution: input.execution,
      operation,
      ...(input.dataUpdatePlan
        ? { dataUpdatePlan: dataUpdatePlanSchema.parse(input.dataUpdatePlan) }
        : {}),
      ...(input.dataWorkflowInitial
        ? { dataWorkflowInitial: dataWorkflowReceiptSchema.parse(input.dataWorkflowInitial) }
        : {}),
      args: input.args,
      serviceIds: plan.serviceIds,
      admittedAt: Date.now(),
      plan: z
        .array(plannedChildSchema)
        .max(64)
        .parse(input.plan ?? []),
      ...(input.reservations === undefined
        ? {}
        : {
            reservations: z.array(controlChildReservationSchema).max(64).parse(input.reservations),
          }),
    },
    true,
    s.origin,
  );
}
export function fixedCliArguments(operation: import("../ops/contract").OpsOperation): string[] {
  switch (operation.kind) {
    case "service.build":
      return [
        "services",
        "build",
        operation.serviceId,
        ...(operation.regionId ? ["--region", operation.regionId] : []),
      ];
    case "services.buildAll":
      return [
        "services",
        "build-all",
        ...(operation.regionId ? ["--region", operation.regionId] : []),
      ];
    case "service.start":
      return [
        "services",
        "start",
        operation.serviceId,
        "--expected-configuration-revision",
        operation.expectedConfigurationRevisionId,
      ];
    case "service.update":
      return [
        "services",
        "update",
        operation.serviceId,
        "--expected-configuration-revision",
        operation.expectedConfigurationRevisionId,
        ...(operation.noDeps ? ["--no-deps"] : []),
      ];
    case "data.link":
      return ["data", "link"];
    case "data.clean":
      return ["data", "clean", operation.dataTypeId];
    case "system.update":
      return ["services", "update"];
    case "data.update":
      return [
        "data",
        "update",
        ...(operation.regionId ? [operation.regionId] : []),
        ...(operation.countryCodes?.length
          ? ["--countries", operation.countryCodes.join(",")]
          : []),
        ...(operation.failFast ? ["--fail-fast"] : []),
      ];
    case "data.overtureConflate":
      return [
        "data",
        "overture-conflate",
        operation.regionId,
        ...(operation.restart ? ["--restart"] : []),
      ];
    case "data.downloadOsm":
      return ["data", "download", "osm", ...(operation.regionId ? [operation.regionId] : [])];
    case "data.downloadFonts":
      return ["data", "download", "fonts"];
    case "data.convertOverpass":
      return ["data", "convert", "overpass", ...(operation.regionId ? [operation.regionId] : [])];
    case "data.overtureSync":
      return ["data", "overture-sync", operation.regionId];
    case "data.overturePull":
      return ["data", "overture-pull", operation.regionId];
    case "data.overtureIngest":
      return ["data", "overture-ingest", operation.regionId];
    case "data.overtureExtract":
      return ["data", "overture-extract", operation.regionId];
    case "data.searchIndexBuild":
      return ["data", "search-index", "build", operation.regionId];
    case "data.notablePlacesBuild":
      return ["data", "notable-places", "build"];
    default:
      throw Error("This fixed CLI control consumer is unavailable");
  }
}
export function readFixedCliSpawnIntent(
  installation: ControlInstallation,
  execution: ExecutionRef,
  args: readonly string[],
) {
  const s = installationState(installation);
  if (!s.fixedChildId) throw Error("Fixed child authority required");
  const saved = z
    .strictObject({
      plan: z.array(plannedChildSchema).max(64),
      reservations: z.array(controlChildReservationSchema).max(64).optional(),
      execution: executionRefSchema,
      operation: opsOperationSchema,
      dataUpdatePlan: dataUpdatePlanSchema.optional(),
      dataWorkflowInitial: dataWorkflowReceiptSchema.optional(),
      args: z.array(z.string().max(4096)).max(64),
      serviceIds: targetSchema,
      admittedAt: z.number().int().nonnegative().safe(),
    })
    .parse(readPrivateRecord(s, "spawns", `${s.fixedChildId}.json`, 65536));
  if (
    controlDigest(execution) !== controlDigest(saved.execution) ||
    canonicalJson(args) !== canonicalJson(saved.args) ||
    canonicalJson(fixedCliArguments(saved.operation)) !== canonicalJson(saved.args) ||
    opsOperationFingerprint(saved.operation) !== execution.operationFingerprint
  )
    throw Error("Fixed CLI spawn identity/command mismatch");
  s.registeredTargets = new Set(saved.serviceIds);
  return saved;
}
/** Fixed helper enrollment from the original indexed role-signed launch. A
 * caller target list cannot enroll a child, and the role key remains masked. */
export function readConfigurationHandoffSpawnIntent(
  installation: ControlInstallation,
  execution: ExecutionRef,
  handoffId: string,
) {
  const s = installationState(installation),
    name = configurationHandoffRecordName(handoffId, "intent"),
    raw = readPrivateRecord(s, "observations", name),
    saved = verifyControl(
      s.publicKeys["ops-agent"],
      configurationHandoffRecordDomains.intent,
      raw,
      configurationHandoffIntentRecordSchema,
    );
  if (
    !s.fixedChildId ||
    installation.role !== "ops-agent" ||
    s.fixedChildId !== saved.delegationId ||
    installation.installationId !== saved.installationId ||
    installation.publicKey !== saved.helperPublicKey ||
    saved.operation.handoffId !== handoffId ||
    canonicalJson(saved.helper) !== canonicalJson(execution) ||
    execution.executor !== "host-cli" ||
    execution.operationFingerprint !==
      controlDigest({
        kind: "configuration-helper",
        handoffId,
        intentDigest: controlDigest(saved.operation),
      })
  )
    throw Error("Original configuration helper spawn required");
  verifyFamilyOwnedRecord(
    s,
    saved.origin,
    { scope: "private", namespace: "observations", container: "", name },
    canonicalJson(raw),
  );
  s.registeredTargets = new Set(saved.operation.serviceIds);
  return saved;
}
export function beginFixedCliExecution(
  installation: ControlInstallation,
  execution: ExecutionRef,
): void {
  const s = installationState(installation);
  if (!s.fixedChildId) throw Error("Fixed CLI authority required");
  const begin = () =>
    writePrivateRecord(
      s,
      "spawn-started",
      `${s.fixedChildId}.json`,
      { execution },
      true,
      retainedExecutionOrigin(s, execution),
    );
  if (s.fixedParentAssertion)
    withParentLifecycles(s, s.fixedParentAssertion, (forward) => {
      if (!forward) throw Error("Canceled/terminal parent prevents fixed CLI start");
      begin();
    });
  else begin();
}

/** Original agent-owned helper publication and its fixed-child committed
 * effect. Data only: no forward/adoption/lease authority is constructed. */
export function readCompletedConfigurationHandoff(
  installation: ControlInstallation,
  handoffId: string,
) {
  const state = installationState(installation);
  if (installation.role !== "ops-agent") throw Error("Original helper observer required");
  const intentName = configurationHandoffRecordName(handoffId, "intent"),
    intentRaw = readPrivateRecord(state, "observations", intentName),
    intent = verifyControl(
      state.publicKeys["ops-agent"],
      configurationHandoffRecordDomains.intent,
      intentRaw,
      configurationHandoffIntentRecordSchema,
    ),
    progressName = configurationHandoffRecordName(handoffId, "progress"),
    progressRaw = readPrivateRecord(state, "observations", progressName),
    progress = verifyControl(
      state.publicKeys["ops-agent"],
      configurationHandoffRecordDomains.progress,
      progressRaw,
      configurationHandoffProgressSchema,
    ),
    completionName = configurationHandoffRecordName(handoffId, "completion"),
    completionRaw = readPrivateRecord(state, "observations", completionName),
    completion = verifyControl(
      intent.helperPublicKey,
      configurationHandoffRecordDomains.completion,
      completionRaw,
      configurationHandoffWorkerRecordSchema,
    ),
    effectName = `${intent.helper.operationKey}.json`,
    effectRaw = readPrivateRecord(state, "effects", effectName, 65536),
    effect = verifyControl(
      intent.helperPublicKey,
      "openmapx-control-settlement-v1",
      effectRaw,
      settlementSchema.extend({ receipt: effectObservationSchema }),
    );
  for (const [namespace, name, raw] of [
    ["observations", intentName, intentRaw],
    ["observations", progressName, progressRaw],
    ["observations", completionName, completionRaw],
    ["effects", effectName, effectRaw],
  ] as const)
    verifyFamilyOwnedRecord(
      state,
      intent.origin,
      { scope: "private", namespace, container: "", name },
      canonicalJson(raw),
    );
  if (
    intent.installationId !== installation.installationId ||
    intent.operation.handoffId !== handoffId ||
    progress.intentDigest !== controlDigest(intent) ||
    progress.phase !== "launched" ||
    progress.launch.state !== "confirmed" ||
    completion.intentDigest !== controlDigest(intent) ||
    completion.preparationDigest !== controlDigest(progress) ||
    completion.phase !== "applied" ||
    !!intent.release !== !!completion.release ||
    (intent.release &&
      completion.release &&
      (completion.release.images.length !== intent.release.downloads.images.length ||
        completion.release.images.some(
          (image, index) =>
            image.image !== intent.release!.downloads.images[index]?.image ||
            image.reference !== intent.release!.downloads.images[index]?.reference ||
            image.phase !== "verified" ||
            !image.imageId,
        ))) ||
    completion.launch.containerId !== progress.launch.containerId ||
    canonicalJson(completion.execution) !== canonicalJson(intent.helper) ||
    canonicalJson(effect.identity) !== canonicalJson(intent.helper) ||
    effect.outcome !== "committed" ||
    effect.publication !== "committed" ||
    effect.receipt.kind !== "configuration-helper-completion" ||
    effect.receipt.completionDigest !== controlDigest(completion) ||
    effect.terminalReceiptDigest !== controlDigest(effect.receipt) ||
    completion.targets.length !== intent.operation.serviceIds.length ||
    completion.targets.some(
      (target) =>
        !intent.operation.serviceIds.includes(target.serviceId) ||
        target.expectedImageId !== intent.operation.expectedImageIdentities[target.serviceId] ||
        target.oldContainerId !==
          progress.targets.find((original) => original.serviceId === target.serviceId)
            ?.oldContainerId,
    )
  )
    throw Error("Original committed configuration helper required");
  const { receipt: _private, ...settlement } = effect;
  return { intent, completion, settlement };
}

const executionWitnessSchema = z.strictObject({
  version: z.union([z.literal(1), z.literal(2)]),
  origin: controlOriginSchema.optional(),
  installationId: uuid,
  execution: executionRefSchema,
  kind: z.string().max(128),
  serviceIds: targetSchema,
  authorityDigest: digest,
});
export function readControlExecutionWitness(
  state: InstallationState,
  execution: ExecutionRef,
  publicVerifier: string,
) {
  const d = executionWitnessDirectory(state, execution.executor);
  try {
    const witness = verifyControl(
      publicVerifier,
      originRecordDomain(
        "openmapx-control-execution-witness",
        JSON.parse(d.role.read(`${execution.operationKey}.json`, 65536).toString("utf8")),
      ),
      JSON.parse(d.role.read(`${execution.operationKey}.json`, 65536).toString("utf8")),
      executionWitnessSchema,
    );
    if (
      !validateOriginRecord(witness) ||
      witness.installationId !== state.installation.installationId ||
      controlDigest(witness.execution) !== controlDigest(execution)
    )
      throw Error("Durable parent execution witness mismatch");
    return witness;
  } finally {
    d.close();
  }
}
function publishControlExecutionWitness(
  state: InstallationState,
  input: {
    execution: ExecutionRef;
    kind: string;
    serviceIds: readonly string[];
    origin: ControlExecutionOrigin;
  },
  authorityDigest: string,
) {
  const d = executionWitnessDirectory(state, input.execution.executor, true);
  try {
    const witness = signControl(state.privateKey, "openmapx-control-execution-witness-v2", {
      version: 2 as const,
      origin: input.origin,
      installationId: state.installation.installationId,
      execution: input.execution,
      kind: input.kind,
      serviceIds: [...input.serviceIds],
      authorityDigest,
    });
    const name = `${input.execution.operationKey}.json`;
    try {
      const prior = JSON.parse(d.role.read(name, 65536).toString("utf8"));
      if (controlDigest(prior) !== controlDigest(witness))
        throw Error("Replaced execution witness");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      writeExecutionShared(
        state,
        input.execution,
        d.role,
        name,
        canonicalJson(witness),
        true,
        input.origin,
      );
    }
  } finally {
    d.close();
  }
}

/** Restore only the original signed durable admission; this grants no permission to redispatch. */
export function restoreAdmittedControlExecution(
  installation: ControlInstallation,
  execution: ExecutionRef,
): VerifiedExecutionAuthority {
  const state = installationState(installation);
  const raw = readPrivateRecord(state, "executions", `${execution.operationKey}.json`, 65536);
  const payload = verifyControl(
    installation.publicKey,
    originRecordDomain("openmapx-control-execution", raw),
    raw,
    z
      .object({
        version: z.union([z.literal(1), z.literal(2)]),
        installationId: uuid,
        execution: executionRefSchema,
        kind: z.string(),
        serviceIds: targetSchema,
        origin: controlOriginSchema.optional(),
        plan: z.array(plannedChildSchema).max(64),
        reservations: z.array(controlChildReservationSchema).max(64).optional(),
      })
      .passthrough(),
  );
  if (
    !validateOriginRecord(payload) ||
    payload.installationId !== installation.installationId ||
    controlDigest(payload.execution) !== controlDigest(execution)
  )
    throw Error("Recovery execution ownership mismatch");
  const authority = Object.freeze({ execution: payload.execution }) as VerifiedExecutionAuthority;
  authorities.set(authority, {
    installation: state,
    execution: payload.execution,
    kind: payload.kind,
    serviceIds: payload.serviceIds,
    plan: payload.plan,
    reservations: payload.reservations ?? [],
    receiptDigest: controlDigest(raw),
    origin: payload.origin,
  });
  return authority;
}
/** Fixed local continuation adapter: private signed admission, never a bare request identity. */
export function verifiedRetainedControlParent(
  installation: ControlInstallation,
  execution: ExecutionRef,
): import("../ops/execution-identity").VerifiedParentExecution {
  const authority = restoreAdmittedControlExecution(installation, execution);
  const s = executionAuthorityState(authority);
  const parent = Object.freeze(
    retainedControlParent(execution),
  ) as import("../ops/execution-identity").VerifiedParentExecution;
  verifiedParents.add(parent);
  if (s.origin) verifiedParentOrigins.set(parent, s.origin);
  return parent;
}
export function retainedControlAdoptionAssertion(
  installation: ControlInstallation,
  adoption: ControlAdoption,
  execution: ExecutionRef,
): string {
  const state = installationState(installation);
  const saved = z
    .object({ assertion: z.string().max(4096), execution: executionRefSchema })
    .parse(readPrivateRecord(state, "adoptions", `${uuid.parse(adoption.delegationId)}.json`));
  const assertion = parseControlAssertion(saved.assertion);
  if (
    assertion.leaseId !== adoption.leaseId ||
    assertion.delegationId !== adoption.delegationId ||
    controlDigest(saved.execution) !== controlDigest(execution)
  )
    throw Error("Recovery adoption ownership mismatch");
  return saved.assertion;
}

const preparedTerminalSchema = z.strictObject({
  version: z.literal(1),
  installationId: uuid,
  execution: executionRefSchema,
  kind: z.enum(["configurationMaintenance.prepare", "configurationHandoff.prepare"]),
  receiptDigest: digest,
});
/** Fixed preparing adapter calls only after publishing its terminal journal. This performs the read itself. */
export function retainControlPreparedTerminal(authority: VerifiedExecutionAuthority): void {
  const s = executionAuthorityState(authority);
  if (
    s.installation.fixedChildId ||
    s.execution.executor !== "ops-agent" ||
    !["configurationMaintenance.prepare", "configurationHandoff.prepare"].includes(s.kind)
  )
    throw Error("Unsupported terminal preparation");
  const data = new AnchoredDirectory(s.installation.dataRoot);
  let jobs: AnchoredDirectory | undefined;
  try {
    jobs = data.directory("ops-agent");
    const journal = z
      .object({ version: z.literal(2), jobs: z.array(z.unknown()).max(256) })
      .parse(JSON.parse(jobs.read("jobs-v1.json", 24 * 1024 * 1024).toString("utf8")));
    const matches = journal.jobs.filter(
      (j) =>
        j &&
        typeof j === "object" &&
        (j as { operationId?: string }).operationId === s.execution.executionId,
    );
    if (matches.length !== 1) throw Error("Missing exact terminal preparation journal");
    const job = z
      .object({
        operationId: z.string(),
        operationKey: z.string(),
        operationFingerprint: digest,
        fingerprint: digest,
        deadlineAt: z.number().int().safe(),
        state: z.literal("succeeded"),
        operation: z.object({ kind: z.string() }).passthrough(),
        result: z
          .object({
            phase: z.literal("prepared").optional(),
            state: z.literal("prepared").optional(),
          })
          .passthrough(),
        terminalAt: z.iso.datetime(),
      })
      .parse(matches[0]);
    if (
      job.operationKey !== s.execution.operationKey ||
      job.operationFingerprint !== s.execution.operationFingerprint ||
      job.fingerprint !== s.execution.fingerprint ||
      job.deadlineAt !== s.execution.deadlineAt ||
      job.operation.kind !== s.kind ||
      controlDigest(job.operation) !== s.execution.operationFingerprint ||
      !(job.result.phase === "prepared" || job.result.state === "prepared")
    )
      throw Error("Terminal preparation identity mismatch");
    const signed = signControl(
      s.installation.privateKey,
      "openmapx-control-prepared-v1",
      preparedTerminalSchema.parse({
        version: 1,
        installationId: s.installation.installation.installationId,
        execution: s.execution,
        kind: s.kind,
        receiptDigest: controlDigest(job),
      }),
    );
    writePrivateRecord(
      s.installation,
      "prepared",
      `${s.execution.operationKey}.json`,
      signed,
      true,
      s.origin,
    );
    const d = executionWitnessDirectory(s.installation, "ops-agent", true);
    try {
      writeExecutionShared(
        s.installation,
        s.execution,
        d.role,
        `${s.execution.operationKey}.prepared.json`,
        canonicalJson(signed),
        true,
      );
    } finally {
      d.close();
    }
  } finally {
    jobs?.close();
    data.close();
  }
}
export function verifyControlPreparedTerminal(
  state: InstallationState,
  execution: ExecutionRef,
): void {
  const d = executionWitnessDirectory(state, "ops-agent");
  try {
    const receipt = verifyControl(
      state.publicKeys["ops-agent"],
      "openmapx-control-prepared-v1",
      JSON.parse(d.role.read(`${execution.operationKey}.prepared.json`, 8192).toString("utf8")),
      preparedTerminalSchema,
    );
    if (
      receipt.installationId !== state.installation.installationId ||
      controlDigest(receipt.execution) !== controlDigest(execution)
    )
      throw Error("Foreign terminal preparation");
  } finally {
    d.close();
  }
}

/** Target acquisition observes only its original data-phase owner and all three
 * signed, physically settled DM children. No progress object is authority. */
export async function verifyDataUpdatePrerequisites(authority: VerifiedExecutionAuthority) {
  const s = executionAuthorityState(authority);
  if (s.kind !== "data.update" || s.installation.fixedChildId || !s.origin)
    throw Error("Original Full Update root required");
  const name = `data-update-plan-${s.execution.operationKey}.json`,
    raw = readPrivateRecord(s.installation, "observations", name, 128 * 1024);
  verifyFamilyOwnedRecord(
    s.installation,
    s.origin,
    { scope: "private", namespace: "observations", container: "", name },
    canonicalJson(raw),
  );
  const plan = verifyControl(
      s.installation.installation.publicKey,
      "openmapx-data-update-plan-v1",
      raw,
      dataUpdatePlanSchema,
    ),
    infraDir = dirname(s.installation.dataRoot);
  if (
    controlDigest(plan.parent) !== controlDigest(s.execution) ||
    opsOperationFingerprint(plan.operation) !== s.execution.operationFingerprint ||
    currentConfigurationGeneration(infraDir) !== plan.revisionId ||
    dataUpdateSourcesDigest(infraDir) !== plan.sourcesDigest
  )
    throw Error("Original Full Update sources changed");
  let childInstallation: ControlInstallation | undefined;
  try {
    let dataAuthority = authority;
    if (s.execution.executor === "ops-agent") {
      const attempt = lookupControlChildPhaseAttempt(authority, {
        phase: "data-workflow",
        ordinal: 0,
      });
      if (!attempt) throw Error("Full Update data phase not admitted");
      childInstallation = openFixedChildInstallation({
        infraDir,
        assertion: attempt.assertion,
        container: existsSync("/run/secrets/openmapx-control-verifiers"),
      });
      dataAuthority = restoreAdmittedControlExecution(childInstallation, attempt.execution);
      const settlement = childSettlementState(
        verifyControlEffectSettlement(childInstallation, attempt.execution),
      ).evidence;
      if (settlement.outcome !== "committed" || settlement.publication !== "committed")
        throw Error("Full Update data phase unsettled");
    }
    const dataState = executionAuthorityState(dataAuthority),
      receipt = readDataWorkflowProgress(dataAuthority);
    if (
      receipt.phase !== "build" ||
      receipt.children.length !== 3 ||
      receipt.children.some((c) => c.status !== "succeeded")
    )
      throw Error("Full Update data checkpoint missing");
    for (const [index, slot] of plan.dataChildren.entries()) {
      const bound = lookupControlChildPhase(dataAuthority, slot);
      if (!bound) throw Error("Full Update prerequisite missing");
      const child = receipt.children[index],
        witness = verifyDataControlTerminalWitness(
          dataState.installation.installation,
          bound.execution,
        );
      if (
        !child ||
        child.operationKey !== bound.execution.operationKey ||
        child.jobId !== bound.execution.executionId ||
        child.fingerprint !== bound.execution.fingerprint ||
        child.deadlineAt !== bound.execution.deadlineAt ||
        witness.status.status !== "ok" ||
        witness.status.publication !== "committed"
      )
        throw Error("Full Update prerequisite did not complete");
    }
    return receipt;
  } finally {
    if (childInstallation) closeControlInstallation(childInstallation);
  }
}

/** A signed progress file cannot mint success. Rejoin the actual original CLI
 * exit sources and DM settlements, and the exact generation they published. */
function verifyDataUpdateCompletionSource(
  authority: VerifiedExecutionAuthority,
  receipt: import("../ops/job-evidence").DataWorkflowReceipt,
) {
  const s = executionAuthorityState(authority);
  if (s.installation.fixedChildId || !s.origin) throw Error("Original Full Update root required");
  const name = `data-update-plan-${s.execution.operationKey}.json`,
    raw = readPrivateRecord(s.installation, "observations", name, 128 * 1024);
  verifyFamilyOwnedRecord(
    s.installation,
    s.origin,
    { scope: "private", namespace: "observations", container: "", name },
    canonicalJson(raw),
  );
  const plan = verifyControl(
      s.installation.installation.publicKey,
      "openmapx-data-update-plan-v1",
      raw,
      dataUpdatePlanSchema,
    ),
    infraDir = dirname(s.installation.dataRoot);
  if (
    controlDigest(plan.parent) !== controlDigest(s.execution) ||
    opsOperationFingerprint(plan.operation) !== s.execution.operationFingerprint ||
    receipt.revisionId !== plan.finalRevisionId ||
    currentConfigurationGeneration(infraDir) !== plan.finalRevisionId ||
    dataUpdateSourcesDigest(infraDir) !== plan.sourcesDigest
  )
    throw Error("Original Full Update completion sources changed");
  const checkData = (dataAuthority: VerifiedExecutionAuthority) => {
    const dataState = executionAuthorityState(dataAuthority);
    for (const [index, slot] of plan.dataChildren.entries()) {
      const bound = lookupControlChildPhase(dataAuthority, slot),
        child = receipt.children[index];
      if (
        !bound ||
        !child ||
        child.operationKey !== bound.execution.operationKey ||
        child.jobId !== bound.execution.executionId ||
        child.fingerprint !== bound.execution.fingerprint ||
        child.deadlineAt !== bound.execution.deadlineAt ||
        verifyDataControlTerminalWitness(dataState.installation.installation, bound.execution)
          .status.status !== "ok"
      )
        throw Error("Actual Full Update data completion required");
    }
  };
  if (s.execution.executor === "ops-agent") {
    for (const slot of [plan.dataReservation, plan.finalizationReservation]) {
      const attempt = lookupControlChildPhaseAttempt(authority, slot);
      if (!attempt) throw Error("Full Update fixed phase missing");
      const child = openFixedChildInstallation({
        infraDir,
        assertion: attempt.assertion,
        container: existsSync("/run/secrets/openmapx-control-verifiers"),
      });
      try {
        readFixedCliSpawnIntent(child, attempt.execution, fixedCliArguments(plan.operation));
        const childAuthority = restoreAdmittedControlExecution(child, attempt.execution),
          effect = childSettlementState(
            verifyControlEffectSettlement(child, attempt.execution),
          ).evidence;
        if (effect.outcome !== "committed" || effect.publication !== "committed")
          throw Error("Full Update fixed phase unsettled");
        const progress = readDataWorkflowProgress(childAuthority);
        if (slot.phase === "data-workflow") checkData(childAuthority);
        else if (canonicalJson(progress) !== canonicalJson(receipt))
          throw Error("Original Full Update final receipt changed");
      } finally {
        closeControlInstallation(child);
      }
    }
  } else {
    checkData(authority);
    for (const slot of plan.finalizationChildren) {
      const bound = lookupControlChildPhase(authority, slot);
      if (
        !bound ||
        verifyDataControlTerminalWitness(s.installation.installation, bound.execution).status
          .status !== "ok"
      )
        throw Error("Actual Full Update hardlink completion required");
    }
  }
}

/** Opaque local file version, never a public hash of a credential value. */
export function localFeedCredentialTemplateMac(
  installation: ControlInstallation,
  operation: unknown,
  contents?: string,
) {
  return localCredentialTemplateFileMac(installationState(installation), operation, contents);
}
