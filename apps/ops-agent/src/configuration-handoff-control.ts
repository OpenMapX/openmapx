/** The detached helper adopts only its original fixed child grant. It has an
 * ephemeral signing key, no installation role key and no root acquisition. */
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  ArtifactTargetJournalBusyError,
  adoptArtifactTargetLease,
  assertArtifactTargetLeaseExecution,
  assertConfigurationHandoffHostSources as assertHostSources,
  type BorrowedArtifactTargetLease,
  beginFixedCliExecution,
  bindBorrowedControlExecution,
  type ControlInstallation,
  closeArtifactTargetLeaseHandle,
  closeControlInstallation,
  controlDigest,
  executionAuthorityState,
  openFixedChildInstallation,
  readConfigurationHandoffSpawnIntent,
  readPrivateRecord,
  restoreAdmittedControlExecution,
  retainAdmittedControlExecution,
  retainControlEffectReceipt,
  settleRetainedConfigurationHandoffHelper,
  type VerifiedExecutionAuthority,
  verifiedParentForArtifactDelegation,
  verifyConfigurationHelperReady,
  verifyControl,
  verifyFamilyOwnedRecord,
  verifyFixedCliControlPeer,
} from "@openmapx/core/build-artifacts";
import { canonicalJson, type ExecutionRef, executionRefSchema } from "@openmapx/core/ops";
import {
  type ConfigurationHandoffIntentRecord,
  configurationHandoffRecordDomains,
  configurationHandoffRecordName,
  configurationHandoffWorkerRecordSchema,
} from "../../../packages/core/src/build-artifacts/configuration-handoff-records";
import { installationState } from "../../../packages/core/src/build-artifacts/control-authority";

declare const childBrand: unique symbol;
export type ConfigurationHandoffChild = Readonly<{ readonly [childBrand]: true }>;
const children = new WeakMap<
  ConfigurationHandoffChild,
  {
    installation: ControlInstallation;
    authority: VerifiedExecutionAuthority;
    lease: BorrowedArtifactTargetLease;
    intent: ConfigurationHandoffIntentRecord;
  }
>();
/** Parent terminal/copy publication can briefly own the authenticated source
 * index. Wait only around source reads, before adoption/forward writes. The
 * original deadline remains authoritative; no lock is removed or stolen. */
async function waitForHandoffSource<T>(execution: ExecutionRef, read: () => T): Promise<T> {
  const started = performance.now();
  for (;;) {
    try {
      return read();
    } catch (error) {
      const io = error as NodeJS.ErrnoException;
      const familyBusy =
        io.code === "EEXIST" &&
        io.syscall === "mkdir" &&
        !!io.path &&
        basename(io.path) === ".family-writer";
      if (
        (!familyBusy && !(error instanceof ArtifactTargetJournalBusyError)) ||
        Date.now() >= execution.deadlineAt ||
        performance.now() - started >= 5000
      )
        throw error;
      await delay(50);
    }
  }
}
function immutable<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}

export async function openConfigurationHandoffChild(input: {
  rootDir: string;
  handoffId: string;
  assertion: string;
  execution: ExecutionRef;
}): Promise<ConfigurationHandoffChild> {
  const execution = executionRefSchema.parse(input.execution),
    infraDir = join(input.rootDir, "infra/docker"),
    installation = openFixedChildInstallation({
      infraDir,
      assertion: input.assertion,
      container: existsSync("/run/secrets/openmapx-control-verifiers"),
    });
  let lease: BorrowedArtifactTargetLease | undefined;
  try {
    const intent = immutable(
      await waitForHandoffSource(execution, () =>
        readConfigurationHandoffSpawnIntent(installation, execution, input.handoffId),
      ),
    );
    if (
      intent.installationId !== installation.installationId ||
      intent.operation.handoffId !== input.handoffId ||
      intent.assertion !== input.assertion ||
      intent.helperPublicKey !== installation.publicKey ||
      canonicalJson(intent.helper) !== canonicalJson(execution)
    )
      throw Error("Original fixed helper launch required");
    const body = {
        kind: "configuration-helper",
        handoffId: input.handoffId,
        intentDigest: controlDigest(intent.operation),
      },
      { peer, parent } = await waitForHandoffSource(execution, () => ({
        peer: verifyFixedCliControlPeer(installation, {
          assertion: input.assertion,
          execution,
          kind: body.kind,
          recipient: "configuration-helper",
        }),
        parent: verifiedParentForArtifactDelegation(installation, input.assertion, execution),
      }));
    if (
      canonicalJson(parent.operationKey) !== canonicalJson(intent.preparer.operationKey) ||
      parent.fingerprint !== intent.preparer.fingerprint
    )
      throw Error("Original helper preparer required");
    lease = await adoptArtifactTargetLease({
      dataRoot: join(infraDir, "data"),
      assertion: input.assertion,
      peer,
      execution,
      serviceIds: intent.operation.serviceIds,
    });
    const authority = retainAdmittedControlExecution(installation, {
      execution,
      kind: body.kind,
      operation: body,
      admittedAt: intent.admittedAt,
      requestedDeadlineAt: intent.requestedDeadlineAt,
      parent,
      serviceIds: intent.operation.serviceIds,
    });
    bindBorrowedControlExecution(lease, authority);
    assertArtifactTargetLeaseExecution(lease, execution);
    beginFixedCliExecution(installation, execution);
    const child = Object.freeze({}) as ConfigurationHandoffChild;
    children.set(child, { installation, authority, lease, intent });
    return child;
  } catch (error) {
    if (lease) closeArtifactTargetLeaseHandle(lease);
    closeControlInstallation(installation);
    throw error;
  }
}
/** A completed original worker can repair only its receipt/physical leaf. An
 * unfinished attempted worker must never become another forward execution. */
