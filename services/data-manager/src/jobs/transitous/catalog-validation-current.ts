/** Invalidate before slot reuse. A restored old manifest cannot resurrect an old reviewed validation. */
import {
  assertArtifactTargetLeaseExecution,
  assertArtifactTargetLeaseForward,
  assertControlExecutionForward,
  controlDigest,
  executionAuthorityState,
  signControl,
  type TargetLeaseAuthority,
  type VerifiedExecutionAuthority,
} from "@openmapx/core/build-artifacts";
import { currentCatalogValidationSchema, readCatalogValidation } from "@openmapx/core/catalog-pins";
import { canonicalJson } from "@openmapx/core/ops";
import { AnchoredDirectory } from "../../../../../packages/core/src/build-artifacts/filesystem";
import { CURRENT_CATALOG_VALIDATION_DOMAIN } from "../../../../../packages/core/src/catalog-pins/record-files";
export function publishCatalogValidationCurrent(
  authority: VerifiedExecutionAuthority,
  lease: TargetLeaseAuthority,
  proposalId?: string,
): void {
  const owner = executionAuthorityState(authority);
  assertControlExecutionForward(authority);
  assertArtifactTargetLeaseForward(lease);
  assertArtifactTargetLeaseExecution(lease, owner.execution);
  if (
    owner.installation.installation.role !== "data-manager" ||
    lease.mode !== "owner" ||
    !["transit-sync", "catalog.validate"].includes(owner.kind) ||
    !["motis", "motis-staging", "motis-feed-proxy"].every((id) => lease.serviceIds.includes(id))
  )
    throw Error("Original complete transit/validation owner required");
  let selected = null;
  if (proposalId !== undefined) {
    if (owner.kind !== "catalog.validate")
      throw Error("Only the original validation may select its evidence");
    const validation = readCatalogValidation(
      owner.installation.installation,
      proposalId,
      owner.execution.executionId,
    );
    if (
      validation.validation.status !== "passed" ||
      controlDigest(validation.sourceExecution) !== controlDigest(owner.execution) ||
      controlDigest({
        kind: "catalog.validate",
        proposalId,
        countries: validation.validation.countries,
      }) !== owner.execution.operationFingerprint
    )
      throw Error("Original passing validation evidence required");
    selected = {
      proposalId,
      validationId: owner.execution.executionId,
      validationDigest: controlDigest(validation),
    };
  }
  const body = currentCatalogValidationSchema.parse({
    version: 1,
    installationId: owner.installation.installation.installationId,
    sourceExecution: owner.execution,
    selected,
  });
  const data = new AnchoredDirectory(owner.installation.dataRoot);
  let motis: AnchoredDirectory | undefined;
  try {
    motis = data.directory("motis", true);
    motis.write(
      "catalog-validation-current.json",
      canonicalJson(
        signControl(owner.installation.privateKey, CURRENT_CATALOG_VALIDATION_DOMAIN, body),
      ),
    );
  } finally {
    motis?.close();
    data.close();
  }
}
