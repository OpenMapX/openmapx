import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as c from "@openmapx/core/build-artifacts";
import {
  controlTerminalReceiptDigest,
  createControlRootOperationKey,
  type OpsJobStatus,
  opsOperationFingerprint,
  parseOpsJobStatus,
  signApiRetentionProof,
} from "@openmapx/core/ops";
import { expect, it, vi } from "vitest";
import { openOpsJobJournal } from "./journal";
import { buildOpsAgentServer } from "./server";

it("retains the exact API terminal dependency until ack, retires it, and discharges lost ack responses after GC without replay", async () => {
  const root = mkdtempSync(join(tmpdir(), "omx-agent-renewal-"));
  mkdirSync(join(root, "data"), { mode: 0o700 });
  await c.provisionControlInstallation(root);
  const installation = c.openControlInstallation({
    infraDir: root,
    role: "ops-agent",
    serviceIds: ["motis"],
  });
  const token = "a".repeat(32),
    dmToken = "b".repeat(32),
    journal = await openOpsJobJournal(join(root, "data/ops-agent/jobs-v1.json")),
    dispatch = vi.fn(async () => ({ backupId: "daily" }));
  const app = buildOpsAgentServer({
    tokens: { api: token, "data-manager": dmToken },
    controlInstallation: installation,
    journal,
    dispatch,
    now: () => new Date(Date.now()),
    resourcePolicy: { allowBackup: () => true, allowGlobal: () => true },
  });
  const operation = { kind: "backup.delete" as const, backupId: "daily" },
    notAfter = Date.now() + 60000,
    key = createControlRootOperationKey({ notAfter, nonce: randomBytes(16) }),
    apiJobId = randomUUID(),
    attemptId = randomUUID();
  const fields = {
    version: 1,
    apiJobId,
    apiOwnerVersion: 1,
    parentOperationKey: "opk1_parentabcdefghijkl",
    parentFingerprint: "b".repeat(64),
    parentDeadlineAt: notAfter,
    childOperationKey: key,
    childOperationFingerprint: opsOperationFingerprint(operation),
    requestedDeadlineAt: notAfter,
    attemptId,
  };
  const payload = Buffer.from(JSON.stringify(fields)).toString("base64url"),
    parent = `${payload}.${createHmac("sha256", token).update("openmapx-api-job-parent-v1\0").update(payload).digest("base64url")}`;
  const request = (
    op: unknown,
    operationKey = key,
    headers: Record<string, string> = {},
    execution?: { requestedDeadlineAt: number },
  ) =>
    app.inject({
      method: "POST",
      url: "/v1/operations",
      headers: { authorization: `Bearer ${token}`, "x-ops-protocol-version": "2", ...headers },
      payload: {
        version: 2,
        requestId: `ops1_${randomUUID().replaceAll("-", "")}`,
        operationKey,
        issuedAt: new Date(Date.now()).toISOString(),
        expiresAt: new Date(Date.now() + 10000).toISOString(),
        operation: op,
        ...(execution ? { execution } : {}),
      },
    });
  try {
    expect((await request(operation, "opk1_oldclientabcdefghijkl")).statusCode).toBe(409);
    expect(dispatch).not.toHaveBeenCalled();
    expect(journal.records()).toHaveLength(0);
    const admitted = await request(
      operation,
      key,
      { "x-openmapx-parent-execution": parent },
      { requestedDeadlineAt: notAfter },
    );
    expect(admitted.statusCode, admitted.body).toBe(202);
    const id = admitted.json().result.operationId;
    let terminal: OpsJobStatus | undefined;
    await vi.waitFor(
      async () => {
        const response = await app.inject({
          url: `/v1/operations/${id}`,
          headers: { authorization: `Bearer ${token}`, "x-ops-protocol-version": "2" },
        });
        terminal = parseOpsJobStatus(response.json().result);
        expect(terminal?.state).toBe("succeeded");
      },
      { timeout: 15000 },
    );
    await vi.waitFor(
      () => {
        const p: { executions: Record<string, { journalContained?: boolean }> } = JSON.parse(
          readFileSync(
            join(root, "control-private/ops-agent/retention-families/slot-0/progress.json"),
            "utf8",
          ),
        );
        expect(Object.values(p.executions).every((e) => e.journalContained)).toBe(true);
      },
      { timeout: 15000 },
    );
    if (!terminal?.fingerprint) throw Error("Missing synthetic terminal identity");
    const digest = controlTerminalReceiptDigest(terminal),
      proofFields = {
        version: 1 as const,
        apiJobId,
        originalApiOwnerVersion: 1,
        attemptId,
        checkpointOwnerVersion: 1,
        terminalCopyId: randomUUID(),
        operationKey: key,
        fingerprint: terminal.fingerprint,
        terminalDigest: digest,
      };
    const ack = {
      kind: "controlRetention.acknowledge",
      originRootKey: key,
      operationKey: key,
      fingerprint: terminal.fingerprint,
      terminalDigest: digest,
      proof: signApiRetentionProof(token, proofFields),
    };
    const wall = Date.now(),
      clock = vi.spyOn(Date, "now").mockReturnValue(notAfter + 96 * 3600_000);
    expect(await c.reconcileControlRetention(installation, { maxFamilies: 1 })).toMatchObject({
      retired: 0,
      pending: 1,
    });
    expect(journal.records()).toHaveLength(1);
    const familyHash = JSON.parse(
      readFileSync(
        join(root, "control-private/ops-agent/retention-families/slot-0/identity.json"),
        "utf8",
      ),
    ).originHash;
    const ackCell = join(
      root,
      `data/.admin-target-control/retention-families/${familyHash}/api-ack.json`,
    );
    writeFileSync(
      ackCell,
      JSON.stringify({
        operationKey: key,
        fingerprint: terminal.fingerprint,
        terminalDigest: digest,
        proofDigest: "c".repeat(64),
      }),
    );
    expect(await c.reconcileControlRetention(installation, { maxFamilies: 1 })).toMatchObject({
      retired: 0,
      pending: 1,
    });
    expect(journal.records()).toHaveLength(1);
    writeFileSync(ackCell, "null");

    expect(
      (
        await request(
          operation,
          key,
          { "x-openmapx-parent-execution": parent },
          { requestedDeadlineAt: notAfter },
        )
      ).statusCode,
    ).toBe(202);
    expect(dispatch).toHaveBeenCalledTimes(1);
    const wrong = {
      ...ack,
      proof: signApiRetentionProof(token, { ...proofFields, attemptId: randomUUID() }),
    };
    expect((await request(wrong, "opk1_ackrequest123456")).statusCode).toBe(409);
    expect((await request(ack, "opk1_ackrequest123456")).statusCode).toBe(200);
    expect((await request(ack, "opk1_ackrequest123456")).statusCode).toBe(200);
    expect(
      (
        await request(
          {
            ...ack,
            proof: signApiRetentionProof(token, { ...proofFields, terminalCopyId: randomUUID() }),
          },
          "opk1_ackrequest123456",
        )
      ).statusCode,
    ).toBe(409);
    expect(
      (await request(ack, "opk1_ackrequest123456", { authorization: `Bearer ${dmToken}` }))
        .statusCode,
    ).toBe(403);
    expect(await c.reconcileControlRetention(installation, { maxFamilies: 1 })).toMatchObject({
      retired: 1,
      pending: 0,
    });
    expect(journal.records()).toHaveLength(0);
    clock.mockReturnValue(wall);
    expect((await request(ack, "opk1_ackrequest123456")).statusCode).toBe(200);
    expect(
      (
        await request(
          operation,
          key,
          { "x-openmapx-parent-execution": parent },
          { requestedDeadlineAt: notAfter },
        )
      ).statusCode,
    ).toBe(409);
    expect(dispatch).toHaveBeenCalledTimes(1);
  } finally {
    vi.restoreAllMocks();
    await app.close();
    c.closeControlInstallation(installation);
    rmSync(root, { recursive: true, force: true });
  }
}, 60000);
