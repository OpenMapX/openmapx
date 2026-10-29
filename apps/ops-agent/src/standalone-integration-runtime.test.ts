import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
import { createDeterministicTarGz } from "../../../packages/integration-framework/src/deterministic-tar";
import { ArtifactTransferStore } from "./artifact-transfer/store";
import type { OpsExecutionContext } from "./runtime";
import { createUnavailableRuntime, dispatchOpsOperation } from "./runtime";
import { installStandaloneIntegrationRuntime } from "./standalone-integration-runtime";

const cleanup: (() => void)[] = [];
afterEach(() => {
  cleanup
    .reverse()
    .splice(0)
    .forEach((fn) => {
      fn();
    });
});
it.each(["normal", "upload-mutated", "forged-completion"] as const)(
  "dispatches uploaded standalone installation and restart settlement under original signed receipts (scenario=%s)",
  async (scenario) => {
    const root = mkdtempSync(join(tmpdir(), "openmapx-stage-consumer-"));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const infra = join(root, "infra");
    mkdirSync(join(infra, "data"), { recursive: true });
    mkdirSync(join(root, "services"));
    await control.provisionControlInstallation(infra);
    const installation = control.openControlInstallation({
      infraDir: infra,
      role: "ops-agent",
      serviceIds: ["app-api"],
    });
    cleanup.push(() => control.closeControlInstallation(installation));
    let store = new ArtifactTransferStore({
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
    const runtime = createUnavailableRuntime();
    installStandaloneIntegrationRuntime(runtime, { rootDir: root, store });
    const inspection = await dispatchOpsOperation(runtime, operation, context);
    expect(inspection).toMatchObject({
      sourceKind: "uploaded-artifact",
      integrationId: "upload-fixture",
      archiveSha256: sha256,
      denials: [],
    });
    const transactionId = randomUUID();
    const installing: OpsOperation = {
      kind: "integration.install",
      inspectionId: inspection.inspectionId,
      ownerId: "fixture-admin",
      expectedContentDigest: inspection.contentDigest,
      operationId: transactionId,
    };
    await expect(
      dispatchOpsOperation(
        runtime,
        { ...installing, ownerId: "foreign" },
        makeContext({ ...installing, ownerId: "foreign" }),
      ),
    ).rejects.toThrow(/owner/);
    const inspectionPath = join(
      root,
      "stage-meta/integrations",
      `inspection-${inspection.inspectionId}.json`,
    );
    const originalBytes = readFileSync(inspectionPath),
      envelope = JSON.parse(originalBytes.toString("utf8")),
      forgedRecord = JSON.parse(envelope.body);
    forgedRecord.ownerId = "foreign";
    writeFileSync(
      inspectionPath,
      JSON.stringify({ ...envelope, body: JSON.stringify(forgedRecord) }),
    );
    try {
      await expect(
        dispatchOpsOperation(runtime, installing, makeContext(installing)),
      ).rejects.toThrow(/authentication/);
    } finally {
      writeFileSync(inspectionPath, originalBytes);
    }
    if (scenario === "upload-mutated") {
      writeFileSync(join(root, "stages", stage.stageId, "content"), Buffer.from("changed"));
      await expect(
        dispatchOpsOperation(runtime, installing, makeContext(installing)),
      ).rejects.toThrow(/content changed/);
      expect(existsSync(join(root, "custom_integrations", "upload-fixture"))).toBe(false);
      return;
    }
    const installContext = makeContext(installing);
    const result = await dispatchOpsOperation(runtime, installing, installContext);
    expect(result).toMatchObject({
      outcome: "published",
      integrationId: "upload-fixture",
      contentDigest: inspection.contentDigest,
    });
    await expect(
      store.deleteStage({ stageId: stage.stageId, ownerId: "fixture-admin" }),
    ).rejects.toMatchObject({ statusCode: 409 });
    if (scenario === "forged-completion") {
      const staging = join(root, "custom_integrations/.staging");
      const workspace = readdirSync(staging).find(
        (name) =>
          name.startsWith("preparation-") && existsSync(join(staging, name, "publication.json")),
      );
      if (!workspace) throw Error("Missing actual shared publication journal");
      const path = join(staging, workspace, "publication.json"),
        record = JSON.parse(readFileSync(path, "utf8"));
      writeFileSync(path, JSON.stringify({ ...record, outcome: "committed" }));
      rmSync(join(root, "custom_integrations", "upload-fixture"), { recursive: true });
      await expect(dispatchOpsOperation(runtime, installing, installContext)).rejects.toThrow(
        /ENOENT|publication|changed|Published/i,
      );
      const settle: OpsOperation = {
        kind: "integration.settle",
        transactionId,
        decision: "commit",
        expectedContentDigest: inspection.contentDigest,
      };
      await expect(dispatchOpsOperation(runtime, settle, makeContext(settle))).rejects.toThrow(
        /journal|publication|changed|auth/i,
      );
      expect(
        (
          await store.getStage({
            stageId: stage.stageId,
            ownerId: "fixture-admin",
            purpose: stage.purpose,
          })
        ).state,
      ).toBe("claimed");
      return;
    }
    store.close();
    store = new ArtifactTransferStore({
      dataRoot: join(root, "stages"),
      privateRoot: join(root, "stage-meta"),
      token: "fixture-test-token",
      capacity: () => ({ bytes: 2 * 1024 ** 3, inodes: 100000 }),
    });
    expect(
      (
        await store.getStage({
          stageId: stage.stageId,
          ownerId: "fixture-admin",
          purpose: stage.purpose,
        })
      ).state,
    ).toBe("claimed");
    await expect(
      store.deleteStage({ stageId: stage.stageId, ownerId: "fixture-admin" }),
    ).rejects.toMatchObject({ statusCode: 409 });
    const replacement = createUnavailableRuntime();
    installStandaloneIntegrationRuntime(replacement, { rootDir: root, store });
    const settle: OpsOperation = {
      kind: "integration.settle",
      transactionId,
      decision: "commit",
      expectedContentDigest: inspection.contentDigest,
    };
    const settleContext = makeContext(settle);
    expect(await dispatchOpsOperation(replacement, settle, settleContext)).toMatchObject({
      outcome: "committed",
      transactionId,
    });
    expect(await dispatchOpsOperation(replacement, settle, settleContext)).toMatchObject({
      outcome: "committed",
      transactionId,
    });
    expect(
      (
        await store.getStage({
          stageId: stage.stageId,
          ownerId: "fixture-admin",
          purpose: stage.purpose,
        })
      ).state,
    ).toBe("consumed");
    await expect(
      dispatchOpsOperation(
        replacement,
        { ...settle, decision: "restore" },
        makeContext({ ...settle, decision: "restore" }),
      ),
    ).rejects.toThrow(/different decision/);
  },
);
