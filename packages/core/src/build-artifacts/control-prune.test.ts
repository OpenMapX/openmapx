import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createControlRootOperationKey } from "../ops";
import { executionFingerprint } from "../ops/execution-identity";
import { opsOperationFingerprint } from "../ops/fingerprint";
import {
  assertFreshControlRoot,
  type ControlInstallation,
  closeControlInstallation,
  openControlInstallation,
  provisionControlDirectories,
  restoreAdmittedControlExecution,
  retainAdmittedControlExecution,
  retainControlEffectReceipt,
  verifyControlEffectSettlement,
} from "./control-authority";
import { CONTROL_PRUNE_AFTER_MS, pruneControlRecords } from "./control-prune";
import { leaseStoreDirectory, openLeaseStore } from "./lease-store";
import {
  acquireArtifactTargetLease,
  releaseArtifactTargetLease,
  settleArtifactTargetLeaseChild,
} from "./target-lease";

let root: string;
let installation: ControlInstallation;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "omx-control-prune-"));
  mkdirSync(join(root, "data"), { mode: 0o700 });
  await provisionControlDirectories(root);
  installation = openControlInstallation({
    infraDir: root,
    role: "host-cli",
    serviceIds: ["osrm"],
  });
});
afterEach(() => {
  closeControlInstallation(installation);
  rmSync(root, { recursive: true, force: true });
});

function admit(
  notAfter = Date.now() + 60_000,
  role: "host-cli" | "ops-agent" = "host-cli",
  operation: Parameters<typeof opsOperationFingerprint>[0] = {
    kind: "service.restart",
    serviceId: "osrm",
  },
) {
  const operationFingerprint = opsOperationFingerprint(operation);
  const execution = {
    executor: role,
    principal: role === "ops-agent" ? ("api" as const) : role,
    executionId: role === "ops-agent" ? `job1_${randomUUID().replaceAll("-", "")}` : randomUUID(),
    operationKey: createControlRootOperationKey({ notAfter, nonce: randomBytes(16) }),
    operationFingerprint,
    deadlineAt: notAfter,
    fingerprint: executionFingerprint({
      kind: operation.kind,
      operationFingerprint,
      deadlineAt: notAfter,
    }),
  };
  const input = {
    requestedDeadlineAt: notAfter,
    execution,
    operation,
    kind: operation.kind,
    admittedAt: notAfter - 60_000,
    serviceIds: ["osrm"],
  };
  const target =
    role === "host-cli"
      ? installation
      : openControlInstallation({ infraDir: root, role, serviceIds: ["osrm"] });
  return {
    input,
    execution,
    target,
    authority: retainAdmittedControlExecution(target, input),
  };
}
function settle(authority: ReturnType<typeof admit>["authority"]) {
  retainControlEffectReceipt(authority, {
    outcome: "failed_without_effect",
    publication: "not_started",
    receipt: { kind: "not-started" },
  });
}
const record = (namespace: string, key: string) =>
  join(root, "state/host-cli/control", namespace, `${key}.json`);

it("prunes a finished execution only after its key expired and 72 hours passed", async () => {
  const { execution, authority } = admit();
  settle(authority);
  const expiry = execution.deadlineAt;
  expect(
    await pruneControlRecords(installation, { now: expiry + CONTROL_PRUNE_AFTER_MS - 1 }),
  ).toEqual([]);
  expect(existsSync(record("executions", execution.operationKey))).toBe(true);
  const later = expiry + CONTROL_PRUNE_AFTER_MS + 60_000;
  expect(await pruneControlRecords(installation, { now: later })).toEqual([execution.operationKey]);
  expect(existsSync(record("executions", execution.operationKey))).toBe(false);
  expect(existsSync(record("effects", execution.operationKey))).toBe(false);
  expect(await pruneControlRecords(installation, { now: later })).toEqual([]);
});

it("keeps an execution whose effect outcome is unknown", async () => {
  const { execution } = admit();
  const later = execution.deadlineAt + 30 * 24 * 3600_000;
  expect(await pruneControlRecords(installation, { now: later })).toEqual([]);
  expect(existsSync(record("executions", execution.operationKey))).toBe(true);
});

it("keeps a finished execution the role asks to keep", async () => {
  const { execution, authority } = admit();
  settle(authority);
  const later = execution.deadlineAt + 30 * 24 * 3600_000;
  expect(
    await pruneControlRecords(installation, {
      now: later,
      keep: (key) => key === execution.operationKey,
    }),
  ).toEqual([]);
  expect(existsSync(record("executions", execution.operationKey))).toBe(true);
});

it("refuses an expired root whether or not its records were pruned", async () => {
  const notAfter = Date.now() + 1_000;
  const { input, execution, authority } = admit(notAfter);
  settle(authority);
  expect(
    await pruneControlRecords(installation, { now: notAfter + CONTROL_PRUNE_AFTER_MS + 1 }),
  ).toEqual([execution.operationKey]);
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  expect(() => assertFreshControlRoot(execution.operationKey, notAfter)).toThrow(/expired/i);
  expect(() => retainAdmittedControlExecution(installation, input)).toThrow();
  expect(existsSync(record("executions", execution.operationKey))).toBe(false);
});

const heldLeases = () =>
  openLeaseStore({ directory: leaseStoreDirectory(root), purpose: "test" })
    .list()
    .map((value) => value.leaseId);

