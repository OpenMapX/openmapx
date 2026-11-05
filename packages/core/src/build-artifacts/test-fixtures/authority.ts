import { randomBytes, randomUUID } from "node:crypto";
import { createControlRootOperationKey } from "../../ops/control-root-key";
import { type ControlIssuer, executionFingerprint } from "../../ops/execution-identity";
import { opsOperationFingerprint } from "../../ops/fingerprint";
import * as c from "../control-authority";

export function admittedRoot(root: string, role: ControlIssuer = "host-cli", lifetime = 60000) {
  const installation = c.openControlInstallation({
    infraDir: root,
    role,
    serviceIds: ["motis", "osrm"],
  });
  const operation =
    role === "data-manager"
      ? { kind: "transit-sync" as const }
      : { kind: "service.build" as const, serviceId: "osrm" };
  const hash =
    operation.kind === "transit-sync"
      ? c.controlDigest(operation)
      : opsOperationFingerprint(operation);
  const admittedAt = Date.now(),
    deadlineAt = admittedAt + lifetime;
  const execution = {
    executor: role,
    principal: role === "ops-agent" ? ("api" as const) : role,
    executionId: role === "ops-agent" ? `job1_${randomUUID().replaceAll("-", "")}` : randomUUID(),
    operationKey: createControlRootOperationKey({ notAfter: deadlineAt, nonce: randomBytes(16) }),
    deadlineAt,
    operationFingerprint: hash,
    fingerprint: executionFingerprint({
      kind: operation.kind,
      operationFingerprint: hash,
      deadlineAt,
    }),
  };
  try {
    const authority = c.retainAdmittedControlExecution(installation, {
      execution,
      operation,
      kind: operation.kind,
      admittedAt,
      requestedDeadlineAt: deadlineAt,
      serviceIds: ["osrm"],
    });
    return { installation, execution, authority, operation };
  } catch (error) {
    c.closeControlInstallation(installation);
    throw error;
  }
}
export function terminalWithoutEffect(authority: c.VerifiedExecutionAuthority) {
  c.retainControlEffectReceipt(authority, {
    outcome: "failed_without_effect",
    publication: "not_started",
    receipt: { kind: "not-started" },
  });
}
