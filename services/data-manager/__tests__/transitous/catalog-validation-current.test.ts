/** Signed pointer/nominal-owner component; this does not fabricate a completed validation worker. */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireArtifactTargetLease,
  closeArtifactTargetLeaseHandle,
  closeControlInstallation,
  controlDigest,
  openControlInstallation,
  provisionControlInstallation,
  retainAdmittedControlExecution,
  signControl,
} from "@openmapx/core/build-artifacts";
import {
  CATALOG_VALIDATION_DOMAIN,
  catalogValidationRecordSchema,
  readCurrentCatalogValidation,
  withCatalogProposalDirectory,
} from "@openmapx/core/catalog-pins";
import {
  canonicalJson,
  createControlRootOperationKey,
  executionFingerprint,
} from "@openmapx/core/ops";
import { expect, it } from "vitest";
import { installationState } from "../../../../packages/core/src/build-artifacts/control-authority";
import { publishCatalogValidationCurrent } from "../../src/jobs/transitous/catalog-validation-current";

async function fixture(kind: "catalog.validate" | "transit-sync" | "download-fonts") {
  const root = mkdtempSync(join(tmpdir(), "omx-catalog-current-")),
    dataDir = join(root, "data"),
    proposalId = randomUUID(),
    id = randomUUID();
  mkdirSync(join(dataDir, "motis/proposals", proposalId), { recursive: true, mode: 0o700 });
  await provisionControlInstallation(root);
  const ids = ["data-manager", "motis", "motis-feed-proxy", "motis-staging"],
    installation = openControlInstallation({
      infraDir: root,
      role: "data-manager",
      serviceIds: ids,
    });
  const input =
    kind === "catalog.validate"
      ? { kind, proposalId, countries: ["de"] }
      : kind === "transit-sync"
        ? { kind, countries: ["de"] }
        : { kind };
  const deadlineAt = Date.now() + 120000,
    operationFingerprint = controlDigest(input),
    execution = {
      executor: "data-manager" as const,
      principal: "data-manager" as const,
      executionId: id,
      operationKey: createControlRootOperationKey({ notAfter: deadlineAt, nonce: randomBytes(16) }),
      operationFingerprint,
      deadlineAt,
      fingerprint: executionFingerprint({ kind, operationFingerprint, deadlineAt }),
    };
  const authority = retainAdmittedControlExecution(installation, {
      execution,
      kind,
      operation: input,
      admittedAt: Date.now(),
      requestedDeadlineAt: deadlineAt,
      serviceIds: ids,
    }),
    lease = await acquireArtifactTargetLease({
      dataRoot: dataDir,
      owner: authority,
      serviceIds: ids,
    });
  return {
    root,
    dataDir,
    proposalId,
    installation,
    execution,
    authority,
    lease,
    close() {
      closeArtifactTargetLeaseHandle(lease);
      closeControlInstallation(installation);
      rmSync(root, { recursive: true, force: true });
    },
  };
}
it("selects only original signed validation bytes, then invalidates before reuse", async () => {
  const f = await fixture("catalog.validate");
  try {
    const completedAt = new Date().toISOString(),
      d = "a".repeat(64),
      inputs = {
        configurationRevisionId: `cfg1_${"a".repeat(43)}`,
        credentialsRevision: d,
        sourcePolicyRevision: d,
        overlayDigest: d,
        imageDigest: `sha256:${d}`,
        stagingState: "stopped",
        requiredKeys: [],
        configuredKeys: [],
      };
    const record = catalogValidationRecordSchema.parse({
      version: 1,
      installationId: f.installation.installationId,
      sourceExecution: f.execution,
      proposalDigest: d,
      runtimeInputs: inputs,
      validation: {
        status: "passed",
        validationId: f.execution.executionId,
        proposalId: f.proposalId,
        pinDigest: d,
        diffDigest: d,
        sourcePolicyRevision: d,
        overlayDigest: d,
        credentialsRevision: d,
        countries: ["de"],
        slot: "B",
        epoch: f.execution.executionId,
        manifestHash: d,
        imageDigest: `sha256:${d}`,
        completedAt,
        expiresAt: new Date(Date.parse(completedAt) + 86400000).toISOString(),
      },
    });
    withCatalogProposalDirectory(f.installation, f.proposalId, (dir) =>
      dir.write(
        `validation-${f.execution.executionId}.json`,
        canonicalJson(
          signControl(
            installationState(f.installation).privateKey,
            CATALOG_VALIDATION_DOMAIN,
            record,
          ),
        ),
      ),
    );
    publishCatalogValidationCurrent(f.authority, f.lease, f.proposalId);
    expect(readCurrentCatalogValidation(f.installation)?.selected).toEqual({
      proposalId: f.proposalId,
      validationId: f.execution.executionId,
      validationDigest: controlDigest(record),
    });
    publishCatalogValidationCurrent(f.authority, f.lease);
    expect(readCurrentCatalogValidation(f.installation)?.selected).toBeNull();
  } finally {
    f.close();
  }
});
it("permits ordinary owned transit invalidation but not a different kind or a forged nominal owner", async () => {
  const ordinary = await fixture("transit-sync");
  try {
    publishCatalogValidationCurrent(ordinary.authority, ordinary.lease);
    expect(readCurrentCatalogValidation(ordinary.installation)?.sourceExecution).toEqual(
      ordinary.execution,
    );
    expect(() =>
      publishCatalogValidationCurrent({} as typeof ordinary.authority, ordinary.lease),
    ).toThrow(/Unverified/);
    expect(() =>
      publishCatalogValidationCurrent(ordinary.authority, ordinary.lease, ordinary.proposalId),
    ).toThrow(/Only the original validation/);
  } finally {
    ordinary.close();
  }
  const foreign = await fixture("download-fonts");
  try {
    expect(() => publishCatalogValidationCurrent(foreign.authority, foreign.lease)).toThrow(
      /Original complete transit/,
    );
    expect(readCurrentCatalogValidation(foreign.installation)).toBeNull();
  } finally {
    foreign.close();
  }
});