it("prunes a root only once its released lease left the store", async () => {
  const { execution, authority } = admit();
  const lease = await acquireArtifactTargetLease({
    serviceIds: ["osrm"],
    owner: authority,
  });
  settle(authority);
  await settleArtifactTargetLeaseChild(
    lease,
    verifyControlEffectSettlement(installation, execution),
  );
  const later = execution.deadlineAt + CONTROL_PRUNE_AFTER_MS + 60_000;
  expect(await pruneControlRecords(installation, { now: later })).toEqual([]);
  expect(existsSync(record("executions", execution.operationKey))).toBe(true);
  await releaseArtifactTargetLease(lease);
  expect(heldLeases()).toEqual([]);
  expect(await pruneControlRecords(installation, { now: later })).toEqual([execution.operationKey]);
  expect(existsSync(record("executions", execution.operationKey))).toBe(false);
});

it("bounds each pass and continues where the previous pass stopped", async () => {
  const admitted = [admit(), admit(), admit()];
  for (const { authority } of admitted) settle(authority);
  const later =
    Math.max(...admitted.map((value) => value.execution.deadlineAt)) +
    CONTROL_PRUNE_AFTER_MS +
    60_000;
  const pruned = [
    ...(await pruneControlRecords(installation, { now: later, limit: 1 })),
    ...(await pruneControlRecords(installation, { now: later, limit: 1 })),
  ];
  expect(pruned).toHaveLength(2);
  expect(await pruneControlRecords(installation, { now: later, limit: 1 })).toHaveLength(1);
  expect(new Set(pruned).size).toBe(2);
});

it("keeps a finished maintenance step while its owner record exists, and that record with it", async () => {
  const maintenanceId = randomUUID(),
    { execution, authority } = admit(undefined, "host-cli", {
      kind: "service.recreate",
      serviceId: "osrm",
      expectedConfigurationRevisionId: `cfg1_${"a".repeat(43)}`,
      maintenanceId,
    });
  settle(authority);
  // The owner record of a still-held maintenance names each step it ran.
  const owner = record("configuration-maintenance", maintenanceId);
  mkdirSync(dirname(owner), { recursive: true, mode: 0o700 });
  writeFileSync(owner, JSON.stringify({ payload: { apiControls: { steps: [{ execution }] } } }), {
    mode: 0o600,
  });
  const later = execution.deadlineAt + 30 * 24 * 3600_000;
  expect(await pruneControlRecords(installation, { now: later })).toEqual([]);
  expect(existsSync(owner)).toBe(true);
  expect(existsSync(record("executions", execution.operationKey))).toBe(true);
  // Once the preparation and its owner record are gone, the step goes too.
  rmSync(owner);
  expect(await pruneControlRecords(installation, { now: later })).toEqual([execution.operationKey]);
});

it("refuses a pruned and expired execution to its readers", async () => {
  const notAfter = Date.now() + 60_000,
    { execution, authority } = admit(notAfter);
  settle(authority);
  expect(
    await pruneControlRecords(installation, { now: notAfter + CONTROL_PRUNE_AFTER_MS + 1 }),
  ).toEqual([execution.operationKey]);
  expect(() => restoreAdmittedControlExecution(installation, execution)).toThrow();
  expect(() => verifyControlEffectSettlement(installation, execution)).toThrow();
});

it("keeps an execution whose effect record is absent, with its lease held", async () => {
  const { execution } = admit(),
    lease = await acquireArtifactTargetLease({
      serviceIds: ["osrm"],
      owner: restoreAdmittedControlExecution(installation, execution),
    });
  rmSync(record("effects", execution.operationKey));
  for (const now of [Date.now(), execution.deadlineAt + 30 * 24 * 3600_000])
    expect(await pruneControlRecords(installation, { now })).toEqual([]);
  expect(existsSync(record("executions", execution.operationKey))).toBe(true);
  await expect(releaseArtifactTargetLease(lease)).rejects.toThrow();
  expect(heldLeases()).toEqual([lease.leaseId]);
});

it("keeps a borrower while the lease it adopted is held, and while any adoption is unreadable", async () => {
  const owner = admit(),
    borrower = admit(),
    lease = await acquireArtifactTargetLease({
      serviceIds: ["osrm"],
      owner: owner.authority,
    });
  settle(borrower.authority);
  // The prune reads only an adoption's execution and the lease named in its
  // assertion, so the borrower's adoption record is written directly.
  const adoption = record("adoptions", randomUUID()),
    assertion = Buffer.from(JSON.stringify({ leaseId: lease.leaseId })).toString("base64url");
  mkdirSync(dirname(adoption), { recursive: true, mode: 0o700 });
  writeFileSync(adoption, JSON.stringify({ execution: borrower.execution, assertion }), {
    mode: 0o600,
  });
  const later =
    Math.max(owner.execution.deadlineAt, borrower.execution.deadlineAt) + 30 * 24 * 3600_000;
  expect(await pruneControlRecords(installation, { now: later })).toEqual([]);
  settle(owner.authority);
  await settleArtifactTargetLeaseChild(
    lease,
    verifyControlEffectSettlement(installation, owner.execution),
  );
  await releaseArtifactTargetLease(lease);
  const unreadable = record("adoptions", randomUUID());
  writeFileSync(unreadable, "{", { mode: 0o600 });
  expect(await pruneControlRecords(installation, { now: later })).toEqual([]);
  rmSync(unreadable);
  expect((await pruneControlRecords(installation, { now: later })).sort()).toEqual(
    [owner.execution.operationKey, borrower.execution.operationKey].sort(),
  );
  expect(existsSync(adoption)).toBe(false);
});
