import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
/** Fixed original-owner helper journal. All cells stay in the existing indexed
 * role-private observations namespace and original retention family. */
import {
  assertArtifactTargetLeaseForward,
  bindControlChildPhase,
  closeControlInstallation,
  consumeControlChildDispatch,
  controlDigest,
  controlRolePublicKey,
  executionAuthorityState,
  inspectArtifactDelegation,
  issueControlChildPhase,
  lookupControlChildPhaseAttempt,
  lookupControlChildPhaseBinding,
  openFixedChildInstallation,
  prepareFixedControlChild,
  readPrivateRecord,
  signControl,
  type VerifiedExecutionAuthority,
  verifyControl,
  verifyFamilyOwnedRecord,
  writePrivateRecord,
} from "@openmapx/core/build-artifacts";
import {
  canonicalJson,
  configurationHandoffPrepareOperationSchema,
  type OpsOperation,
} from "@openmapx/core/ops";
import {
  type ConfigurationHandoffIntentRecord,
  type ConfigurationHandoffProgress,
  configurationHandoffIntentRecordSchema,
  configurationHandoffProgressSchema,
  configurationHandoffRecordDomains as domains,
  configurationHandoffRecordName as recordName,
} from "../../../packages/core/src/build-artifacts/configuration-handoff-records";
import {
  CONFIGURATION_HANDOFF_LABEL,
  configurationHandoffRunArgs,
  inspectConfigurationHandoffPrerequisite,
} from "./configuration-handoff";
import { assertOwnedMaintenanceHandoffRuntime } from "./configuration-maintenance-store";
import { type OpsExecutionContext, OpsExecutionFailure, type OpsRuntime } from "./runtime";

declare const preparedBrand: unique symbol;
export type PreparedConfigurationHandoff = Readonly<{ readonly [preparedBrand]: true }>;
const prepared = new WeakMap<
  PreparedConfigurationHandoff,
  {
    authority: VerifiedExecutionAuthority;
    intent: ConfigurationHandoffIntentRecord;
    facts: Awaited<ReturnType<typeof inspectConfigurationHandoffPrerequisite>>;
    dispatchTicket?: Awaited<ReturnType<typeof issueControlChildPhase>>["dispatchTicket"];
  }
>();
const bytes = (value: unknown) => canonicalJson(value);
function immutable<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}
function indexed(authority: VerifiedExecutionAuthority, name: string, raw: unknown) {
  const local = executionAuthorityState(authority);
  if (!local.origin) throw Error("Original handoff family required");
  verifyFamilyOwnedRecord(
    local.installation,
    local.origin,
    { scope: "private", namespace: "observations", container: "", name },
    bytes(raw),
  );
}
function readIntent(authority: VerifiedExecutionAuthority, handoffId: string) {
  const local = executionAuthorityState(authority),
    name = recordName(handoffId, "intent"),
    raw = readPrivateRecord(local.installation, "observations", name),
    value = verifyControl(
      controlRolePublicKey(local.installation.installation, "ops-agent"),
      domains.intent,
      raw,
      configurationHandoffIntentRecordSchema,
    );
  indexed(authority, name, raw);
  if (
    value.preparerAdmissionDigest !== local.receiptDigest ||
    bytes(value.preparer) !== bytes(local.execution) ||
    bytes(value.origin) !== bytes(local.origin)
  )
    throw Error("Original handoff preparer changed");
  return value;
}
function writeProgress(
  authority: VerifiedExecutionAuthority,
  intent: ConfigurationHandoffIntentRecord,
  value: ConfigurationHandoffProgress,
  exclusive = false,
) {
  const local = executionAuthorityState(authority);
  const progress = configurationHandoffProgressSchema.parse(value);
  if (progress.intentDigest !== controlDigest(intent))
    throw Error("Original handoff intent required");
  writePrivateRecord(
    local.installation,
    "observations",
    recordName(intent.operation.handoffId, "progress"),
    signControl(local.installation.privateKey, domains.progress, progress),
    exclusive,
    intent.origin,
  );
}
/** Only the real borrowed typed phase can produce this nominal launch. The
 * old image prerequisite and original generation/guard source are checked
 * before key/grant publication; no new target root is acquired. */
