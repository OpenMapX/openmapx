import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as control from "@openmapx/core/build-artifacts";
import {
  createControlRootOperationKey,
  normalizeExecutionAdmission,
  type OpsOperation,
  opsOperationFingerprint,
} from "@openmapx/core/ops";
import {
  createIntegrationArtifactPreparation,
  describePreparedIntegration,
  publishPreparedIntegration,
  settleIntegrationPublication,
} from "@openmapx/integration-framework/installer";
import { afterEach, expect, it } from "vitest";
import { createDeterministicTarGz } from "../../../../packages/integration-framework/src/deterministic-tar";
import type { OpsExecutionContext } from "../runtime";
import { ArtifactTransferStore } from "./store";

const cleanup: (() => void)[] = [];
afterEach(() => {
  cleanup
    .reverse()
    .splice(0)
    .forEach((fn) => {
      fn();
    });
});
it("validates real uploaded bytes only under the exact retained integration execution", async () => {
  const root = mkdtempSync(join(tmpdir(), "openmapx-stage-consumer-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const infra = join(root, "infra");
  mkdirSync(join(infra, "data"), { recursive: true, mode: 0o700 });
  mkdirSync(join(root, "services"), { mode: 0o755 });
  await control.provisionControlInstallation(infra);
  const installation = control.openControlInstallation({
    infraDir: infra,
    role: "ops-agent",
    serviceIds: ["app-api"],
  });
  cleanup.push(() => control.closeControlInstallation(installation));
  const store = new ArtifactTransferStore({
    dataRoot: join(root, "stages"),
    privateRoot: join(root, "stage-meta"),
    token: "fixture-test-token",
    capacity: () => ({ bytes: 2 * 1024 ** 3, inodes: 100000 }),
  });
  cleanup.push(() => store.close());
  const bytes = createDeterministicTarGz([
    {
      path: "manifest.json",
      contents: Buffer.from(
        JSON.stringify({
          id: "upload-fixture",
          name: "Uploaded",
          version: "1.0.0",
          platform: "1.0",
          quality: "community",
          domains: ["map-overlay"],
        }),
      ),
    },
  ]);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const stage = await store.createStage({
    purpose: "integration-artifact",
    direction: "upload",
    ownerId: "fixture-admin",
    declaredBytes: bytes.length,
    expectedSha256: sha256,
    operationKey: `opk1_${randomUUID().replaceAll("-", "")}`,
  });
  await store.upload({
    stageId: stage.stageId,
    ownerId: "fixture-admin",
    purpose: stage.purpose,
    attemptId: randomUUID(),
    deadlineAt: Date.now() + 60000,
    body: new ReadableStream({
      start(c) {
        c.enqueue(bytes);
        c.close();
      },
    }),
  });
  const operation: OpsOperation = {
    kind: "integration.inspectInstall",
    ownerId: "fixture-admin",
    source: { kind: "uploaded-artifact", stageId: stage.stageId, expectedSha256: sha256 },
  };
  const makeContext = (operation: OpsOperation): OpsExecutionContext => {
    const admittedAt = Date.now(),
      operationFingerprint = opsOperationFingerprint(operation),
      operationKey = createControlRootOperationKey({
        notAfter: admittedAt + 600000,
        nonce: randomBytes(16),
      }),
      admission = normalizeExecutionAdmission({
        operationFingerprint,
        operationKey,
        kind: operation.kind,
        admittedAt,
        requestedDeadlineAt: admittedAt + 600000,
      });
    const execution = {
      executor: "ops-agent" as const,
      principal: "api" as const,
      executionId: `job1_${randomUUID().replaceAll("-", "")}`,
      operationKey,
      operationFingerprint,
      deadlineAt: admission.deadlineAt,
      fingerprint: admission.fingerprint,
    };
    const authority = control.retainAdmittedControlExecution(installation, {
      execution,
      kind: operation.kind,
      operation,
      admittedAt,
      requestedDeadlineAt: admittedAt + 600000,
      serviceIds: ["app-api"],
    });
    return {
      execution,
      controlAuthority: authority,
      signal: new AbortController().signal,
      emitLog: () => {},
      claim: {
        fingerprint: operationFingerprint,
        operation,
        source: "registry",
        capability: { revisionId: "fixture", values: {} },
      },
    };
  };
  const context = makeContext(operation);
  const preparedContext = createIntegrationArtifactPreparation({ rootDir: root });
  const result = await store.validateIntegrationArtifact(context, preparedContext);
  expect(result.inspection).toMatchObject({ stageId: stage.stageId, sha256, bytes: bytes.length });
  expect(describePreparedIntegration(result.prepared)).toMatchObject({
    id: "upload-fixture",
    archiveSha256: sha256,
  });
  expect(
    (
      await store.getStage({
        stageId: stage.stageId,
        ownerId: "fixture-admin",
        purpose: stage.purpose,
      })
    ).state,
  ).toBe("ready");
  expect(
    await store.inspectClaim({
      stageId: stage.stageId,
      ownerId: "fixture-admin",
      identity: result.claim.identity,
    }),
  ).toMatchObject({ settlement: { outcome: "validated", inspection: result.inspection } });
  await expect(store.claimStage({ ...result.claim, expectedSha256: sha256 })).rejects.toMatchObject(
    { statusCode: 409 },
  );
  await expect(
    store.validateIntegrationArtifact(
      { ...context, controlAuthority: undefined },
      createIntegrationArtifactPreparation({ rootDir: root }),
    ),
  ).rejects.toThrow(/authority|execution/i);
  const transactionId = randomUUID();
  const installing = makeContext({
    kind: "integration.install",
    inspectionId: result.inspection.inspectionId,
    ownerId: "fixture-admin",
    expectedContentDigest: result.prepared.contentDigest,
    operationId: transactionId,
  });
  const installClaim = await store.claimIntegrationArtifactInstall(installing, result.inspection);
  await expect(
    store.deleteStage({ stageId: stage.stageId, ownerId: "fixture-admin" }),
  ).rejects.toMatchObject({ statusCode: 409 });
  const publication = await publishPreparedIntegration(result.prepared, {
    journal: store.standalonePublicationJournal(installing),
    transactionId,
    expectedPreviousContentDigest: null,
    signal: installing.signal,
  });
  const settling = makeContext({
    kind: "integration.settle",
    transactionId,
    decision: "commit",
    expectedContentDigest: result.prepared.contentDigest,
  });
  await expect(
    store.settleIntegrationArtifact(settling, installClaim, publication),
  ).rejects.toThrow(/settled|terminal|committed/);
  await settleIntegrationPublication(publication, "commit", settling.signal);
  expect((await store.settleIntegrationArtifact(settling, installClaim, publication)).state).toBe(
    "consumed",
  );
  expect((await store.settleIntegrationArtifact(settling, installClaim, publication)).state).toBe(
    "consumed",
  );
  expect(
    await store.inspectClaim({
      stageId: stage.stageId,
      ownerId: "fixture-admin",
      identity: installClaim.identity,
    }),
  ).toMatchObject({ settlement: { outcome: "consumed", receiptId: transactionId } });
  await expect(
    store.claimIntegrationArtifactInstall(
      makeContext({
        ...installing.claim.operation,
        kind: "integration.install",
        inspectionId: result.inspection.inspectionId,
        ownerId: "fixture-admin",
        expectedContentDigest: result.prepared.contentDigest,
        operationId: randomUUID(),
      }),
      result.inspection,
    ),
  ).rejects.toMatchObject({ statusCode: 409 });
});
