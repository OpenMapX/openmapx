/** Fixed Full Update admission and verified prerequisite source. No public input
 * can substitute for the original planned CLI or a DM terminal witness. */
import { dirname } from "node:path";
import { canonicalJson } from "../ops/canonical-json";
import type { OpsOperation } from "../ops/contract";
import type { ExecutionRef } from "../ops/execution-ref";
import { opsOperationFingerprint } from "../ops/fingerprint";
import {
  currentConfigurationGeneration,
  readAppliedPlatformConfiguration,
} from "../services/configuration-generation";
import { resolvePlatformConfiguration } from "../services/platform-configuration";
import {
  controlDigest,
  executionAuthorityState,
  readPrivateRecord,
  signControl,
  type VerifiedExecutionAuthority,
  verifyControl,
  writePrivateRecord,
} from "./control-authority";
import {
  createDataUpdatePlan,
  type DataUpdatePlan,
  dataUpdatePlanSchema,
} from "./data-update-records";
import { dataUpdateHostDefaults, dataUpdateSourcesDigest } from "./data-update-sources";
import { readOwnedGenerationHardlinkPlan } from "./generation-hardlinks-owner";
import { verifyFamilyOwnedRecord } from "./retention-family";

const domain = "openmapx-data-update-plan-v1";
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
    hardlinks: readOwnedGenerationHardlinkPlan(options.infraDir, revisionId),
    serviceIds: options.serviceIds,
  });
}
function validate(authority: VerifiedExecutionAuthority, plan: DataUpdatePlan) {
  const s = executionAuthorityState(authority);
  if (
    s.kind !== "data.update" ||
    !s.origin ||
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
      ? [...plan.dataChildren, ...plan.finalizationChildren]
      : [plan.dataReservation, plan.finalizationReservation]
    : child === plan.dataReservation
      ? plan.dataChildren
      : plan.finalizationChildren;
  if (canonicalJson(s.reservations) !== canonicalJson(expected))
    throw Error("Full Update phase plan changed");
}
export function retainDataUpdatePlan(
  authority: VerifiedExecutionAuthority,
  value: DataUpdatePlan,
): void {
  const plan = dataUpdatePlanSchema.parse(value);
  validate(authority, plan);
  const s = executionAuthorityState(authority);
  writePrivateRecord(
    s.installation,
    "observations",
    `data-update-plan-${s.execution.operationKey}.json`,
    signControl(s.installation.privateKey, domain, plan),
    true,
    s.origin,
  );
}
export function readDataUpdatePlan(authority: VerifiedExecutionAuthority): DataUpdatePlan {
  const s = executionAuthorityState(authority),
    name = `data-update-plan-${s.execution.operationKey}.json`,
    raw = readPrivateRecord(s.installation, "observations", name, 128 * 1024);
  if (!s.origin) throw Error("Dated Full Update owner required");
  verifyFamilyOwnedRecord(
    s.installation,
    s.origin,
    { scope: "private", namespace: "observations", container: "", name },
    canonicalJson(raw),
  );
  const plan = verifyControl(
    s.installation.installation.publicKey,
    domain,
    raw,
    dataUpdatePlanSchema,
  );
  validate(authority, plan);
  return plan;
}
export function assertDataUpdateSources(authority: VerifiedExecutionAuthority) {
  const s = executionAuthorityState(authority),
    plan = readDataUpdatePlan(authority),
    infraDir = dirname(s.installation.dataRoot);
  if (
    currentConfigurationGeneration(infraDir) !== plan.revisionId ||
    dataUpdateSourcesDigest(infraDir) !== plan.sourcesDigest
  )
    throw Error("Full Update configuration sources changed");
  return plan;
}

export { verifyDataUpdatePrerequisites } from "./control-authority";
