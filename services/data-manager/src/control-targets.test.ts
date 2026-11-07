import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as control from "@openmapx/core/build-artifacts";
import { createControlRootOperationKey, executionFingerprint } from "@openmapx/core/ops";
import { expect, it } from "vitest";
import { DATA_MANAGER_CONTROL_SERVICE_IDS } from "./control-targets";

it("admits the application update target closure using the production Data Manager registration", async () => {
  const root = mkdtempSync(join(tmpdir(), "omx-dm-startup-targets-"));
  mkdirSync(join(root, "data"), { mode: 0o700 });
  await control.provisionControlInstallation(root);
  const dm = control.openControlInstallation({
    infraDir: root,
    role: "data-manager",
    serviceIds: DATA_MANAGER_CONTROL_SERVICE_IDS,
  });
  const kind = "configuration-maintenance.prepare";
  const operation = { kind, maintenanceId: randomUUID() };
  const deadlineAt = Date.now() + 60000;
  const operationFingerprint = control.controlDigest(operation);
  const execution = {
    executor: "data-manager" as const,
    principal: "data-manager" as const,
    executionId: randomUUID(),
    operationKey: createControlRootOperationKey({ notAfter: deadlineAt, nonce: randomBytes(16) }),
    operationFingerprint,
    deadlineAt,
    fingerprint: executionFingerprint({ kind, operationFingerprint, deadlineAt }),
  };
  try {
    expect(() =>
      control.retainAdmittedControlExecution(dm, {
        execution,
        kind,
        operation,
        admittedAt: Date.now(),
        requestedDeadlineAt: deadlineAt,
        serviceIds: [
          "app-api",
          "app-web",
          "brouter",
          "data-manager",
          "martin",
          "ops-agent",
          "overpass",
          "postgis",
          "redis",
          "tileserver",
          "transitous-runner",
          "valhalla",
          "well-known",
        ],
      }),
    ).not.toThrow();
    expect(() =>
      control.retainAdmittedControlExecution(dm, {
        execution,
        kind,
        operation,
        admittedAt: Date.now(),
        requestedDeadlineAt: deadlineAt,
        serviceIds: ["unregistered-service"],
      }),
    ).toThrow("Unregistered execution role/targets");
  } finally {
    control.closeControlInstallation(dm);
    rmSync(root, { recursive: true, force: true });
  }
});
