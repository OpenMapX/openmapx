/** Data-only record readers. Callers obtain their source from the installed nominal role. */
import { dirname } from "node:path";
import z from "zod/v4";
import { AnchoredDirectory } from "../build-artifacts/filesystem";
import { parseCatalogPinSet } from "./generation";
import { catalogProposalEnvelopePayloadSchema } from "./proposal-schemas";
import {
  catalogActivationRecordSchema,
  catalogValidationRecordSchema,
  currentCatalogValidationSchema,
} from "./review-schemas";

type RecordSource = { dataRoot: string };
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
    catalogValidationRecordSchema.parse(
      JSON.parse(directory.read(`validation-${validationId}.json`, 64 * 1024).toString("utf8")),
    ),
  );
  if (
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
    catalogActivationRecordSchema.parse(
      JSON.parse(directory.read(`activation-${executionId}.json`, 64 * 1024).toString("utf8")),
    ),
  );
  if (record.proposalId !== proposalId || record.parent.executionId !== executionId)
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
    const record = catalogProposalEnvelopePayloadSchema.parse(
      JSON.parse(proposals.read(`${proposalId}.json`, 768 * 1024).toString("utf8")),
    );
    if (record.proposal.proposalId !== proposalId) throw Error("Foreign catalog proposal");
    parseCatalogPinSet(record.proposal.pins);
    return record.proposal;
  } finally {
    proposals?.close();
    pins?.close();
    infra.close();
  }
}
export function readCurrentCatalogValidationFile(source: RecordSource) {
  const root = new AnchoredDirectory(source.dataRoot);
  let motis: AnchoredDirectory | undefined;
  try {
    motis = root.directory("motis");
    const record = currentCatalogValidationSchema.parse(
      JSON.parse(motis.read("catalog-validation-current.json", 8192).toString("utf8")),
    );
    return record;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  } finally {
    motis?.close();
    root.close();
  }
}
