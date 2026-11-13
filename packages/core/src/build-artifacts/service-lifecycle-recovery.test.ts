import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { currentConfigurationGeneration } from "../services/configuration-generation";
import {
  lifecycleFailureHasNoSurvivor,
  type ServiceLifecycleReceipt,
} from "../services/service-lifecycle-receipt";
import * as c from "./control-authority";
import { AnchoredDirectory } from "./filesystem";
import { inspectDataExecutionAdmission } from "./peer-admission";
import { reconcileFailedServiceLifecycle } from "./service-lifecycle-recovery";
import * as leases from "./target-lease";
import { failedServiceLifecycle } from "./test-fixtures/service-lifecycle-recovery";

vi.setConfig({ testTimeout: 30000 });
let root: string;
const installations: c.ControlInstallation[] = [];
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "omx-lifecycle-recovery-"));
  mkdirSync(join(root, "data"), { mode: 0o700 });
  await c.provisionControlInstallation(root);
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const installation of installations.splice(0)) c.closeControlInstallation(installation);
  rmSync(root, { recursive: true, force: true });
});
async function failedLifecycle(adopt: boolean | "after-failure" = false, issueChild = true) {
  const fixture = await failedServiceLifecycle(root, adopt, issueChild);
  installations.push(...fixture.installations);
  return fixture;
}

it("releases only the expired failed update's unadopted hardlink grant without replay or receipt rewriting", async () => {
  const f = await failedLifecycle();
  vi.spyOn(Date, "now").mockReturnValue(f.execution.deadlineAt + 1);
  await reconcileFailedServiceLifecycle({
    infraDir: root,
    authority: f.authority,
    transport: f.transport,
  });
  expect(existsSync(join(root, "data/.admin-target-control/locks/alpha"))).toBe(false);
  expect(readFileSync(f.path)).toEqual(f.receiptBytes);
  expect(currentConfigurationGeneration(root)).toBe(f.revisionId);
  await reconcileFailedServiceLifecycle({
    infraDir: root,
    authority: f.authority,
    transport: f.transport,
  });
  expect(f.recoveryRequests).toEqual([
    { url: "http://127.0.0.1:4301/executions/generation-hardlinks/recovery", method: "POST" },
  ]);
  const dm = c.openControlInstallation({
    infraDir: root,
    role: "data-manager",
    serviceIds: ["alpha"],
  });
  installations.push(dm);
  await expect(
    Promise.resolve().then(async () => {
      const receiver = inspectDataExecutionAdmission(dm, {
        rawHeaders: ["x-openmapx-control-delegation", f.assertion],
        transportPrincipal: "host-cli",
        input: {
          kind: "generation-hardlinks",
          revisionId: f.revisionId,
          coordinatorMode: "ensure-running",
          planDigest: c.controlDigest(f.plan),
        },
        operationKey: f.child.execution.operationKey,
        operationFingerprint: f.reservation.operationFingerprint,
        requestedDeadlineAt: f.child.execution.deadlineAt,
      });
      return receiver!.adopt(f.child.execution);
    }),
  ).rejects.toThrow();
});
it("preserves an already adopted child and keeps its original update fenced", async () => {
  const f = await failedLifecycle(true);
  vi.spyOn(Date, "now").mockReturnValue(f.execution.deadlineAt + 1);
  await expect(
    reconcileFailedServiceLifecycle({
      infraDir: root,
      authority: f.authority,
      transport: f.transport,
    }),
  ).rejects.toThrow(/adopted|unresolved/);
  expect(existsSync(join(root, "data/.admin-target-control/locks/alpha"))).toBe(true);
  expect(readFileSync(f.path)).toEqual(f.receiptBytes);
});
it("does not reinterpret a lost adopted child file as proof that no receiver started", async () => {
  const f = await failedLifecycle("after-failure");
  const directory = join(root, "data/.admin-target-control/leases", f.leaseId, "children");
  const files = readdirSync(directory);
  expect(files).toHaveLength(1);
  rmSync(join(directory, files[0]!));
  vi.spyOn(Date, "now").mockReturnValue(f.execution.deadlineAt + 1);
  await expect(
    reconcileFailedServiceLifecycle({
      infraDir: root,
      authority: f.authority,
      transport: f.transport,
    }),
  ).rejects.toThrow();
  expect(existsSync(join(root, "data/.admin-target-control/locks/alpha"))).toBe(true);
});
it("refuses recovery while the original update can still run", async () => {
  const f = await failedLifecycle();
  await expect(
    reconcileFailedServiceLifecycle({
      infraDir: root,
      authority: f.authority,
      transport: f.transport,
    }),
  ).rejects.toThrow(/expired/);
  expect(existsSync(join(root, "data/.admin-target-control/locks/alpha"))).toBe(true);
});
it("a revoked unadopted grant cannot become an adoption before root release", async () => {
  const f = await failedLifecycle();
  vi.spyOn(Date, "now").mockReturnValue(f.execution.deadlineAt + 1);
  const lease = leases.restoreArtifactTargetLeaseForSettlement(f.authority);
  try {
    await leases.prepareFailedServiceLifecycleRecovery(f.authority, lease);
    await leases.revokeUnadoptedServiceHardlinks(f.authority, lease, await f.nonAdmission());
    const dm = c.openControlInstallation({
      infraDir: root,
      role: "data-manager",
      serviceIds: ["alpha"],
    });
    installations.push(dm);
    const receiver = inspectDataExecutionAdmission(dm, {
      rawHeaders: ["x-openmapx-control-delegation", f.assertion],
      transportPrincipal: "host-cli",
      input: {
        kind: "generation-hardlinks",
        revisionId: f.revisionId,
        coordinatorMode: "ensure-running",
        planDigest: c.controlDigest(f.plan),
      },
      operationKey: f.child.execution.operationKey,
      operationFingerprint: f.reservation.operationFingerprint,
      requestedDeadlineAt: f.child.execution.deadlineAt,
    });
    await expect(receiver!.adopt(f.child.execution)).rejects.toThrow(
      "Original unadopted grant was revoked",
    );
  } finally {
    leases.closeArtifactTargetLeaseHandle(lease);
  }
});
it("finishes the original release cursor after interruption without reopening forward authority", async () => {
  const f = await failedLifecycle();
  vi.spyOn(Date, "now").mockReturnValue(f.execution.deadlineAt + 1);
  const remove = AnchoredDirectory.prototype.removeDirectory;
  let interrupted = false;
  const fault = vi
    .spyOn(AnchoredDirectory.prototype, "removeDirectory")
    .mockImplementation(function (this: AnchoredDirectory, name, ...args) {
      if (name === "alpha" && !interrupted) {
        interrupted = true;
        throw Error("Release interrupted");
      }
      return remove.call(this, name, ...args);
    });
  await expect(
    reconcileFailedServiceLifecycle({
      infraDir: root,
      authority: f.authority,
      transport: f.transport,
    }),
  ).rejects.toThrow("Release interrupted");
  fault.mockRestore();
  await reconcileFailedServiceLifecycle({
    infraDir: root,
    authority: f.authority,
    transport: f.transport,
  });
  expect(existsSync(join(root, "data/.admin-target-control/locks/alpha"))).toBe(false);
  expect(readFileSync(f.path)).toEqual(f.receiptBytes);
});

