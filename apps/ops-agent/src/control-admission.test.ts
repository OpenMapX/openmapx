import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as control from "@openmapx/core/build-artifacts";
import {
  createControlRootOperationKey,
  type ExecutionRef,
  executionFingerprint,
  opsOperationFingerprint,
} from "@openmapx/core/ops";
import { expect, it } from "vitest";
import { type OpsJobJournal, openOpsJobJournal } from "./journal";
import { buildOpsAgentServer } from "./server";

it.each(["normal", "ready-failure", "wrong-target"])(
  "adopts at authenticated HTTP admission without replay (%s)",
  async (scenario) => {
    const failReadyWrite = scenario === "ready-failure";
    const serviceIds = scenario === "wrong-target" ? ["osrm"] : ["motis"];
    const root = mkdtempSync(join(tmpdir(), "omx-control-http-"));
    mkdirSync(join(root, "data"), { mode: 0o700 });
    await control.provisionControlInstallation(root);
    const dm = control.openControlInstallation({
      infraDir: root,
      role: "data-manager",
      serviceIds: ["motis", "osrm"],
    });
    const agent = control.openControlInstallation({
      infraDir: root,
      role: "ops-agent",
      serviceIds: ["motis", "osrm"],
    });
    const operation = { kind: "transit-sync" };
    const hash = opsOperationFingerprint({ kind: "motis.primary.stop" });
    const deadlineAt = Date.now() + 60000;
    // The source root uses its canonical data-input digest.
    const { createHash } = await import("node:crypto");
    const rootHash = createHash("sha256").update(JSON.stringify(operation)).digest("hex");
    const owner: ExecutionRef = {
      executor: "data-manager",
      principal: "data-manager",
      executionId: randomUUID(),
      operationKey: createControlRootOperationKey({ notAfter: deadlineAt, nonce: randomBytes(16) }),
      operationFingerprint: rootHash,
      deadlineAt,
      fingerprint: executionFingerprint({
        kind: operation.kind,
        operationFingerprint: rootHash,
        deadlineAt,
      }),
    };
    const child: ExecutionRef = {
      executor: "ops-agent",
      principal: "data-manager",
      executionId: `job1_${randomUUID().replaceAll("-", "")}`,
      operationKey: control.controlChildOperationKey(owner.operationKey, "stop-primary", 0),
      operationFingerprint: hash,
      deadlineAt,
      fingerprint: executionFingerprint({
        kind: "motis.primary.stop",
        operationFingerprint: hash,
        deadlineAt,
        parent: control.retainedControlParent(owner),
      }),
    };
    const plan = {
      phase: "stop-primary" as const,
      ordinal: 0,
      kind: "motis.primary.stop",
      execution: child,
      serviceIds,
      recipient: "ops-agent" as const,
    };
    const authority = control.retainAdmittedControlExecution(dm, {
      requestedDeadlineAt: owner.deadlineAt,
      execution: owner,
      kind: operation.kind,
      operation,
      admittedAt: deadlineAt - 60000,
      serviceIds,
      plan: [plan],
    });
    const lease = await control.acquireArtifactTargetLease({
      dataRoot: join(root, "data"),
      serviceIds,
      owner: authority,
    });
    const assertion = await control.delegateArtifactTargetLease(lease, {
      ...plan,
      childPublicKey: agent.publicKey,
    });
    let calls = 0;
    const token = "b".repeat(32);
    const journalFile = join(root, "data/ops-agent/jobs-v1.json");
    const options = {
      tokens: { api: "a".repeat(32), "data-manager": token },
      controlInstallation: agent,
      resourcePolicy: { allowGlobal: () => true, allowService: () => true },
      dispatch: async () => {
        calls++;
        return { changed: true, state: "stopped" };
      },
    };
    const journal = await openOpsJobJournal(journalFile);
    let writes = 0;
    const controlledJournal: OpsJobJournal = {
      records: () => journal.records(),
      replace: async (records) => {
        if (failReadyWrite && ++writes === 2) throw Error("synthetic ready journal failure");
        await journal.replace(records);
      },
    };
    const app = buildOpsAgentServer({ ...options, journal: controlledJournal });
    const request = () =>
      app.inject({
        method: "POST",
        url: "/v1/operations",
        headers: {
          authorization: `Bearer ${token}`,
          "x-ops-protocol-version": "2",
          "x-openmapx-control-delegation": assertion,
        },
        payload: {
          version: 2,
          requestId: `ops1_${randomUUID().replaceAll("-", "")}`,
          operationKey: child.operationKey,
          issuedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 10000).toISOString(),
          operation: { kind: "motis.primary.stop" },
          execution: { requestedDeadlineAt: deadlineAt },
        },
      });
    try {
      const result = await request();
      if (scenario === "wrong-target") {
        expect(result.statusCode, result.body).toBe(403);
        expect(calls).toBe(0);
        expect(journal.records()).toHaveLength(0);
        return;
      }
      if (failReadyWrite) {
        expect(result.statusCode).toBe(500);
        expect(calls).toBe(0);
        expect((await request()).statusCode).toBe(202);
        expect(journal.records()[0]).toMatchObject({
          state: "failed",
          errorClass: "recovery_required",
          controlAdoption: { phase: "recovery_required" },
        });
        await expect(control.releaseArtifactTargetLease(lease)).rejects.toThrow();
        return;
      }
      expect(result.statusCode, result.body).toBe(202);
      await expect
        .poll(
          async () =>
            (
              await app.inject({
                url: `/v1/operations/${child.executionId}`,
                headers: { authorization: `Bearer ${token}`, "x-ops-protocol-version": "2" },
              })
            ).json().result.state,
        )
        .toBe("succeeded");
      expect((await request()).statusCode).toBe(202);
      expect(calls).toBe(1);
      await app.close();
      const replacement = buildOpsAgentServer({
        ...options,
        journal: await openOpsJobJournal(journalFile),
      });
      await replacement.ready();
      expect(calls).toBe(1);
      await replacement.close();
      control.retainControlEffectReceipt(authority, {
        outcome: "failed_without_effect",
        publication: "not_started",
        receipt: { kind: "not-started" },
      });
      await control.settleArtifactTargetLeaseChild(
        lease,
        control.verifyControlEffectSettlement(dm, owner),
      );
      await control.releaseArtifactTargetLease(lease);
      const releasedRestart = buildOpsAgentServer({
        ...options,
        journal: await openOpsJobJournal(journalFile),
      });
      const status = await releasedRestart.inject({
        url: `/v1/operations/${child.executionId}`,
        headers: { authorization: `Bearer ${token}`, "x-ops-protocol-version": "2" },
      });
      expect(status.json().result.state).toBe("succeeded");
      await releasedRestart.close();
    } finally {
      await app.close();
      control.closeArtifactTargetLeaseHandle(lease);
      control.closeControlInstallation(agent);
      control.closeControlInstallation(dm);
      rmSync(root, { recursive: true, force: true });
    }
  },
);
