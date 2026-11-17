import { createInterface } from "node:readline";
import * as c from "../control-authority";
import { inspectControlAdmission } from "../peer-admission";
import * as l from "../target-lease";
import { verifiedParentForArtifactDelegation } from "../target-lease";

for await (const line of createInterface({ input: process.stdin })) {
  try {
    const input = JSON.parse(line);
    if (input.mode === "deadline-lease") {
      const installation = c.openControlInstallation({
        infraDir: input.infraDir,
        role: input.role,
        serviceIds: ["motis", "osrm"],
      });
      const peer = c.verifyControlPeer(installation, {
        rawHeaders: ["x-openmapx-parent-execution", input.assertion],
        transportPrincipal: "ops-agent",
        execution: input.execution,
        kind: input.operation.kind,
      });
      const parent = c.verifyParentExecution(input.assertion, peer, {
        execution: input.execution,
        kind: input.operation.kind,
        requestedDeadlineAt: input.execution.deadlineAt,
      });
      const authority = c.retainAdmittedControlExecution(installation, {
        execution: input.execution,
        operation: input.operation,
        kind: input.operation.kind,
        admittedAt: input.admittedAt,
        parent,
        serviceIds: ["osrm"],
      });
      const lease = await l.acquireArtifactTargetLease({
        serviceIds: ["osrm"],
        owner: authority,
      });
      c.retainControlEffectReceipt(authority, {
        outcome: "failed_without_effect",
        publication: "not_started",
        receipt: { kind: "not-started" },
      });
      await l.settleArtifactTargetLeaseChild(
        lease,
        c.verifyControlEffectSettlement(installation, input.execution),
      );
      await l.releaseArtifactTargetLease(lease);
      const origin = c.retainedExecutionOrigin(c.installationState(installation), input.execution);
      c.closeControlInstallation(installation);
      process.stdout.write(`${JSON.stringify({ ok: true, leaseId: lease.leaseId, origin })}\n`);
    } else if (input.mode === "owner") {
      const installation = c.openControlInstallation({
        infraDir: input.infraDir,
        role: input.role,
        serviceIds: ["motis", "osrm"],
      });
      const authority = c.retainAdmittedControlExecution(installation, input.admitted);
      const lease = await l.acquireArtifactTargetLease({
        serviceIds: input.admitted.serviceIds,
        owner: authority,
      });
      if (input.fixedId) input.child.childId = c.prepareFixedControlChild(authority, input.fixedId);
      const assertion = await l.delegateArtifactTargetLease(lease, input.child);
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
        assertion: input.assertion,
        peer,
        execution: input.execution,
        serviceIds: ["motis"],
      });
      l.verifyConfigurationHelperReady(lease);
      process.stdout.write(`${JSON.stringify({ ok: true, drainPermitted: true })}\n`);
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
        assertion: input.assertion,
        peer,
        execution: input.execution,
        serviceIds: intent.serviceIds,
      });
      const authority = c.retainAdmittedControlExecution(installation, {
        requestedDeadlineAt: input.execution.deadlineAt,
        execution: input.execution,
        kind: intent.operation.kind,
        operation: intent.operation,
        admittedAt: intent.admittedAt,
        parent,
        serviceIds: intent.serviceIds,
      });
      l.bindBorrowedControlExecution(lease, authority);
      if (input.action === "cancel") await l.cancelArtifactTargetLease(lease);
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
      const admission =
        input.role === "ops-agent" && !input.primitive
          ? inspectControlAdmission(installation, {
              rawHeaders: ["x-openmapx-control-delegation", input.assertion],
              transportPrincipal:
                input.transportPrincipal ??
                (input.role === "ops-agent" ? "data-manager" : "ops-agent"),
              kind: input.kind,
              operation: input.operation,
              operationKey: input.execution.operationKey,
              operationFingerprint: input.execution.operationFingerprint,
              requestedDeadlineAt: input.execution.deadlineAt,
            })
          : (() => {
              // Primitive protocol fixture, not the future generation-bound DM HTTP adapter.
              const inspected = l.inspectArtifactDelegation({
                assertion: input.assertion,
                installation,
              });
              const peer = c.verifyControlPeer(installation, {
                rawHeaders: ["x-openmapx-control-delegation", input.assertion],
                transportPrincipal:
                  input.transportPrincipal ??
                  (input.role === "ops-agent" ? "data-manager" : "ops-agent"),
                execution: input.execution,
                kind: input.kind,
              });
              return {
                ...inspected,
                parent: verifiedParentForArtifactDelegation(
                  installation,
                  input.assertion,
                  input.execution,
                ),
                adopt: (execution: typeof input.execution) =>
                  l.adoptArtifactTargetLease({
                    assertion: input.assertion,
                    peer,
                    execution,
                    serviceIds: inspected.serviceIds,
                  }),
              };
            })();
      const lease = await admission.adopt(input.execution);
      if (input.forward) l.assertArtifactTargetLeaseForward(lease);
      const authority = c.retainAdmittedControlExecution(installation, {
        requestedDeadlineAt: input.execution.deadlineAt,
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
    process.stdout.write(
      `${JSON.stringify({ ok: false, error: (error as Error).message, stack: (error as Error).stack })}\n`,
    );
  }
  break;
}