it("requires the recipient's exact signed non-admission proof before revocation", async () => {
  const f = await failedLifecycle();
  vi.spyOn(Date, "now").mockReturnValue(f.execution.deadlineAt + 1);
  const lease = leases.restoreArtifactTargetLeaseForSettlement(f.authority);
  try {
    await leases.prepareFailedServiceLifecycleRecovery(f.authority, lease);
    await expect(leases.revokeUnadoptedServiceHardlinks(f.authority, lease)).rejects.toThrow(
      "Data Manager non-admission proof required",
    );
    const proof = await f.nonAdmission();
    await expect(
      leases.revokeUnadoptedServiceHardlinks(f.authority, lease, {
        ...proof,
        signature: "a".repeat(86),
      }),
    ).rejects.toThrow("Invalid control signature");
    const dm = f.installations.find((i) => i.role === "data-manager")!;
    const changed = c.signControl(
      c.installationState(dm).privateKey,
      "openmapx-generation-hardlinks-non-admission-v1",
      { ...proof.payload, grantDigest: "a".repeat(64) },
    );
    await expect(
      leases.revokeUnadoptedServiceHardlinks(f.authority, lease, changed),
    ).rejects.toThrow("Data Manager non-admission proof does not match original grant");
    expect(existsSync(join(root, "data/.admin-target-control/locks/alpha"))).toBe(true);
    expect(readFileSync(f.path)).toEqual(f.receiptBytes);
  } finally {
    leases.closeArtifactTargetLeaseHandle(lease);
  }
});
it("accepts a failure with no issued child while its root is still held", async () => {
  const f = await failedLifecycle(false, false);
  const source = leases.verifyFailedServiceLifecycleContainment(f.authority);
  expect(source.failedReceiptDigest).toBe(
    c.controlDigest(JSON.parse(readFileSync(f.path, "utf8")).current.payload.receipt),
  );
  c.retainControlEffectReceipt(f.authority, {
    outcome: "contained",
    publication: "committed",
    receipt: {
      kind: "service-lifecycle-contained-failure",
      failedReceiptDigest: source.failedReceiptDigest,
    },
  });
});
it("still requires the unadopted revocation once a child was issued", async () => {
  const f = await failedLifecycle();
  expect(() => leases.verifyFailedServiceLifecycleContainment(f.authority)).toThrow(
    "Original unadopted hardlink revocation required",
  );
});
it("recovers a no-child failure whose process stopped before releasing", async () => {
  const f = await failedLifecycle(false, false);
  await expect(
    reconcileFailedServiceLifecycle({
      infraDir: root,
      authority: f.authority,
      transport: f.transport,
    }),
  ).rejects.toThrow(/expired/);
  vi.spyOn(Date, "now").mockReturnValue(f.execution.deadlineAt + 1);
  await reconcileFailedServiceLifecycle({
    infraDir: root,
    authority: f.authority,
    transport: f.transport,
  });
  expect(existsSync(join(root, "data/.admin-target-control/locks/alpha"))).toBe(false);
  expect(readFileSync(f.path)).toEqual(f.receiptBytes);
  expect(f.recoveryRequests).toEqual([]);
});
it.each([
  ["failed", null, true],
  ["unknown", null, true],
  ["failed", { assertion: "issued" }, false],
  ["unknown", new Error("unreadable attempt"), false],
  ["recreated", null, false],
  ["complete", null, false],
] as const)("a %s receipt with attempt %j has no survivor: %s", (phase, attempt, expected) => {
  expect(
    lifecycleFailureHasNoSurvivor({ phase } as unknown as ServiceLifecycleReceipt, attempt),
  ).toBe(expected);
});
