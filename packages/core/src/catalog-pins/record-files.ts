/** Data-only fixed signed record readers. Callers obtain their source from the installed nominal role. */
import { dirname } from "node:path";
import z from "zod/v4";
import { verifyControl } from "../build-artifacts/control-records";
import { AnchoredDirectory } from "../build-artifacts/filesystem";
import { parseCatalogPinSet } from "./generation";
import { catalogProposalEnvelopePayloadSchema } from "./proposal-schemas";
import {
  catalogActivationRecordSchema,
  catalogValidationRecordSchema,
  currentCatalogValidationSchema,
} from "./review-schemas";
export const CATALOG_VALIDATION_DOMAIN = "openmapx-catalog-validation-v1";
export const CATALOG_ACTIVATION_DOMAIN = "openmapx-catalog-activation-v1";
type RecordSource = {
  dataRoot: string;
  installationId: string;
  dataManagerPublicKey: string;
  agentPublicKey: string;
};
export function withCatalogProposalDataDirectory<T>(
  source: Pick<RecordSource, "dataRoot">,
  proposalId: string,
  run: (directory: AnchoredDirectory) => T,
): T {
  z.uuid().parse(proposalId);
  const opened: AnchoredDirectory[] = [];
  try {
    let directory = new AnchoredDirectory(source.dataRoot);
    opened.push(directory);
    for (const name of ["motis", "proposals", proposalId]) {
      directory = directory.directory(name, false, name !== "motis");
      opened.push(directory);
    }
    return run(directory);
  } finally {
    for (const directory of opened.reverse()) directory.close();
  }
}
export function readCatalogValidationFile(
  source: RecordSource,
  proposalId: string,
  validationId: string,
) {
  z.uuid().parse(validationId);
  const record = withCatalogProposalDataDirectory(source, proposalId, (directory) =>
    verifyControl(
      source.dataManagerPublicKey,
      CATALOG_VALIDATION_DOMAIN,
      JSON.parse(directory.read(`validation-${validationId}.json`, 64 * 1024).toString("utf8")),
      catalogValidationRecordSchema,
    ),
  );
  if (
    record.installationId !== source.installationId ||
    record.validation.proposalId !== proposalId ||
    record.validation.validationId !== validationId
  )
    throw Error("Foreign catalog validation");
  return record;
}
export function readCatalogActivationFile(
  source: RecordSource,
  proposalId: string,
  executionId: string,
) {
  z.uuid().parse(executionId);
  const record = withCatalogProposalDataDirectory(source, proposalId, (directory) =>
    verifyControl(
      source.dataManagerPublicKey,
      CATALOG_ACTIVATION_DOMAIN,
      JSON.parse(directory.read(`activation-${executionId}.json`, 64 * 1024).toString("utf8")),
      catalogActivationRecordSchema,
    ),
  );
  if (
    record.installationId !== source.installationId ||
    record.proposalId !== proposalId ||
    record.parent.executionId !== executionId
  )
    throw Error("Foreign catalog activation");
  return record;
}
export function readCatalogProposalFile(source: RecordSource, proposalId: string) {
  z.uuid().parse(proposalId);
  const infra = new AnchoredDirectory(dirname(source.dataRoot));
  let pins: AnchoredDirectory | undefined, proposals: AnchoredDirectory | undefined;
  try {
    pins = infra.directory("catalog-pins", false, true);
    proposals = pins.directory("proposals", false, true);
    const record = verifyControl(
      source.agentPublicKey,
      "openmapx-catalog-proposal-v1",
      JSON.parse(proposals.read(`${proposalId}.json`, 768 * 1024).toString("utf8")),
      catalogProposalEnvelopePayloadSchema,
    );
    if (
      record.installationId !== source.installationId ||
      record.proposal.proposalId !== proposalId
    )
      throw Error("Foreign catalog proposal");
    parseCatalogPinSet(record.proposal.pins);
    return record.proposal;
  } finally {
    proposals?.close();
    pins?.close();
    infra.close();
  }
}
export const CURRENT_CATALOG_VALIDATION_DOMAIN = "openmapx-current-catalog-validation-v1";
export function readCurrentCatalogValidationFile(source: RecordSource) {
  const root = new AnchoredDirectory(source.dataRoot);
  let motis: AnchoredDirectory | undefined;
  try {
    motis = root.directory("motis");
    const record = verifyControl(
      source.dataManagerPublicKey,
      CURRENT_CATALOG_VALIDATION_DOMAIN,
      JSON.parse(motis.read("catalog-validation-current.json", 8192).toString("utf8")),
      currentCatalogValidationSchema,
    );
    if (record.installationId !== source.installationId)
      throw Error("Foreign current catalog validation");
    return record;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  } finally {
    motis?.close();
    root.close();
  }
}
