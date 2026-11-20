import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ControlInstallation,
  closeControlInstallation,
  leaseRules,
  leaseStoreDirectory,
  openControlInstallation,
  openLeaseStore,
  provisionControlDirectories,
} from "@openmapx/core/build-artifacts";
import type { ExecutionRef } from "@openmapx/core/ops";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LeaseRefused, runLeaseOperation } from "./lease-operations";

let root: string;
let installation: ControlInstallation;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "omx-lease-operations-"));
  mkdirSync(join(root, "data"), { mode: 0o700 });
  await provisionControlDirectories(root);
  installation = openControlInstallation({
    infraDir: root,
    role: "ops-agent",
    serviceIds: ["osrm", "redis", "community-live"],
  });
});
afterEach(() => {
  closeControlInstallation(installation);
  rmSync(root, { recursive: true, force: true });
});
const store = () => openLeaseStore({ directory: leaseStoreDirectory(root), purpose: "test" });
function owner(executor: "data-manager" | "ops-agent" | "host-cli"): ExecutionRef {
  return {
    executor,
    principal: executor === "ops-agent" ? "api" : executor,
    executionId:
      executor === "ops-agent" ? `job1_${randomUUID().replaceAll("-", "")}` : randomUUID(),
    operationKey: `opk1_${randomUUID().replaceAll("-", "")}`,
    operationFingerprint: "a".repeat(64),
    fingerprint: "b".repeat(64),
    deadlineAt: Date.now() + 60_000,
  };
}
const acquire = (execution: ExecutionRef, targets: string[]) =>
  runLeaseOperation(installation, store(), "data-manager", {
    kind: "lease.acquire",
    owner: execution,
    ownerKind: "transit-sync",
    targets,
  });

/** The lease an acquire answered with. */
function leaseOf(result: unknown): string {
  const value = result as { outcome?: string; lease?: { leaseId: string } };
  if (value.outcome !== "acquired" || !value.lease) throw Error("Expected a lease");
  return value.lease.leaseId;
}

describe("lease operations for data-manager", () => {
  it("acquires for data-manager's own execution on registered targets only", async () => {
    expect(await acquire(owner("data-manager"), ["osrm"])).toMatchObject({
      outcome: "acquired",
      lease: { targets: ["osrm"] },
    });
    await expect(acquire(owner("ops-agent"), ["redis"])).rejects.toBeInstanceOf(LeaseRefused);
    await expect(acquire(owner("data-manager"), ["unknown"])).rejects.toBeInstanceOf(LeaseRefused);
  });

  it("answers busy with the holder instead of failing", async () => {
    const holder = owner("data-manager");
    await acquire(holder, ["osrm"]);
    expect(await acquire(owner("data-manager"), ["osrm"])).toMatchObject({
      outcome: "busy",
      target: "osrm",
      holder: { owner: holder, ownerKind: "transit-sync", state: "held" },
    });
  });

  it("shows and changes only data-manager's own leases, and refuses other callers", async () => {
    const agent = owner("ops-agent");
    const leaseId = await store().update(
      (leases) =>
        leaseRules.acquire(
          leases,
          { owner: agent, ownerKind: "service.restart", targets: ["redis"] },
          Date.now(),
        ).leaseId,
    );
    expect(
      await runLeaseOperation(installation, store(), "data-manager", {
        kind: "lease.read",
        leaseId,
      }),
    ).toEqual({ lease: null });
    expect(
      await runLeaseOperation(installation, store(), "data-manager", {
        kind: "lease.update",
        leaseId,
        action: { action: "release" },
      }),
    ).toEqual({ lease: null });
    expect(store().get(leaseId)).toBeDefined();
    await expect(
      runLeaseOperation(installation, store(), "api", { kind: "lease.read", leaseId }),
    ).rejects.toBeInstanceOf(LeaseRefused);
  });

  it("shows another holder's lease on data-manager without letting data-manager change it", async () => {
    const host = owner("host-cli");
    const leaseId = await store().update(
      (leases) =>
        leaseRules.acquire(
          leases,
          { owner: host, ownerKind: "control.rollback", targets: ["data-manager", "redis"] },
          Date.now(),
        ).leaseId,
    );
    expect(
      await runLeaseOperation(installation, store(), "data-manager", {
        kind: "lease.read",
        leaseId,
      }),
    ).toMatchObject({ lease: { leaseId, owner: host, state: "held" } });
    expect(
      await runLeaseOperation(installation, store(), "data-manager", {
        kind: "lease.update",
        leaseId,
        action: { action: "release" },
      }),
    ).toEqual({ lease: null });
    expect(store().get(leaseId)).toMatchObject({ state: "held" });
  });
});
