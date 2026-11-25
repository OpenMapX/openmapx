/** Fixed Full Update admission and verified prerequisite source. No public input
 * can substitute for the original planned CLI or a DM terminal witness. */
import { dirname } from "node:path";
import { z } from "zod";
import { canonicalJson } from "../ops/canonical-json";
import type { OpsOperation } from "../ops/contract";
import type { ExecutionRef } from "../ops/execution-ref";
import { opsOperationFingerprint } from "../ops/fingerprint";
import { dataWorkflowReceiptSchema } from "../ops/job-evidence";
import {
  currentConfigurationGeneration,
  readAppliedPlatformConfiguration,
} from "../services/configuration-generation";
import type { DataManagerTransport } from "../services/data-manager/transport";
import { resolvePlatformConfiguration } from "../services/platform-configuration";
import type { ControlInstallation } from "./control-records";
import { controlDigest } from "./control-records";
import { readDataManagerTerminal } from "./data-manager-terminal";
import {
  createDataUpdatePlan,
  type DataUpdatePlan,
  dataUpdatePlanSchema,
} from "./data-update-records";
import { dataUpdateHostDefaults, dataUpdateSourcesDigest } from "./data-update-sources";
import {
  type ExecutionHandle,
  lookupControlChildPhase,
  lookupControlChildPhaseAttempt,
  openFixedChildInstallation,
  restoreAdmittedControlExecution,
  verifyControlEffectSettlement,
} from "./execution-record";
import { closeControlInstallation, readPrivateRecord, writePrivateRecord } from "./private-records";

export function planDataUpdate(options: {
  infraDir: string;
  parent: ExecutionRef;
  operation: Extract<OpsOperation, { kind: "data.update" }>;
  serviceIds: readonly string[];
  defaultRegion?: string;
  defaultCountries?: string;
}): DataUpdatePlan {
  const revisionId = currentConfigurationGeneration(options.infraDir);
  if (!revisionId) throw Error("Full Update requires an applied configuration");
  const sourceBefore = dataUpdateSourcesDigest(options.infraDir),
    defaults = dataUpdateHostDefaults(options.infraDir);
  const countries = [
    ...new Set(
      options.operation.countryCodes ??
        (options.defaultCountries ?? defaults.countries ?? "")
          .split(",")
          .map((v) => v.trim().toUpperCase())
          .filter(Boolean),
    ),
  ].sort();
  const saved = readAppliedPlatformConfiguration(options.infraDir);
  const platform = resolvePlatformConfiguration({
    saved,
    env: { DOMAIN: defaults.domain, OPENMAPX_REGION: defaults.region, ...process.env },
  }).values;
  const sourcesDigest = dataUpdateSourcesDigest(options.infraDir);
  if (revisionId !== currentConfigurationGeneration(options.infraDir))
    throw Error("Full Update configuration changed during admission");
  if (sourceBefore !== sourcesDigest) throw Error("Full Update source changed during admission");
  return createDataUpdatePlan({
    parent: options.parent,
    operation: options.operation,
    domain: platform.domain,
    region:
      options.operation.regionId ??
      (saved?.defaultRegion?.source === "database"
        ? platform.defaultRegion
        : (options.defaultRegion ?? platform.defaultRegion)) ??
      "",
    countries,
    revisionId,
    sourcesDigest,
    serviceIds: options.serviceIds,
  });
}
function validate(authority: ExecutionHandle, plan: DataUpdatePlan) {
  const s = authority;
  if (
    s.kind !== "data.update" ||
    opsOperationFingerprint(plan.operation) !== s.execution.operationFingerprint
  )
    throw Error("Original Full Update authority required");
  const ownRoot = controlDigest(plan.parent) === controlDigest(s.execution);
  const child = [plan.dataReservation, plan.finalizationReservation].find(
    (r) =>
      r.execution.operationKey === s.execution.operationKey &&
      r.execution.executionId === s.execution.executionId,
  );
  if (!ownRoot && !child) throw Error("Foreign Full Update plan");
  const expected = ownRoot
    ? s.execution.executor === "host-cli"
      ? plan.dataChildren
      : [plan.dataReservation, plan.finalizationReservation]
    : child === plan.dataReservation
      ? plan.dataChildren
      : [];
  if (canonicalJson(s.reservations) !== canonicalJson(expected))
    throw Error("Full Update phase plan changed");
}
export function retainDataUpdatePlan(authority: ExecutionHandle, value: DataUpdatePlan): void {
  const plan = dataUpdatePlanSchema.parse(value);
  validate(authority, plan);
  const s = authority;
  writePrivateRecord(
    s.installation,
    "observations",
    `data-update-plan-${s.execution.operationKey}.json`,
    plan,
    true,
  );
}
export function readDataUpdatePlan(authority: ExecutionHandle): DataUpdatePlan {
  const s = authority,
    name = `data-update-plan-${s.execution.operationKey}.json`,
    raw = readPrivateRecord(s.installation, "observations", name, 128 * 1024);
  const plan = dataUpdatePlanSchema.parse(raw);
  validate(authority, plan);
  return plan;
}
export function assertDataUpdateSources(authority: ExecutionHandle) {
  const s = authority,
    plan = readDataUpdatePlan(authority),
    infraDir = dirname(s.installation.dataRoot);
  if (
    currentConfigurationGeneration(infraDir) !== plan.revisionId ||
    dataUpdateSourcesDigest(infraDir) !== plan.sourcesDigest
  )
    throw Error("Full Update configuration sources changed");
  return plan;
}

