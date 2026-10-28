import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  closeControlInstallation,
  openControlInstallation,
  provisionControlInstallation,
  restoreAdmittedControlExecution,
  retainAdmittedControlExecution,
} from "../build-artifacts/control-authority";
import { AnchoredDirectory } from "../build-artifacts/filesystem";
import {
  acquireArtifactTargetLease,
  closeArtifactTargetLeaseHandle,
} from "../build-artifacts/target-lease";
import {
  createControlRootOperationKey,
  executionFingerprint,
  opsOperationFingerprint,
} from "../ops";
import { withConfigurationGenerationWriter } from "./configuration-generation";
import {
  openServiceLifecycleReceipt,
  readServiceLifecycleReceipt,
  withServiceLifecycleReceiptAuthority,
  withVerifiedLifecycleOwnership,
} from "./service-lifecycle-receipt";

let root: string;
const revision = `cfg1_${"a".repeat(43)}`;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "omx-lifecycle-receipt-"));
  mkdirSync(join(root, "data"));
  await provisionControlInstallation(root);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});
function owner() {
  const installation = openControlInstallation({
    infraDir: root,
    role: "host-cli",
    serviceIds: ["alpha", "beta"],
  });
  const operation = {
    kind: "service.update" as const,
    serviceId: "alpha",
    expectedConfigurationRevisionId: revision,
  };
  const deadlineAt = Date.now() + 60_000,
    operationFingerprint = opsOperationFingerprint(operation);
  const execution = {
    executor: "host-cli" as const,
    principal: "host-cli" as const,
    executionId: randomUUID(),
    operationKey: createControlRootOperationKey({ notAfter: deadlineAt, nonce: randomBytes(16) }),
    deadlineAt,
    operationFingerprint,
    fingerprint: executionFingerprint({ kind: operation.kind, operationFingerprint, deadlineAt }),
  };
  const authority = retainAdmittedControlExecution(installation, {
    operation,
    execution,
    kind: operation.kind,
    admittedAt: deadlineAt - 60_000,
    requestedDeadlineAt: deadlineAt,
    serviceIds: ["alpha", "beta"],
  });
  return { installation, authority, execution };
}
function options(execution: ReturnType<typeof owner>["execution"]) {
  return {
    dataRoot: join(root, "data"),
    execution,
    serviceIds: ["alpha"],
    action: "update" as const,
    noDeps: false,
    coordinatorMode: "ensure-running" as const,
    expectedRevisionId: revision,
    seedRevisionId: revision,
  };
}
it("signs exact seed and checkpoints only with the live writer and physical target owner", async () => {
  const o = owner();
  let lease: Awaited<ReturnType<typeof acquireArtifactTargetLease>> | undefined;
  try {
    lease = await acquireArtifactTargetLease({
      dataRoot: join(root, "data"),
      owner: o.authority,
      serviceIds: ["alpha", "beta"],
    });
    const store = await withServiceLifecycleReceiptAuthority(o.authority, () =>
      openServiceLifecycleReceipt(options(o.execution)),
    );
    const seed = await store.read();
    expect(seed.commit).toBe("seed_committed");
    await withConfigurationGenerationWriter(root, (writer) =>
      withVerifiedLifecycleOwnership(
        { writer, lease: lease!, authority: o.authority },
        async (ownership) => {
          await store.checkpoint(0, { ...seed, phase: "pins_validated", sequence: 1 }, ownership);
          await expect(
            store.checkpoint(0, { ...seed, phase: "pulled", sequence: 1 }, ownership),
          ).rejects.toThrow();
        },
      ),
    );
    expect((await readServiceLifecycleReceipt(options(o.execution))).phase).toBe("pins_validated");
    const path = join(root, "data/ops-agent/lifecycle", `${o.execution.operationKey}.json`),
      original = readFileSync(path);
    const tampered = JSON.parse(original.toString());
    tampered.current.payload.receipt.finalRevisionId = revision;
    writeFileSync(path, JSON.stringify(tampered), { mode: 0o600 });
    await expect(readServiceLifecycleReceipt(options(o.execution))).rejects.toThrow();
  } finally {
    if (lease) closeArtifactTargetLeaseHandle(lease);
    closeControlInstallation(o.installation);
  }
});
it("rejects a foreign data root before creating any shared receipt", async () => {
  const o = owner(),
    foreign = join(root, "foreign");
  mkdirSync(foreign);
  try {
    await expect(
      withServiceLifecycleReceiptAuthority(o.authority, () =>
        openServiceLifecycleReceipt({ ...options(o.execution), dataRoot: foreign }),
      ),
    ).rejects.toThrow();
    expect(existsSync(join(foreign, "ops-agent"))).toBe(false);
  } finally {
    closeControlInstallation(o.installation);
  }
});
it("rejects targets outside the original admitted closure before creating a receipt", async () => {
  const o = owner();
  try {
    await expect(
      withServiceLifecycleReceiptAuthority(o.authority, () =>
        openServiceLifecycleReceipt({ ...options(o.execution), serviceIds: ["foreign"] }),
      ),
    ).rejects.toThrow();
  } finally {
    closeControlInstallation(o.installation);
  }
});
it("refuses a final revision that the owned writer did not commit", async () => {
  const o = owner();
  let lease: Awaited<ReturnType<typeof acquireArtifactTargetLease>> | undefined;
  try {
    lease = await acquireArtifactTargetLease({
      dataRoot: join(root, "data"),
      owner: o.authority,
      serviceIds: ["alpha", "beta"],
    });
    const store = await withServiceLifecycleReceiptAuthority(o.authority, () =>
      openServiceLifecycleReceipt(options(o.execution)),
    );
    await withConfigurationGenerationWriter(root, (writer) =>
      withVerifiedLifecycleOwnership(
        { writer, lease: lease!, authority: o.authority },
        async (ownership) => {
          const seed = await store.read();
          await store.checkpoint(0, { ...seed, sequence: 1, phase: "pins_validated" }, ownership);
          await store.checkpoint(1, { ...seed, sequence: 2, phase: "pulled" }, ownership);
          await expect(
            store.checkpoint(
              2,
              {
                ...seed,
                sequence: 3,
                phase: "generation_committed",
                commit: "final_committed",
                finalRevisionId: `cfg1_${"b".repeat(43)}`,
              },
              ownership,
            ),
          ).rejects.toThrow();
        },
      ),
    );
  } finally {
    if (lease) closeArtifactTargetLeaseHandle(lease);
    closeControlInstallation(o.installation);
  }
});
it.each([false, true])(
  "repairs only the original signed lifecycle publication after restart with shared commit=%s",
  async (committed) => {
    const o = owner();
    let lease: Awaited<ReturnType<typeof acquireArtifactTargetLease>> | undefined;
    let restarted: ReturnType<typeof openControlInstallation> | undefined;
    try {
      lease = await acquireArtifactTargetLease({
        dataRoot: join(root, "data"),
        owner: o.authority,
        serviceIds: ["alpha", "beta"],
      });
      const store = await withServiceLifecycleReceiptAuthority(o.authority, () =>
        openServiceLifecycleReceipt(options(o.execution)),
      );
      const write = AnchoredDirectory.prototype.write;
      let interrupted = false;
      const fault = vi.spyOn(AnchoredDirectory.prototype, "write").mockImplementation(function (
        this: AnchoredDirectory,
        name,
        bytes,
        ...args
      ) {
        if (!interrupted) {
          const value = JSON.parse(String(bytes));
          if (
            committed
              ? name === `lifecycle-${o.execution.operationKey}.json` &&
                value.payload?.sequence === 1 &&
                value.payload?.pending === null
              : name === `${o.execution.operationKey}.json` &&
                value.current?.payload?.receipt?.sequence === 1
          ) {
            interrupted = true;
            throw Error("Synthetic lifecycle filesystem interruption");
          }
        }
        return write.call(this, name, bytes, ...args);
      });
      await expect(
        withConfigurationGenerationWriter(root, (writer) =>
          withVerifiedLifecycleOwnership(
            { writer, lease: lease!, authority: o.authority },
            async (ownership) => {
              const seed = await store.read();
              await store.checkpoint(
                0,
                { ...seed, sequence: 1, phase: "pins_validated" },
                ownership,
              );
            },
          ),
        ),
      ).rejects.toThrow("Synthetic lifecycle filesystem interruption");
      expect(interrupted).toBe(true);
      fault.mockRestore();
      closeArtifactTargetLeaseHandle(lease);
      lease = undefined;
      closeControlInstallation(o.installation);
      restarted = openControlInstallation({
        infraDir: root,
        role: "host-cli",
        serviceIds: ["alpha", "beta"],
      });
      const authority = restoreAdmittedControlExecution(restarted, o.execution);
      // An unscoped read never repairs a private high-water mark.
      await expect(readServiceLifecycleReceipt(options(o.execution))).rejects.toThrow();
      const recovered = withServiceLifecycleReceiptAuthority(authority, () =>
        readServiceLifecycleReceipt(options(o.execution)),
      );
      if (committed) {
        await expect(recovered).resolves.toMatchObject({
          phase: "pins_validated",
          sequence: 1,
          finalRevisionId: null,
        });
        await expect(readServiceLifecycleReceipt(options(o.execution))).resolves.toMatchObject({
          phase: "pins_validated",
          sequence: 1,
        });
      } else await expect(recovered).rejects.toThrow();
      expect(existsSync(join(root, "data/.admin-target-control/locks/alpha"))).toBe(true);
    } finally {
      if (lease) closeArtifactTargetLeaseHandle(lease);
      if (restarted) closeControlInstallation(restarted);
      else closeControlInstallation(o.installation);
    }
  },
);
