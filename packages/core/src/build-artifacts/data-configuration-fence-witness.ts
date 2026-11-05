import {
  type DataConfigurationFencePreparedWitness,
  dataConfigurationFencePreparedWitnessDomain,
  dataConfigurationFencePreparedWitnessSchema,
} from "./data-configuration-fence-witness-records";

export {
  type DataConfigurationFencePreparedWitness,
  dataConfigurationFencePreparedWitnessDomain,
  dataConfigurationFencePreparedWitnessSchema,
} from "./data-configuration-fence-witness-records";

import { type ExecutionRef, executionRefSchema } from "../ops/execution-ref";
import {
  configurationSettlementDomains,
  settlementRecordDigest,
} from "./configuration-fence-settlement-records";
import { installationState } from "./control-authority";
import { controlDigest, verifyControl } from "./control-records";
import { AnchoredDirectory } from "./filesystem";
import {
  type ArtifactTargetLease,
  configurationMaintenanceTargetOwner,
  inspectArtifactTargetLeaseChildSettlement,
} from "./target-lease";

declare const verifiedPreparedBrand: unique symbol;
export type VerifiedPreparedDataConfigurationFence = Readonly<{ [verifiedPreparedBrand]: true }>;
const verified = new WeakMap<
  VerifiedPreparedDataConfigurationFence,
  DataConfigurationFencePreparedWitness
>();
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export function preparedDataConfigurationFenceState(
  value: VerifiedPreparedDataConfigurationFence,
): DataConfigurationFencePreparedWitness {
  const state = verified.get(value);
  if (!state) throw Error("Verified original DM preparation required");
  return state;
}
export function verifyPublishedDataConfigurationFencePrepared(
  lease: ArtifactTargetLease,
  execution: ExecutionRef,
): VerifiedPreparedDataConfigurationFence {
  const owner = configurationMaintenanceTargetOwner(lease),
    local = installationState(owner.installation);
  const opened: AnchoredDirectory[] = [],
    own = (directory: AnchoredDirectory) => {
      opened.push(directory);
      return directory;
    };
  try {
    const root = own(new AnchoredDirectory(local.dataRoot)),
      control = own(root.directory(".admin-target-control")),
      executions = own(control.directory("executions")),
      role = own(executions.directory("data-manager"));
    const value = verifyControl(
      local.publicKeys["data-manager"],
      dataConfigurationFencePreparedWitnessDomain,
      JSON.parse(
        role
          .read(`${executionRefSchema.parse(execution).operationKey}.data-terminal.json`, 8192)
          .toString("utf8"),
      ),
      dataConfigurationFencePreparedWitnessSchema,
    );
    const effectReceipt = {
      kind: "data-configuration-fence",
      receipt: value.preparedReceipt,
      guardDigest: value.guardDigest,
    };
    const child = inspectArtifactTargetLeaseChildSettlement(lease, execution);
    if (
      value.installationId !== owner.installation.installationId ||
      controlDigest(value.origin) !== controlDigest(owner.origin) ||
      controlDigest(value.ownerPrepare) !== controlDigest(owner.execution) ||
      controlDigest(value.prepareExecution) !== controlDigest(execution) ||
      controlDigest(value.preparedReceipt.ownerPrepare) !== controlDigest(owner.execution) ||
      value.rootCertificateDigest !== owner.certificateDigest ||
      value.preparedReceipt.fenceId !== execution.executionId ||
      value.preparedReceiptDigest !==
        settlementRecordDigest(
          configurationSettlementDomains.preparedReceipt,
          value.preparedReceipt,
        ) ||
      value.preparedCanonicalDigest !==
        controlDigest({ version: 1, receipt: value.preparedReceipt }) ||
      value.effectReceiptDigest !== controlDigest(effectReceipt) ||
      child?.outcome !== "committed" ||
      child.publication !== "committed" ||
      child.terminalReceiptDigest !== value.effectReceiptDigest ||
      value.effectSettlementDigest !== controlDigest({ ...child, receipt: effectReceipt })
    )
      throw Error("Original DM preparation source mismatch");
    const handle = Object.freeze({}) as VerifiedPreparedDataConfigurationFence;
    verified.set(handle, freeze(structuredClone(value)));
    return handle;
  } finally {
    for (const directory of opened.reverse()) directory.close();
  }
}
