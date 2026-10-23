import { join } from "node:path";
import { createInterface } from "node:readline";
import * as c from "../control-authority";
import { inspectControlAdmission, verifiedParentForArtifactDelegation } from "../peer-admission";
import * as l from "../target-lease";

for await (const line of createInterface({ input: process.stdin })) {
  try {
    const input = JSON.parse(line);
    if (input.mode === "owner") {
      const installation = c.openControlInstallation({
        infraDir: input.infraDir,
        role: input.role,
        serviceIds: ["motis", "osrm"],
      });
      const authority = c.retainAdmittedControlExecution(installation, input.admitted);
      const lease = await l.acquireArtifactTargetLease({
        dataRoot: join(input.infraDir, "data"),
        serviceIds: input.admitted.serviceIds,
        owner: authority,
      });
      if (input.fixedId)
        input.child.childPublicKey = c.prepareFixedControlChild(authority, input.fixedId);
      const assertion = await l.delegateArtifactTargetLease(lease, input.child);
      if (input.prepared) c.retainControlPreparedTerminal(authority);
      c.retainControlEffectReceipt(authority, {
        outcome: "failed_without_effect",
        publication: "not_started",
        receipt: { kind: "not-started" },
      });
      process.stdout.write(`${JSON.stringify({ ok: true, assertion, leaseId: lease.leaseId })}\n`);
      await new Promise(() => setInterval(() => {}, 60000));
    } else if (input.mode === "helper") {
      const installation = c.openFixedChildInstallation({
        infraDir: input.infraDir,
        assertion: input.assertion,
      });
      const peer = c.verifyFixedCliControlPeer(installation, {
        assertion: input.assertion,
        execution: input.execution,
        kind: "configuration-helper",
        recipient: "configuration-helper",
      });
      const lease = await l.adoptArtifactTargetLease({
        dataRoot: join(input.infraDir, "data"),
        assertion: input.assertion,
        peer,
        execution: input.execution,
        serviceIds: ["motis"],
      });
      l.verifyConfigurationHelperReady(lease);
      process.stdout.write(JSON.stringify({ ok: true, drainPermitted: true }) + "\n");
    } else if (input.mode === "fixed") {
      const installation = c.openFixedChildInstallation({
        infraDir: input.infraDir,
        assertion: input.assertion,
      });
      const intent = c.readFixedCliSpawnIntent(installation, input.execution, input.args);
      const peer = c.verifyFixedCliControlPeer(installation, {
        assertion: input.assertion,
        execution: input.execution,
        kind: intent.operation.kind,
      });
      const parent = verifiedParentForArtifactDelegation(
        installation,
        input.assertion,
        input.execution,
      );
      const lease = await l.adoptArtifactTargetLease({
        dataRoot: join(input.infraDir, "data"),
        assertion: input.assertion,
        peer,
        execution: input.execution,
        serviceIds: intent.serviceIds,
      });
      const authority = c.retainAdmittedControlExecution(installation, {
        execution: input.execution,
        kind: intent.operation.kind,
        operation: intent.operation,
        admittedAt: intent.admittedAt,
        parent,
        serviceIds: intent.serviceIds,
      });
      l.bindBorrowedControlExecution(lease, authority);
      if (input.action === "run") c.beginFixedCliExecution(installation, input.execution);
      let assertion: string | undefined;
      if (input.child) assertion = await l.delegateArtifactTargetLease(lease, input.child);
      if (input.action === "settle") {
        c.retainControlEffectReceipt(authority, {
          outcome: "committed",
          publication: "committed",
          receipt: { kind: "fixed-cli-exit", args: input.args, exitCode: 0 },
        });
        await l.settleArtifactTargetLeaseChild(
          lease,
          c.verifyControlEffectSettlement(installation, input.execution),
        );
      }
      process.stdout.write(`${JSON.stringify({ ok: true, leaseId: lease.leaseId, assertion })}\n`);
    } else {
      const installation = c.openControlInstallation({
        infraDir: input.infraDir,
        role: input.role,
        serviceIds: ["motis", "osrm"],
      });
      const admission = inspectControlAdmission(installation, {
        rawHeaders: ["x-openmapx-control-delegation", input.assertion],
        transportPrincipal:
          input.transportPrincipal ??
          (input.role === "ops-agent" ? "data-manager" : "shared-data-manager-bearer"),
        kind: input.kind,
        operationKey: input.execution.operationKey,
        operationFingerprint: input.execution.operationFingerprint,
        requestedDeadlineAt: input.execution.deadlineAt,
      });
      const lease = await admission.adopt(input.execution);
      const authority = c.retainAdmittedControlExecution(installation, {
        execution: input.execution,
        kind: input.kind,
        operation: input.operation,
        admittedAt: input.admittedAt,
        parent: admission.parent,
        serviceIds: lease.serviceIds,
      });
      if (input.settle) {
        c.retainControlEffectReceipt(authority, {
          outcome: "failed_without_effect",
          publication: "not_started",
          receipt: { kind: "not-started" },
        });
        await l.settleArtifactTargetLeaseChild(
          lease,
          c.verifyControlEffectSettlement(installation, input.execution),
        );
      }
      if (input.cancel) await l.cancelArtifactTargetLease(lease);
      process.stdout.write(
        `${JSON.stringify({ ok: true, retained: admission.retained, leaseId: lease.leaseId })}\n`,
      );
    }
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: (error as Error).message })}\n`);
  }
  break;
}
