import { createInterface } from "node:readline";
import { inspectControlAdmission } from "../peer-admission";
import * as l from "../target-lease";
import { verifiedParentForArtifactDelegation } from "../target-lease";
import * as c from "./control";

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
        serviceIds: input.admitted.serviceIds,
        owner: authority,
      });
      const delegation = await l.delegateArtifactTargetLease(lease, input.child);
      c.retainControlEffectReceipt(authority, {
        outcome: "failed_without_effect",
        publication: "not_started",
        receipt: { kind: "not-started" },
      });
      process.stdout.write(`${JSON.stringify({ ok: true, delegation, leaseId: lease.leaseId })}\n`);
      await new Promise(() => setInterval(() => {}, 60000));
    } else if (input.mode === "fixed") {
      const installation = c.openFixedChildInstallation({
        infraDir: input.infraDir,
        child: input.leaseChild,
      });
      const intent = c.readFixedCliSpawnIntent(installation, input.execution, input.args);
      const peer = c.verifyFixedCliControlPeer(installation, {
        leaseChild: input.leaseChild,
        execution: input.execution,
        kind: intent.operation.kind,
      });
      const parent = verifiedParentForArtifactDelegation(
        installation,
        input.leaseChild,
        input.execution,
      );
      const lease = await l.adoptArtifactTargetLease({
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
        leaseChild: input.leaseChild,
        serviceIds: intent.serviceIds,
        ...(intent.reservations ? { reservations: intent.reservations } : {}),
      });
      l.bindBorrowedControlExecution(lease, authority);
      if (input.action === "cancel") await l.cancelArtifactTargetLease(lease);
      if (input.action === "run") c.beginFixedCliExecution(installation, input.execution);
      let delegation: c.ControlDelegation | undefined;
      if (input.child) delegation = await l.delegateArtifactTargetLease(lease, input.child);
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
      process.stdout.write(`${JSON.stringify({ ok: true, leaseId: lease.leaseId, delegation })}\n`);
    } else if (input.role === "data-manager") {
      // Data-manager never reads the lease store: it admits the child its
      // caller states and settles it by identity.
      const installation = c.openControlInstallation({
        infraDir: input.infraDir,
        role: "data-manager",
        serviceIds: ["motis", "osrm"],
      });
      const delegation = c.inspectRemoteDelegation(
        installation,
        input.delegation,
        input.transportPrincipal ?? "ops-agent",
      );
      if (c.controlDigest(delegation.execution) !== c.controlDigest(input.execution))
        throw Error("Delegated execution differs");
      const authority = c.retainAdmittedControlExecution(installation, {
        requestedDeadlineAt: input.execution.deadlineAt,
        execution: input.execution,
        kind: input.kind,
        operation: input.operation,
        admittedAt: input.admittedAt,
        parent: delegation.verifiedParent,
        serviceIds: [...delegation.serviceIds],
      });
      if (input.settle) {
        c.retainControlEffectReceipt(authority, {
          outcome: "failed_without_effect",
          publication: "not_started",
          receipt: { kind: "not-started" },
        });
        await l.settleOwnLeaseChild(installation, input.execution);
      }
      process.stdout.write(`${JSON.stringify({ ok: true })}\n`);
    } else {
      const installation = c.openControlInstallation({
        infraDir: input.infraDir,
        role: input.role,
        serviceIds: ["motis", "osrm"],
      });
      const admission = !input.primitive
        ? inspectControlAdmission(installation, {
            leaseChild: input.leaseChild,
            transportPrincipal: input.transportPrincipal ?? "data-manager",
            kind: input.kind,
            operation: input.operation,
            operationKey: input.execution.operationKey,
            operationFingerprint: input.execution.operationFingerprint,
            requestedDeadlineAt: input.execution.deadlineAt,
          })
        : (() => {
            // Primitive protocol fixture, not the production operation adapter.
            const inspected = l.inspectArtifactDelegation({
              leaseChild: input.leaseChild,
              installation,
            });
            const peer = c.verifyControlPeer(installation, {
              leaseChild: input.leaseChild,
              transportPrincipal: input.transportPrincipal ?? "data-manager",
              execution: input.execution,
              kind: input.kind,
            });
            return {
              ...inspected,
              parent: verifiedParentForArtifactDelegation(
                installation,
                input.leaseChild,
                input.execution,
              ),
              adopt: (execution: typeof input.execution) =>
                l.adoptArtifactTargetLease({
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
        leaseChild: input.leaseChild,
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