export async function prepareConfigurationHandoffLaunch(
  runtime: OpsRuntime,
  inputOperation: Extract<OpsOperation, { kind: "configurationHandoff.prepare" }>,
  context: OpsExecutionContext,
): Promise<PreparedConfigurationHandoff> {
  const operation = immutable(configurationHandoffPrepareOperationSchema.parse(inputOperation)),
    authority = context.controlAuthority,
    lease = context.artifactLease;
  if (!authority || !lease) throw Error("Actual original borrowed maintenance handoff required");
  const owned = await assertOwnedMaintenanceHandoffRuntime(runtime, operation, context),
    local = executionAuthorityState(authority),
    agent = owned.owner.originalContainers.find((value) => value.serviceId === "ops-agent");
  if (!agent || agent.state !== "running" || !owned.source.rootDir)
    throw Error("Original running agent required");
  const facts = await inspectConfigurationHandoffPrerequisite({
    runDocker: async (args, command) =>
      (
        await owned.source.execFile("docker", args, {
          signal: command.signal,
          timeout: 15000,
          maxBuffer: 65536,
        })
      ).stdout,
    containerId: agent.containerId,
    imageId: agent.provenance.imageId,
    rootDir: owned.source.rootDir,
    signal: context.signal,
  });
  const marker = Object.freeze({}) as PreparedConfigurationHandoff;
  try {
    const original = readIntent(authority, operation.handoffId);
    if (bytes(original.operation) !== bytes(operation))
      throw Error("Original handoff body changed");
    // A retained grant/launch is observation-only. No fresh one-use ticket or
    // another container create can be reconstructed from its identifiers.
    prepared.set(
      marker,
      Object.freeze({ authority, intent: immutable(original), facts: immutable(facts) }),
    );
    return marker;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const targets = operation.serviceIds.map((serviceId) => {
    const old = owned.owner.originalContainers.find((value) => value.serviceId === serviceId);
    if (!old || old.provenance.imageId !== operation.expectedImageIdentities[serviceId])
      throw Error("Original handoff container/image required");
    return {
      serviceId,
      phase: "pending" as const,
      oldContainerId: old.containerId,
      newContainerId: null,
      expectedImageId: old.provenance.imageId,
    };
  });
  context.signal.throwIfAborted();
  const reservation = owned.owner.plan.nestedHandoff!;
  if (lookupControlChildPhaseAttempt(authority, reservation))
    throw Error("Attempted helper without original launch intent requires recovery");
  const bound = await bindControlChildPhase(authority, reservation),
    publicKey = prepareFixedControlChild(authority, randomUUID()),
    issued = await issueControlChildPhase(authority, {
      phase: "configuration-handoff",
      ordinal: 0,
      childPublicKey: publicKey,
      lease,
    }),
    attempt = lookupControlChildPhaseAttempt(authority, reservation),
    binding = lookupControlChildPhaseBinding(authority, reservation);
  if (
    !attempt ||
    !binding ||
    attempt.channel !== "delegation" ||
    attempt.assertion !== issued.assertion
  )
    throw Error("Original retained helper grant required");
  const observed = inspectArtifactDelegation({
    dataRoot: local.installation.dataRoot,
    installation: local.installation.installation,
    assertion: attempt.assertion,
  });
  if (
    bytes(observed.execution) !== bytes(bound.execution) ||
    observed.recipient !== "configuration-helper" ||
    observed.ownerCertificateDigest !== owned.owner.rootCertificateDigest ||
    bytes(observed.owner) !== bytes(owned.owner.plan.prepare)
  )
    throw Error("Original helper target ownership changed");
  const child = openFixedChildInstallation({
    infraDir: owned.source.stack.infraDir,
    assertion: attempt.assertion,
    container: existsSync("/run/secrets/openmapx-control-verifiers"),
  });
  let helperPublicKey: string;
  try {
    helperPublicKey = child.publicKey;
  } finally {
    closeControlInstallation(child);
  }
  const intent = configurationHandoffIntentRecordSchema.parse({
    version: 1,
    installationId: local.installation.installation.installationId,
    origin: local.origin,
    ownerPrepare: owned.owner.plan.prepare,
    preparer: local.execution,
    helper: bound.execution,
    admittedAt: binding.boundAt,
    requestedDeadlineAt: binding.requestedDeadlineAt,
    operation,
    helperPublicKey,
    preparerAdmissionDigest: local.receiptDigest,
    ownerCertificateDigest: owned.owner.rootCertificateDigest,
    leaseId: observed.leaseId,
    delegationId: observed.delegationId,
    assertion: attempt.assertion,
    helperContainerName: `openmapx-configuration-handoff-${operation.handoffId}`,
    preparedAt: Date.now(),
  });
  writePrivateRecord(
    local.installation,
    "observations",
    recordName(operation.handoffId, "intent"),
    signControl(local.installation.privateKey, domains.intent, intent),
    true,
    owned.owner.origin,
  );

  writeProgress(
    authority,
    intent,
    {
      version: 1,
      intentDigest: controlDigest(intent),
      sequence: 0,
      phase: "prepared",
      launch: { state: "not_attempted", containerId: null },
      targets,
      updatedAt: Date.now(),
      completedAt: null,
    },
    true,
  );
  prepared.set(
    marker,
    Object.freeze({
      authority,
      intent: immutable(intent),
      facts: immutable(facts),
      dispatchTicket: issued.dispatchTicket,
    }),
  );
  return marker;
}
export function preparedConfigurationHandoffState(value: PreparedConfigurationHandoff) {
  const state = prepared.get(value);
  if (!state) throw Error("Original nominal handoff required");
  const observed = readIntent(state.authority, state.intent.operation.handoffId);
  if (bytes(observed) !== bytes(state.intent)) throw Error("Original handoff launch changed");
  return state;
}

export function assertPreparedConfigurationHandoff(
  authority: VerifiedExecutionAuthority,
  result: unknown,
): void {
  const local = executionAuthorityState(authority);
  if (local.kind !== "configurationHandoff.prepare")
    throw Error("Original handoff preparation required");
  const body = result as { handoffId?: string; phase?: string } | null;
  if (!body || body.phase !== "prepared" || !body.handoffId)
    throw Error("Original prepared result required");
  const intent = readIntent(authority, body.handoffId),
    progress = readProgress(authority, intent);
  if (progress.phase !== "launched" || progress.launch.state !== "confirmed")
    throw Error("Original confirmed helper launch required");
}

function readProgress(
  authority: VerifiedExecutionAuthority,
  intent: ConfigurationHandoffIntentRecord,
) {
  const local = executionAuthorityState(authority),
    name = recordName(intent.operation.handoffId, "progress"),
    raw = readPrivateRecord(local.installation, "observations", name),
    value = verifyControl(
      local.installation.installation.publicKey,
      domains.progress,
      raw,
      configurationHandoffProgressSchema,
    );
  indexed(authority, name, raw);
  if (
    value.intentDigest !== controlDigest(intent) ||
    bytes(value.targets.map((target) => target.serviceId).sort()) !==
      bytes(intent.operation.serviceIds)
  )
    throw Error("Original handoff progress changed");
  return value;
}

/** First dispatch alone consumes the original helper ticket. Once launch intent
 * is durable, every recovery only inspects the deterministic container. */
export async function launchPreparedConfigurationHandoff(
  runtime: OpsRuntime,
  operation: Extract<OpsOperation, { kind: "configurationHandoff.prepare" }>,
  context: OpsExecutionContext,
) {
  const marker = await prepareConfigurationHandoffLaunch(runtime, operation, context),
    state = preparedConfigurationHandoffState(marker),
    { authority, intent } = state,
    source = (await assertOwnedMaintenanceHandoffRuntime(runtime, operation, context)).source;
  let progress = readProgress(authority, intent);
  const inspect = async () => {
    const result = await source.execFile(
      "docker",
      ["container", "inspect", "--format", "{{json .}}", intent.helperContainerName],
      {
        signal: context.signal,
        timeout: 15000,
        maxBuffer: 65536,
      },
    );
    const value = JSON.parse(result.stdout) as {
      Id?: string;
      Image?: string;
      Config?: { Labels?: Record<string, string> };
    };
    if (
      !value ||
      !/^[a-f0-9]{64}$/.test(value.Id ?? "") ||
      value.Image !== state.facts.imageId ||
      value.Config?.Labels?.[CONFIGURATION_HANDOFF_LABEL] !== operation.handoffId
    )
      throw Error("Original helper container required");
    return value.Id!;
  };
  if (progress.launch.state === "not_attempted") {
    if (!state.dispatchTicket) throw new OpsExecutionFailure("recovery_required", {});
    context.signal.throwIfAborted();
    assertArtifactTargetLeaseForward(context.artifactLease!);
    // Source and target verification precede this durable one-use launch marker.
    progress = {
      ...progress,
      sequence: progress.sequence + 1,
      phase: "launch_attempted",
      launch: { state: "attempted", containerId: null },
      updatedAt: Date.now(),
    };
    writeProgress(authority, intent, progress);
    consumeControlChildDispatch(state.dispatchTicket);
    prepared.set(marker, Object.freeze({ authority, intent, facts: state.facts }));
    try {
      await source.execFile(
        "docker",
        configurationHandoffRunArgs(state.facts, source.rootDir!, {
          handoffId: operation.handoffId,
          assertion: intent.assertion,
          execution: intent.helper,
        }),
        { signal: context.signal, timeout: 30000, maxBuffer: 65536 },
      );
    } catch {
      // A lost create response is resolved by the exact name/label/image below;
      // no second run is permitted, including after a process replacement.
    }
  }
  let containerId: string;
  try {
    containerId = await inspect();
  } catch {
    throw new OpsExecutionFailure("recovery_required", {});
  }
  if (progress.launch.containerId && progress.launch.containerId !== containerId)
    throw new OpsExecutionFailure("recovery_required", {});
  if (progress.launch.state !== "confirmed") {
    progress = {
      ...progress,
      sequence: progress.sequence + 1,
      phase: "launched",
      launch: { state: "confirmed", containerId },
      updatedAt: Date.now(),
    };
    writeProgress(authority, intent, progress);
  }
  // The helper cannot start effects until the real server publishes this
  // original terminal preparation. There is no writer held while draining.
  while ((context.otherActiveOperations?.() ?? 0) > 0) {
    context.signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        context.signal.removeEventListener("abort", aborted);
      };
      const aborted = () => {
        done();
        reject(context.signal.reason);
      };
      const timer = setTimeout(() => {
        done();
        resolve();
      }, 100);
      context.signal.addEventListener("abort", aborted, { once: true });
      if (context.signal.aborted) aborted();
    });
  }
  return { handoffId: operation.handoffId, phase: "prepared" as const };
}
