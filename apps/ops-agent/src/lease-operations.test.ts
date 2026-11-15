import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ControlInstallation,
  closeControlInstallation,
  leaseStoreDirectory,
  openControlInstallation,
  openLeaseStore,
  provisionControlInstallation,
} from "@openmapx/core/build-artifacts";
import type { ExecutionRef } from "@openmapx/core/ops";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LeaseRefused, runLeaseOperation } from "./lease-operations";

let root: string;
let installation: ControlInstallation;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "omx-lease-operations-"));
  mkdirSync(join(root, "data"), { mode: 0o700 });
  await provisionControlInstallation(root);
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
function owner(executor: "data-manager" | "host-cli"): ExecutionRef {
  return {
    executor,
    principal: executor,
    executionId: randomUUID(),
    operationKey: `opk1_${randomUUID().replaceAll("-", "")}`,
    operationFingerprint: "a".repeat(64),
    fingerprint: "b".repeat(64),
    deadlineAt: Date.now() + 60_000,
  };
}
const acquire = (role: "data-manager" | "host-cli", execution: ExecutionRef, targets: string[]) =>
  runLeaseOperation(installation, store(), role, {
    kind: "lease.acquire",
    owner: execution,
    ownerKind: role === "host-cli" ? "service.restart" : "transit-sync",
    targets,
  });

/** The lease an acquire answered with. */
function leaseOf(result: unknown): string {
  const value = result as { outcome?: string; lease?: { leaseId: string } };
  if (value.outcome !== "acquired" || !value.lease) throw Error("Expected a lease");
  return value.lease.leaseId;
}

describe("lease operations for data-manager and the host CLI", () => {
  it("acquires for the caller's own execution on registered targets, community ones included", async () => {
    const result = await acquire("host-cli", owner("host-cli"), ["community-live"]);
    expect(result).toMatchObject({ outcome: "acquired", lease: { targets: ["community-live"] } });
    await expect(acquire("host-cli", owner("data-manager"), ["osrm"])).rejects.toBeInstanceOf(
      LeaseRefused,
    );
    await expect(
      acquire("data-manager", owner("data-manager"), ["unknown"]),
    ).rejects.toBeInstanceOf(LeaseRefused);
  });

  it("answers busy with the holder instead of failing", async () => {
    const holder = owner("data-manager");
    await acquire("data-manager", holder, ["osrm"]);
    expect(await acquire("host-cli", owner("host-cli"), ["osrm"])).toMatchObject({
      outcome: "busy",
      target: "osrm",
      holder: { owner: holder, ownerKind: "transit-sync", state: "held" },
    });
  });

  it("shows and changes only the caller's own leases", async () => {
    const leaseId = leaseOf(await acquire("data-manager", owner("data-manager"), ["redis"]));
    expect(
      await runLeaseOperation(installation, store(), "host-cli", { kind: "lease.read", leaseId }),
    ).toEqual({ lease: null });
    expect(
      await runLeaseOperation(installation, store(), "host-cli", {
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

  it("lets the host CLI delegate only to data-manager, from the lease's own owner", async () => {
    const cli = owner("host-cli");
    const leaseId = leaseOf(
      await runLeaseOperation(installation, store(), "host-cli", {
        kind: "lease.acquire",
        owner: cli,
        ownerKind: "data.update",
        targets: ["osrm"],
      }),
    );
    const child = {
      key: randomUUID(),
      parentKey: null,
      parent: cli,
      execution: { ...owner("data-manager"), deadlineAt: cli.deadlineAt },
      kind: "download-osm",
      phase: "osm",
      recipient: "ops-agent" as const,
      targets: ["osrm"],
      permittedFurtherEdges: [],
      depth: 1,
    };
    await expect(
      runLeaseOperation(installation, store(), "host-cli", {
        kind: "lease.update",
        leaseId,
        action: { action: "delegate", child },
      }),
    ).rejects.toThrow();
    expect(store().get(leaseId)?.children).toEqual([]);
  });
});
