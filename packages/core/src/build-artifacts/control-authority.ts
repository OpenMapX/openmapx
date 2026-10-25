import {
  type ControlInstallation,
  controlDigest,
  controlOriginSchema,
  digest,
  type InstallationState,
  originRecordDomain,
  sameControlOrigin,
  signControl,
  uuid,
  validateOriginRecord,
  verifyControl,
} from "./control-records";

export {
  type ControlInstallation,
  controlDigest,
  controlOriginSchema,
  digest,
  type InstallationState,
  originRecordDomain,
  sameControlOrigin,
  signControl,
  uuid,
  validateOriginRecord,
  verifyControl,
} from "./control-records";

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  randomUUID,
} from "node:crypto";
import { existsSync, fsyncSync, mkdirSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";
import { z } from "zod";
import {
  type OpsJobStatus,
  type OpsOperationKind,
  opsOperationSchema,
  parseBoundedOpsResult,
  parseOpsJobStatus,
} from "../ops/contract";
import {
  controlTerminalReceiptDigest,
  verifyApiRetentionProof,
} from "../ops/control-retention-receipt";
import { type ControlExecutionOrigin, parseControlRootOperationKey } from "../ops/control-root-key";
import {
  type ControlIssuer,
  type ExecutionRef,
  executionFingerprint,
  executionRefSchema,
  opsExecutionMaximumMs,
  type RetainedParentExecution,
} from "../ops/execution-identity";
import { canonicalJson, opsOperationFingerprint } from "../ops/fingerprint";
import { verifiedParentOrigins, verifiedParents } from "../ops/verified-parent-internal";
import { CONTROL_RETENTION_LIMITS, writeRetainedRecord } from "./control-retention";
import { AnchoredDirectory, identity } from "./filesystem";
import {
  assertOriginClockForward,
  bootstrapRetentionClock,
  readRetentionClock,
} from "./retention-clock";
import {
  acknowledgeRetentionDependency,
  completeFamilyJournal,
  enlistFamilyIntent,
  familyRecordWrite,
  hasLocalRetentionFamily,
  hasRetentionEvidence,
  markFamilyTerminal,
  reconcileRetentionFamilies,
  registerFamilyExecution,
  requireFamilyJournal,
  retentionApiDependency,
} from "./retention-family";
export const CONTROL_ROLES = ["ops-agent", "data-manager", "host-cli"] as const;
export type ControlRecipient = "fixed-cli" | "data-manager" | "ops-agent" | "configuration-helper";
export type ControlChildPhase =
  | "lifecycle"
  | "build"
  | "data-link"
  | "data-clean"
  | "data-workflow"
  | "hardlinks"
  | "stop-primary"
  | "stop-staging"
  | "restart-staging"
  | "promote-primary"
  | "recover-primary"
  | "proxy-stage"
  | "proxy-commit"
  | "proxy-restore"
  | "paired-pin-commit"
  | "configuration-fence"
  | "configuration-fence-settle"
  | "configuration-commit"
  | "maintenance-hardlinks"
  | "maintenance-recreate"
  | "maintenance-handoff"
  | "osm"
  | "transit"
  | "fonts"
  | "data-step"
  | "configuration-handoff";
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
export const targetSchema = z
  .array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/))
  .min(1)
  .max(256)
  .refine(
    (x) => x.every((v, i) => i === 0 || (x[i - 1] ?? v) < v),
    "Targets must be sorted and unique",
  );
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
export const childPhaseKinds: Readonly<Record<ControlChildPhase, readonly string[]>> = {
  lifecycle: ["service.start", "system.update"],
  build: ["service.build", "services.buildAll"],
  "data-link": ["data.link", "configuration.hardlinks.apply"],
  "data-clean": ["data.clean"],
  "data-workflow": [
    "data.update",
    "data.downloadOsm",
    "data.downloadFonts",
    "data.convertOverpass",
    "data.overtureSync",
    "data.overtureConflate",
    "data.searchIndexBuild",
    "data.notablePlacesBuild",
  ],
  hardlinks: ["generation-hardlinks"],
  "stop-primary": ["motis.primary.stop"],
  "stop-staging": ["motis.staging.stop"],
  "restart-staging": ["motis.staging.restart"],
  "promote-primary": ["motis.primary.promote"],
  "recover-primary": ["motis.primary.restart"],
  "proxy-stage": ["feedProxy.validateAndReload"],
  "proxy-commit": ["feedProxy.validateAndReload"],
  "proxy-restore": ["feedProxy.validateAndReload"],
  "paired-pin-commit": ["transitousLock.approve"],
  "configuration-fence": ["configuration-maintenance.prepare"],
  "configuration-fence-settle": ["configuration-maintenance.settle"],
  "configuration-commit": [
    "stack.render",
    "serviceSelection.apply",
    "serviceConfig.apply",
    "integrationConfig.apply",
    "vault.apply",
  ],
  "maintenance-hardlinks": ["configuration.hardlinks.apply"],
  "maintenance-recreate": ["service.recreate", "service.recreateIsolated"],
  "maintenance-handoff": ["configurationHandoff.prepare"],
  osm: ["download-osm"],
  transit: ["transit-sync"],
  fonts: ["download-fonts"],
  "data-step": [
    "download-osm",
    "download-fonts",
    "convert-overpass",
    "overture-sync",
    "overture-conflate",
    "search-index-build",
    "notable-places-build",
  ],
  "configuration-handoff": ["configuration-helper"],
};
export function controlChildOperationKey(
  parentKey: string,
  phase: ControlChildPhase,
  ordinal: number,
): string {
  if (
    !/^opk1_[A-Za-z0-9_-]{16,64}$/.test(parentKey) ||
    !Number.isSafeInteger(ordinal) ||
    ordinal < 0 ||
    ordinal > 63 ||
    !Object.hasOwn(childPhaseKinds, phase)
  )
    throw Error("Invalid fixed phase key");
  return `opk1_${createHash("sha256").update(`openmapx-control-child-v1\0${parentKey}\0${phase}\0${ordinal}`).digest("base64url").slice(0, 32)}`;
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
    if (Buffer.byteLength(bytes) > 131072) throw Error("Private receipt limit");
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
export function retainControlTerminalStatus(
  installation: ControlInstallation,
  execution: ExecutionRef,
  status: OpsJobStatus,
): void {
  const authority = restoreAdmittedControlExecution(installation, execution),
    s = executionAuthorityState(authority);
  if (
    !s.origin ||
    status.operationId !== execution.executionId ||
    status.operationKey !== execution.operationKey ||
    status.fingerprint !== execution.fingerprint ||
    status.deadlineAt !== execution.deadlineAt ||
    status.kind !== s.kind
  )
    throw Error("Terminal control receipt identity conflict");
  const digest = controlTerminalReceiptDigest(status);
  const settlement = childSettlementState(verifyControlEffectSettlement(installation, execution));
  markFamilyTerminal(
    s.installation,
    s.origin,
    execution,
    settlement.evidence.outcome !== "unknown" &&
      (status.state === "succeeded" || settlement.evidence.publication !== "committed"),
    digest,
  );
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
    if (!succeeded && !failedWithoutEffect)
      throw Error("Terminal worker containment is not proved");
    markFamilyTerminal(
      s.installation,
      origin,
      execution,
      true,
      controlTerminalReceiptDigest(terminal),
      terminalAt,
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
export function controlRegisteredServiceIds(installation: ControlInstallation): string[] {
  return [...installationState(installation).registeredTargets].sort();
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
      "overture-conflate",
      "search-index-build",
      "notable-places-build",
      "catalog.activate",
      "catalog.validate",
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
  const plan = z
    .array(plannedChildSchema)
    .max(64)
    .parse(input.plan ?? []);
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
  if (plan.length > 64) throw Error("Control child intent capacity");
  const keys = new Set<string>();
  for (const [ordinal, child] of plan.entries()) {
    executionRefSchema.parse(child.execution);
    targetSchema.parse(child.serviceIds);
    if (
      child.ordinal !== ordinal ||
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
    if (controlDigest(oldInput) !== controlDigest({ ...input, execution, serviceIds, plan }))
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
  registerFamilyExecution(state, origin, execution, controlDigest(receipt), input.parent);
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
  publishControlExecutionWitness(
    state,
    { execution, kind: input.kind, serviceIds, origin },
    controlDigest(receipt),
  );
  initializeLifecycle(state, execution, newlyAdmitted);
  const authority = Object.freeze({ execution }) as VerifiedExecutionAuthority;
  authorities.set(authority, {
    installation: state,
    execution,
    kind: input.kind,
    serviceIds,
    plan,
    receiptDigest: controlDigest(receipt),
    origin,
  });
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
    if (ids.length >= Math.min(64, s.plan.length) || ids.includes(delegationId))
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
  z.strictObject({ kind: z.literal("ops-result"), result: z.unknown() }),
  z.strictObject({
    kind: z.literal("fixed-cli-exit"),
    args: z.array(z.string().max(256)).max(64),
    exitCode: z.literal(0),
  }),
  z.strictObject({ kind: z.literal("not-started") }),
  z.strictObject({ kind: z.literal("unresolved") }),
]);
function withPrivateEffectWriter(s: AuthorityState, write: () => void): void {
  const guards = s.installation.privateRoot.directory("effect-writers", true, true);
  try {
    const name = s.execution.operationKey;
    mkdirSync(guards.name(name), { mode: 0o700 });
    fsyncSync(guards.fd);
    const guard = guards.directory(name);
    const held = identity(guard.stat);
    try {
      write();
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
/** Fixed executor adapters supply their parsed result or exact fixed-command exit; arbitrary text is never proof. */
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
      publication: ChildSettlement["publication"] = "unknown";
    if (receipt.kind === "ops-result") {
      receipt.result = parseBoundedOpsResult(s.kind as OpsOperationKind, receipt.result);
      const result = receipt.result as { outcome?: string };
      if (!result.outcome || ["applied", "unchanged", "committed"].includes(result.outcome)) {
        outcome = "committed";
        publication = "committed";
      }
    } else if (receipt.kind === "fixed-cli-exit") {
      if (!s.installation.fixedChildId)
        throw Error("Fixed command receipt requires certified child");
      readFixedCliSpawnIntent(s.installation.installation, s.execution, receipt.args);
      readPrivateRecord(s.installation, "spawn-started", `${s.installation.fixedChildId}.json`);
      outcome = "committed";
      publication = "committed";
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
          );
        return;
      }
      const prior = verifyControl(
        s.installation.installation.publicKey,
        "openmapx-control-settlement-v1",
        raw,
        settlementSchema.extend({ receipt: effectObservationSchema }),
      );
      if (controlDigest(prior) === controlDigest(payload)) return;
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
const lifecycleSchema = z.strictObject({
  version: z.literal(1),
  installationId: uuid,
  execution: executionRefSchema,
  sequence: z.number().int().nonnegative().safe(),
  phase: z.enum(["held", "cancel_pending", "recovery_required", "settled"]),
  childIntents: z.record(uuid, digest),
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
    Object.keys(current.childIntents).length > 64
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
        throw Error(
          "Execution cannot restart effects; observation/settlement only; forward phase fenced",
        );
      return run();
    });
  const assertion = retainedParentAssertion(s);
  return assertion
    ? withParentLifecycles(s.installation, assertion, (forward) => {
        if (!forward) throw Error("Canceled/terminal ancestor permits observation only");
        return check();
      })
    : check();
}
export function assertControlExecutionForward(authority: VerifiedExecutionAuthority): void {
  withControlExecutionForward(authority, () => {});
}
/** Only the protocol's frozen terminal preparation edges may outlive their local worker. */
export function assertControlDelegationForward(
  authority: VerifiedExecutionAuthority,
  phase: ControlChildPhase,
): void {
  try {
    assertControlExecutionForward(authority);
  } catch (error) {
    const s = executionAuthorityState(authority);
    if (
      !(
        (s.kind === "configurationMaintenance.prepare" &&
          [
            "configuration-commit",
            "maintenance-hardlinks",
            "maintenance-recreate",
            "maintenance-handoff",
          ].includes(phase)) ||
        (s.kind === "configurationHandoff.prepare" && phase === "configuration-handoff")
      )
    )
      throw error;
    withExecutionWriter(s.installation, s.execution, (dir) => {
      const lifecycle = readLifecycle(
        s.installation,
        dir,
        s.execution,
        s.installation.installation.publicKey,
      );
      if (lifecycle.phase !== "settled" || Date.now() >= s.execution.deadlineAt) throw error;
      verifyControlPreparedTerminal(s.installation, s.execution);
    });
  }
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
    return Object.freeze(
      Object.keys(lifecycle.childIntents).map((id) => {
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
      }),
    );
  });
}
function settleExecutionLifecycle(s: AuthorityState) {
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
  const plan = s.plan.find(
    (p) =>
      controlDigest(p.execution) === controlDigest(child.execution) &&
      p.phase === child.phase &&
      p.recipient === child.recipient,
  );
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
  const issue = () =>
    withExecutionWriter(s.installation, s.execution, (dir) => {
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
      if (Object.keys(witness).length >= 64) throw Error("Parent attempt capacity");
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
  const inherited = retainedParentAssertion(s);
  return inherited
    ? withParentLifecycles(s.installation, inherited, (forward) => {
        if (!forward) throw Error("Canceled ancestor prevents forward delegation");
        return issue();
      })
    : issue();
}

function readParentGrant(
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
function verifyDeadlineEdge(
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
  },
): void {
  const s = executionAuthorityState(authority);
  const id = uuid.parse(input.delegationId);
  const operation = opsOperationSchema.parse(input.operation);
  const plan = s.plan.find(
    (p) =>
      controlDigest(p.execution) === controlDigest(input.execution) && p.recipient === "fixed-cli",
  );
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
      args: input.args,
      serviceIds: plan.serviceIds,
      admittedAt: Date.now(),
      plan: z
        .array(plannedChildSchema)
        .max(64)
        .parse(input.plan ?? []),
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
      return ["services", "start", operation.serviceId];
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
      execution: executionRefSchema,
      operation: opsOperationSchema,
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