export async function reconcileCompletedConfigurationHandoff(input: {
  rootDir: string;
  handoffId: string;
  assertion: string;
  execution: ExecutionRef;
}): Promise<"applied" | null> {
  const execution = executionRefSchema.parse(input.execution),
    installation = openFixedChildInstallation({
      infraDir: join(input.rootDir, "infra/docker"),
      assertion: input.assertion,
      container: existsSync("/run/secrets/openmapx-control-verifiers"),
    });
  try {
    const intent = await waitForHandoffSource(execution, () =>
        readConfigurationHandoffSpawnIntent(installation, execution, input.handoffId),
      ),
      state = installationState(installation),
      file = configurationHandoffRecordName(input.handoffId, "completion");
    if (intent.assertion !== input.assertion) throw Error("Original helper assertion required");
    let raw: unknown;
    try {
      raw = readPrivateRecord(state, "observations", file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const worker = verifyControl(
      installation.publicKey,
      configurationHandoffRecordDomains.completion,
      raw,
      configurationHandoffWorkerRecordSchema,
    );
    await waitForHandoffSource(execution, () =>
      verifyFamilyOwnedRecord(
        state,
        intent.origin,
        { scope: "private", namespace: "observations", container: "", name: file },
        canonicalJson(raw),
      ),
    );
    if (worker.phase !== "applied" || canonicalJson(worker.execution) !== canonicalJson(execution))
      throw Error("Unfinished original helper remains fenced");
    const authority = restoreAdmittedControlExecution(installation, execution);
    retainControlEffectReceipt(authority, {
      outcome: "committed",
      publication: "committed",
      receipt: { kind: "configuration-helper-completion", completionDigest: controlDigest(worker) },
    });
    await settleRetainedConfigurationHandoffHelper(authority);
    return "applied";
  } finally {
    closeControlInstallation(installation);
  }
}
export function configurationHandoffChildState(child: ConfigurationHandoffChild) {
  const state = children.get(child);
  if (!state) throw Error("Original nominal helper required");
  executionAuthorityState(state.authority);
  return state;
}
export function assertConfigurationHandoffHostSources(child: ConfigurationHandoffChild): void {
  const state = configurationHandoffChildState(child);
  verifyConfigurationHelperReady(state.lease);
  assertHostSources(state.authority);
}
export async function waitForConfigurationHandoffPreparation(
  child: ConfigurationHandoffChild,
  signal: AbortSignal,
): Promise<void> {
  const { lease, intent } = configurationHandoffChildState(child);
  for (;;) {
    signal.throwIfAborted();
    if (Date.now() >= intent.helper.deadlineAt) throw Error("Original helper deadline expired");
    try {
      verifyConfigurationHelperReady(lease);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await new Promise<void>((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", aborted);
      };
      const aborted = () => {
        done();
        reject(signal.reason);
      };
      const timer = setTimeout(() => {
        done();
        resolve();
      }, 100);
      signal.addEventListener("abort", aborted, { once: true });
      if (signal.aborted) aborted();
    });
  }
}
export function closeConfigurationHandoffChild(child: ConfigurationHandoffChild): void {
  const state = configurationHandoffChildState(child);
  children.delete(child);
  closeArtifactTargetLeaseHandle(state.lease);
  closeControlInstallation(state.installation);
}