/** Original indexed progress is business evidence only. A success producer must
 * additionally prove its actual children/target tree before committing. */
function readDataWorkflowProgress(handle: ExecutionHandle) {
  if (handle.kind !== "data.update") throw Error("Original Full Update owner required");
  const name = `data-workflow-${handle.execution.operationKey}.json`,
    raw = readPrivateRecord(handle.installation, "observations", name, 65536);
  const body = z
    .strictObject({
      version: z.literal(1),
      operationKey: z.string(),
      fingerprint: z.string(),
      receipt: dataWorkflowReceiptSchema,
    })
    .parse(raw);
  if (
    body.operationKey !== handle.execution.operationKey ||
    body.fingerprint !== handle.execution.fingerprint
  )
    throw Error("Full Update checkpoint identity changed");
  return body.receipt;
}

/** Target acquisition observes only its original data-phase owner and all three
 * recorded, physically settled DM children. No progress object is authority. */
export async function verifyDataUpdatePrerequisites(
  handle: ExecutionHandle,
  transport: DataManagerTransport | undefined,
  signal?: AbortSignal,
) {
  if (handle.kind !== "data.update" || handle.installation.fixedChildId)
    throw Error("Original Full Update root required");
  const name = `data-update-plan-${handle.execution.operationKey}.json`,
    raw = readPrivateRecord(handle.installation, "observations", name, 128 * 1024);
  const plan = dataUpdatePlanSchema.parse(raw),
    infraDir = dirname(handle.installation.dataRoot);
  if (
    controlDigest(plan.parent) !== controlDigest(handle.execution) ||
    opsOperationFingerprint(plan.operation) !== handle.execution.operationFingerprint ||
    currentConfigurationGeneration(infraDir) !== plan.revisionId ||
    dataUpdateSourcesDigest(infraDir) !== plan.sourcesDigest
  )
    throw Error("Original Full Update sources changed");
  let childInstallation: ControlInstallation | undefined;
  try {
    let dataHandle = handle;
    if (handle.execution.executor === "ops-agent") {
      const attempt = await lookupControlChildPhaseAttempt(handle, {
        phase: "data-workflow",
        ordinal: 0,
      });
      if (!attempt) throw Error("Full Update data phase not admitted");
      childInstallation = openFixedChildInstallation({
        infraDir,
        child: { leaseId: attempt.leaseId, childKey: attempt.childKey },
      });
      dataHandle = await restoreAdmittedControlExecution(childInstallation, attempt.execution);
      const settlement = await verifyControlEffectSettlement(childInstallation, attempt.execution);
      if (settlement.outcome !== "committed" || settlement.publication !== "committed")
        throw Error("Full Update data phase unsettled");
    }
    const receipt = readDataWorkflowProgress(dataHandle);
    if (
      receipt.phase !== "build" ||
      receipt.children.length !== 3 ||
      receipt.children.some((c) => c.status !== "succeeded")
    )
      throw Error("Full Update data checkpoint missing");
    if (!transport) throw Error("Full Update prerequisites are read from data-manager");
    for (const [index, slot] of plan.dataChildren.entries()) {
      const bound = await lookupControlChildPhase(dataHandle, slot);
      if (!bound) throw Error("Full Update prerequisite missing");
      const child = receipt.children[index],
        terminal = await readDataManagerTerminal(bound.execution, transport, signal);
      if (
        !child ||
        child.operationKey !== bound.execution.operationKey ||
        child.jobId !== bound.execution.executionId ||
        child.fingerprint !== bound.execution.fingerprint ||
        child.deadlineAt !== bound.execution.deadlineAt ||
        terminal.status !== "succeeded" ||
        terminal.publication !== "committed"
      )
        throw Error("Full Update prerequisite did not complete");
    }
    return receipt;
  } finally {
    if (childInstallation) closeControlInstallation(childInstallation);
  }
}
