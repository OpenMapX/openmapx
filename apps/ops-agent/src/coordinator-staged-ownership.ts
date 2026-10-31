/** Fixed production installation; journal records are locators, never authority. */
import {
  type ControlInstallation,
  type ControlRetentionPreparationContext,
  controlRetentionPreparationState,
  recordStagedCoordinatorRetentionCheck,
} from "@openmapx/core/build-artifacts";
import { installationState } from "../../../packages/core/src/build-artifacts/control-authority";
import { signControl } from "../../../packages/core/src/build-artifacts/control-records";
import {
  stagedCoordinatorRetirementDomain,
  stagedCoordinatorRetirementPacketSchema,
} from "../../../packages/core/src/build-artifacts/coordinator-pull-records";
import type { OpsJobJournal } from "./journal";
import {
  bindCoordinatorStagedOwnershipSource,
  readLiteralCoordinatorStagedRetention,
} from "./owned-services";

export { assertStagedCoordinatorConfigurationWrite } from "./configuration-maintenance-store";

import { productionOwnedServices } from "./production-runtime";
import type { OpsRuntime } from "./runtime";

export function installCoordinatorStagedOwnershipSource(
  runtime: OpsRuntime,
  installation: ControlInstallation,
  journal: OpsJobJournal,
): void {
  bindCoordinatorStagedOwnershipSource(productionOwnedServices(runtime), installation, journal);
}

/** Called only by the existing serialized role collector/journal hook. */
export async function prepareCoordinatorStagedRetention(
  context: ControlRetentionPreparationContext,
  runtime: OpsRuntime,
  installation: ControlInstallation,
  journal: OpsJobJournal,
): Promise<void> {
  const state = controlRetentionPreparationState(context),
    resolver = productionOwnedServices(runtime),
    actual = await readLiteralCoordinatorStagedRetention(resolver, installation, journal, context);
  if (!actual) return;
  const source = actual.source,
    successor = actual.successor;
  const packet = stagedCoordinatorRetirementPacketSchema.parse(
    signControl(installationState(installation).privateKey, stagedCoordinatorRetirementDomain, {
      version: 1,
      installationId: installation.installationId,
      originDigest: state.originDigest,
      familyId: state.familyId,
      generation: state.generation,
      execution: source.execution,
      terminalDigest: source.canonicalDigest,
      sourceAdmissionDigest: source.admissionDigest,
      oldContainerDigest: actual.oldContainerDigest,
      rank: { admittedAt: source.admittedAt, operationKey: source.execution.operationKey },
      contextMode: state.mode,
      checkNonce: state.checkNonce,
      manifestDigest: state.manifestDigest,
      checkedAt: Date.now(),
      condition: actual.condition,
      successor: successor
        ? {
            execution: successor.execution,
            admissionDigest: successor.admissionDigest,
            canonicalDigest: successor.canonicalDigest,
            effectDigest: successor.effectDigest,
            apiCopyDigest: successor.apiCopyDigest,
            rank: {
              admittedAt: successor.admittedAt,
              operationKey: successor.execution.operationKey,
            },
          }
        : null,
    }),
  );
  // No checksum or public success boolean substitutes for this actual producer.
  recordStagedCoordinatorRetentionCheck(context, packet);
}
