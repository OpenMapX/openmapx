/** Fixed cross-role reads obtain paths and public keys from the installed nominal role. */
import { type ControlInstallation, installationState } from "../build-artifacts/control-authority";
import {
  readCatalogActivationFile,
  readCatalogValidationFile,
  readCurrentCatalogValidationFile,
  withCatalogProposalDataDirectory,
} from "./record-files";

export { CATALOG_ACTIVATION_DOMAIN, CATALOG_VALIDATION_DOMAIN } from "./record-files";

function source(installation: ControlInstallation) {
  const state = installationState(installation);
  return {
    dataRoot: state.dataRoot,
    installationId: installation.installationId,
    dataManagerPublicKey: state.publicKeys["data-manager"],
    agentPublicKey: state.publicKeys["ops-agent"],
  };
}
export function withCatalogProposalDirectory<T>(
  installation: ControlInstallation,
  proposalId: string,
  run: Parameters<typeof withCatalogProposalDataDirectory<T>>[2],
): T {
  return withCatalogProposalDataDirectory(source(installation), proposalId, run);
}
export function readCatalogValidation(
  installation: ControlInstallation,
  proposalId: string,
  validationId: string,
) {
  return readCatalogValidationFile(source(installation), proposalId, validationId);
}
export function readCatalogActivation(
  installation: ControlInstallation,
  proposalId: string,
  executionId: string,
) {
  return readCatalogActivationFile(source(installation), proposalId, executionId);
}

export function readCurrentCatalogValidation(installation: ControlInstallation) {
  return readCurrentCatalogValidationFile(source(installation));
}
