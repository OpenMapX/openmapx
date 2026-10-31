import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import * as c from "../control-authority";
import { AnchoredDirectory } from "../filesystem";
import { inspectControlAdmission, verifiedParentForArtifactDelegation } from "../peer-admission";
import * as l from "../target-lease";

for await (const line of createInterface({ input: process.stdin })) {
  try {
    const input = JSON.parse(line);
    if (input.mode === "retention") {
      if (input.now) Date.now = () => input.now;
      if (input.assertPrivateRole) {
        const read = AnchoredDirectory.prototype.read;
        AnchoredDirectory.prototype.read = function (name, max, privateMode) {
          const role = this.path.match(
            /control-private\/(ops-agent|data-manager|host-cli)(?:\/|$)/,
          )?.[1];
          if (role && role !== (input.role ?? "host-cli"))
            throw Error("Sibling private read forbidden");
          return read.call(this, name, max, privateMode);
        };
      }
      const installation = c.openControlInstallation({
        infraDir: input.infraDir,
        role: input.role ?? "host-cli",
        serviceIds: ["motis", "osrm"],
      });
      const write = AnchoredDirectory.prototype.write;
      let injected = false;
      AnchoredDirectory.prototype.write = function (name, bytes, exclusive, beforePublish) {
        write.call(this, name, bytes, exclusive, beforePublish);
        if (
          input.fault &&
          !injected &&
          (name === ".retention-transaction" || name === "retention-slot-transaction.json")
        ) {
          const value = JSON.parse(bytes.toString());
          if (
            (name === ".retention-transaction" && value?.phase === input.fault) ||
            (name === "retention-slot-transaction.json" &&
              input.fault === "slot_planned" &&
              value?.phase === "planned")
          ) {
            injected = true;
            if (input.kill) {
              process.stdout.write(`${JSON.stringify({ ready: true })}\n`);
              while (true) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
            }
            throw Error("Contained synthetic fault after durable quota phase");
          }
        }
      };
      const result = await c.reconcileControlRetention(installation, {
        maxFamilies: input.maxFamilies ?? 1,
      });
      c.closeControlInstallation(installation);
      process.stdout.write(`${JSON.stringify({ ok: true, ...result, injected })}\n`);
    } else if (input.mode === "deadline-lease") {
      const installation = c.openControlInstallation({
        infraDir: input.infraDir,
        role: input.role,
        serviceIds: ["motis", "osrm"],
      });
      const peer = c.verifyControlPeer(installation, {
        rawHeaders: ["x-openmapx-parent-execution", input.assertion],
        transportPrincipal: "shared-data-manager-bearer",
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
        dataRoot: join(input.infraDir, "data"),
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
    } else if (input.mode === "observe-interleaving") {
      const installation = c.openControlInstallation({
        infraDir: input.infraDir,
        role: "data-manager",
        serviceIds: ["motis"],
      });
      const read = AnchoredDirectory.prototype.read;
      let paused = false;
      AnchoredDirectory.prototype.read = function (name, max, privateMode) {
        const bytes = read.call(this, name, max, privateMode);
        if (!paused && this.path.endsWith("/observations")) {
          paused = true;
          writeFileSync(input.ready, "ready");
          const until = Date.now() + 10000;
          while (!existsSync(input.resume)) {
            if (Date.now() >= until) throw Error("Interleaving resume timed out");
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
          }
        }
        return bytes;
      };
      l.inspectArtifactDelegation({
        dataRoot: join(input.infraDir, "data"),
        assertion: input.assertion,
        installation,
      });
      process.stdout.write(`${JSON.stringify({ ok: true })}\n`);
    } else if (input.mode === "owner") {
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
        dataRoot: join(input.infraDir, "data"),
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
                (input.role === "ops-agent" ? "data-manager" : "shared-data-manager-bearer"),
              kind: input.kind,
              operation: input.operation,
              operationKey: input.execution.operationKey,
              operationFingerprint: input.execution.operationFingerprint,
              requestedDeadlineAt: input.execution.deadlineAt,
            })
          : (() => {
              // Primitive protocol fixture, not the future generation-bound DM HTTP adapter.
              const inspected = l.inspectArtifactDelegation({
                dataRoot: join(input.infraDir, "data"),
                assertion: input.assertion,
                installation,
              });
              const peer = c.verifyControlPeer(installation, {
                rawHeaders: ["x-openmapx-control-delegation", input.assertion],
                transportPrincipal:
                  input.transportPrincipal ??
                  (input.role === "ops-agent" ? "data-manager" : "shared-data-manager-bearer"),
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
                    dataRoot: join(input.infraDir, "data"),
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
