import { randomBytes, randomUUID } from "node:crypto";
import {
  beginControlEffect,
  controlDigest,
  executionAuthorityState,
  installationState,
  retainAdmittedControlExecution,
  retainControlEffectReceipt,
  verifyControlEffectSettlement,
} from "../build-artifacts/control-authority";
import type { ControlInstallation } from "../build-artifacts/control-records";
import {
  type ArtifactTargetLease,
  acquireArtifactTargetLease,
  closeArtifactTargetLeaseHandle,
  releaseArtifactTargetLease,
  settleArtifactTargetLeaseChild,
} from "../build-artifacts/target-lease";
import { createControlRootOperationKey } from "../ops/control-root-key";
import { executionFingerprint } from "../ops/execution-identity";
import {
  initializeCatalogPinSet,
  preflightCatalogPinInitialization,
  readCatalogPinSet,
} from "./store";
/** Local startup/CLI bootstrap only: no HTTP operation, child edge or activation. */
export async function initializeManagedCatalogPins(options: {
  rootDir: string;
  installation: ControlInstallation;
}) {
  const current = readCatalogPinSet(options.rootDir);
  if (current) return current;
  if (!preflightCatalogPinInitialization(options.rootDir)) return null;
  const role = options.installation.role;
  if (role !== "ops-agent" && role !== "host-cli")
    throw Error("Catalog initialization is host-owned");
  const operation = { kind: "catalog-pins.initialize" },
    admittedAt = Date.now(),
    deadlineAt = admittedAt + 60000,
    hash = controlDigest(operation);
  const authority = retainAdmittedControlExecution(options.installation, {
    execution: {
      executor: role,
      principal: role === "ops-agent" ? "api" : "host-cli",
      executionId: role === "ops-agent" ? `job1_${randomUUID().replaceAll("-", "")}` : randomUUID(),
      operationKey: createControlRootOperationKey({ notAfter: deadlineAt, nonce: randomBytes(16) }),
      deadlineAt,
      operationFingerprint: hash,
      fingerprint: executionFingerprint({
        kind: operation.kind,
        operationFingerprint: hash,
        deadlineAt,
      }),
    },
    operation,
    kind: operation.kind,
    admittedAt,
    requestedDeadlineAt: deadlineAt,
    serviceIds: ["motis"],
  });
  let lease: ArtifactTargetLease | undefined;
  try {
    lease = await acquireArtifactTargetLease({
      dataRoot: installationState(options.installation).dataRoot,
      serviceIds: ["motis"],
      owner: authority,
    });
    beginControlEffect(authority);
    const pins = await initializeCatalogPinSet({ rootDir: options.rootDir, lease });
    retainControlEffectReceipt(authority, {
      outcome: "committed",
      publication: "committed",
      receipt: { kind: "catalog-pins-initialized", generationId: pins?.generationId ?? null },
    });
    await settleArtifactTargetLeaseChild(
      lease,
      verifyControlEffectSettlement(
        options.installation,
        executionAuthorityState(authority).execution,
      ),
    );
    await releaseArtifactTargetLease(lease);
    lease = undefined;
    return pins;
  } finally {
    if (lease) closeArtifactTargetLeaseHandle(lease);
  }
}
