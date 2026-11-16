import { randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createControlRootOperationKey } from "../ops";
import { executionFingerprint } from "../ops/execution-identity";
import { opsOperationFingerprint } from "../ops/fingerprint";

const space = vi.hoisted(() => ({ low: false }));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return {
    ...actual,
    statfsSync: (...args: Parameters<typeof actual.statfsSync>) => {
      const value = actual.statfsSync(...args);
      return space.low ? { ...value, bavail: 0 } : value;
    },
  };
});

const roots: string[] = [];
afterEach(() => {
  space.low = false;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

it("refuses a new admission before any record while the control filesystem is nearly full", async () => {
  const control = await import("./control-authority");
  const root = fs.mkdtempSync(join(tmpdir(), "omx-control-storage-"));
  roots.push(root);
  fs.mkdirSync(join(root, "data"), { mode: 0o700 });
  await control.provisionControlDirectories(root);
  const installation = control.openControlInstallation({
    infraDir: root,
    role: "host-cli",
    serviceIds: ["osrm"],
  });
  try {
    const operation = { kind: "service.restart" as const, serviceId: "osrm" },
      operationFingerprint = opsOperationFingerprint(operation),
      deadlineAt = Date.now() + 60_000,
      execution = {
        executor: "host-cli" as const,
        principal: "host-cli" as const,
        executionId: randomUUID(),
        operationKey: createControlRootOperationKey({
          notAfter: deadlineAt,
          nonce: randomBytes(16),
        }),
        operationFingerprint,
        deadlineAt,
        fingerprint: executionFingerprint({
          kind: operation.kind,
          operationFingerprint,
          deadlineAt,
        }),
      },
      input = {
        requestedDeadlineAt: deadlineAt,
        execution,
        operation,
        kind: operation.kind,
        admittedAt: deadlineAt - 60_000,
        serviceIds: ["osrm"],
      };
    space.low = true;
    expect(() => control.retainAdmittedControlExecution(installation, input)).toThrow(
      /nearly full/,
    );
    const record = join(
      root,
      "state/host-cli/control/executions",
      `${execution.operationKey}.json`,
    );
    expect(fs.existsSync(record)).toBe(false);
    space.low = false;
    control.retainAdmittedControlExecution(installation, input);
    expect(fs.existsSync(record)).toBe(true);
  } finally {
    control.closeControlInstallation(installation);
  }
});
