import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  closeControlInstallation,
  openControlInstallation,
  provisionControlDirectories,
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
  await provisionControlDirectories(root);
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
