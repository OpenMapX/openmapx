import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  closeControlInstallation,
  openControlInstallation,
  provisionControlInstallation,
  retainAdmittedControlExecution,
} from "../../build-artifacts/control-authority";
import {
  createControlRootOperationKey,
  executionFingerprint,
  opsOperationFingerprint,
} from "../../ops";
import { openAdminDataWorkflow } from "../admin-data-workflow";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "omx-update-store-"));
  roots.push(root);
  mkdirSync(join(root, "data"), { mode: 0o700 });
  await provisionControlInstallation(root);
  const installation = openControlInstallation({
    infraDir: root,
    role: "host-cli",
    serviceIds: ["data-manager"],
  });
  const operation = {
    kind: "data.update" as const,
    regionId: "europe/germany",
    countryCodes: ["DE"],
  };
  const admittedAt = Date.now(),
    deadlineAt = admittedAt + 60000,
    operationFingerprint = opsOperationFingerprint(operation);
  const execution = {
    executor: "host-cli" as const,
    principal: "host-cli" as const,
    executionId: randomUUID(),
    operationKey: createControlRootOperationKey({ notAfter: deadlineAt, nonce: randomBytes(16) }),
    operationFingerprint,
    deadlineAt,
    fingerprint: executionFingerprint({ kind: operation.kind, operationFingerprint, deadlineAt }),
  };
  const authority = retainAdmittedControlExecution(installation, {
    execution,
    operation,
    kind: operation.kind,
    admittedAt,
    requestedDeadlineAt: deadlineAt,
    serviceIds: ["data-manager"],
  });
  return {
    root,
    installation,
    execution,
    authority,
    options: {
      dataRoot: join(root, "data"),
      operationKey: execution.operationKey,
      fingerprint: execution.fingerprint,
      authority,
    },
  };
}
const initial = {
  version: 1 as const,
  phase: "osm" as const,
  children: [],
  completedBuildIds: [],
  failedBuildIds: [],
  skippedBuildIds: [],
};
it("reopens the exact indexed workflow and refuses another owner binding", async () => {
  const f = await fixture();
  try {
    const store = await openAdminDataWorkflow(f.options);
    expect(store.read()).toBeNull();
    await store.checkpoint(initial);
    const recovered = await openAdminDataWorkflow(f.options);
    expect(recovered.read()).toEqual(initial);
    await expect(
      openAdminDataWorkflow({ ...f.options, fingerprint: "f".repeat(64) }),
    ).rejects.toThrow();
    await expect(store.checkpoint({ ...initial, phase: "complete" })).rejects.toThrow();
    expect(store.read()).toEqual(initial);
  } finally {
    closeControlInstallation(f.installation);
  }
});
it("rejects a byte-identical private progress file copied onto another inode", async () => {
  const f = await fixture();
  try {
    const store = await openAdminDataWorkflow(f.options);
    await store.checkpoint(initial);
    const path = join(
        f.root,
        "control-private/host-cli/observations",
        `data-workflow-${f.execution.operationKey}.json`,
      ),
      bytes = readFileSync(path);
    unlinkSync(path);
    writeFileSync(path, bytes, { mode: 0o600 });
    expect(() => store.read()).toThrow();
  } finally {
    closeControlInstallation(f.installation);
  }
});
it("refuses a successful Full Update result without its actual retained workflow", async () => {
  const f = await fixture();
  try {
    const { retainControlEffectReceipt } = await import("../../build-artifacts/control-authority");
    const receipt = {
      ...initial,
      phase: "complete" as const,
      revisionId: `cfg1_${"r".repeat(43)}`,
      children: ["osm", "transit", "fonts"].map((step) => ({
        step,
        jobId: randomUUID(),
        operationKey: `opk1_${"a".repeat(32)}`,
        fingerprint: "f".repeat(64),
        deadlineAt: f.execution.deadlineAt,
        status: "succeeded",
      })),
    };
    expect(() =>
      retainControlEffectReceipt(f.authority, {
        outcome: "committed",
        publication: "committed",
        receipt: { kind: "ops-result", result: { completed: true, dataWorkflow: receipt } },
      }),
    ).toThrow();
  } finally {
    closeControlInstallation(f.installation);
  }
});
it("does not turn signed business progress into proof that data or graph effects ran", async () => {
  const f = await fixture();
  try {
    const { retainControlEffectReceipt } = await import("../../build-artifacts/control-authority");
    const receipt = {
      ...initial,
      phase: "complete" as const,
      revisionId: `cfg1_${"r".repeat(43)}`,
      children: (["osm", "transit", "fonts"] as const).map((step, index) => ({
        step,
        jobId: randomUUID(),
        operationKey: `opk1_${String(index).repeat(32)}`,
        fingerprint: "f".repeat(64),
        deadlineAt: f.execution.deadlineAt,
        status: "succeeded" as const,
      })),
    };
    const store = await openAdminDataWorkflow(f.options);
    await store.checkpoint(receipt);
    expect(() =>
      retainControlEffectReceipt(f.authority, {
        outcome: "committed",
        publication: "committed",
        receipt: { kind: "ops-result", result: { completed: true, dataWorkflow: receipt } },
      }),
    ).toThrow();
  } finally {
    closeControlInstallation(f.installation);
  }
});
