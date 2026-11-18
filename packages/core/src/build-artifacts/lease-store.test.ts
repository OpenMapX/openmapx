import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExecutionRef } from "../ops/execution-ref";
import { heldTargets } from "./__fixtures__/held-targets";
import {
  type LeaseSettlement,
  leaseStoreDirectory,
  localLeaseBackend,
  openLeaseStore,
  TargetBusyError,
} from "./lease-store";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function backend() {
  const infraDir = mkdtempSync(join(tmpdir(), "omx-lease-store-"));
  roots.push(infraDir);
  const store = openLeaseStore({ directory: leaseStoreDirectory(infraDir), purpose: "test" });
  return { infraDir, store, leases: localLeaseBackend(store) };
}
function execution(executor: ExecutionRef["executor"] = "host-cli"): ExecutionRef {
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
const settled = (identity: ExecutionRef): LeaseSettlement => ({
  identity,
  outcome: "committed",
  publication: "committed",
  terminalReceiptDigest: "c".repeat(64),
});

describe("the agent's lease store", () => {
  it("holds targets until the owner settles, then drops the released row", async () => {
    const { infraDir, leases } = backend(),
      owner = execution();
    const lease = await leases.acquire({
      owner,
      ownerKind: "service.restart",
      targets: ["motis", "alpha"],
    });
    expect(lease.targets).toEqual(["alpha", "motis"]);
    expect(heldTargets(infraDir)).toEqual(["alpha", "motis"]);
    await expect(leases.release({ leaseId: lease.leaseId })).rejects.toThrow(/settlement/);
    await leases.settle({ leaseId: lease.leaseId, key: null, settlement: settled(owner) });
    await leases.release({ leaseId: lease.leaseId });
    expect(heldTargets(infraDir)).toEqual([]);
  });

  it("refuses a held target and names the holder's operation", async () => {
    const { leases } = backend(),
      first = execution("ops-agent");
    await leases.acquire({ owner: first, ownerKind: "service.stop", targets: ["redis"] });
    const refusal = leases.acquire({
      owner: execution(),
      ownerKind: "service.restart",
      targets: ["osrm", "redis"],
    });
    await expect(refusal).rejects.toBeInstanceOf(TargetBusyError);
    await expect(refusal).rejects.toThrow(first.operationKey);
    await expect(refusal).rejects.toThrow("openmapx control status");
  });

  it("returns the same lease to a repeated acquire of the same owner", async () => {
    const { leases } = backend(),
      owner = execution();
    const first = await leases.acquire({ owner, ownerKind: "backup.create", targets: ["postgis"] });
    const again = await leases.acquire({ owner, ownerKind: "backup.create", targets: ["postgis"] });
    expect(again.leaseId).toBe(first.leaseId);
    await expect(
      leases.acquire({ owner, ownerKind: "backup.create", targets: ["redis"] }),
    ).rejects.toThrow(/different root lease/);
  });

  it("keeps the targets held while a delegated child is unsettled", async () => {
    const { leases } = backend(),
      owner = execution("ops-agent"),
      child = execution("data-manager");
    const lease = await leases.acquire({ owner, ownerKind: "data.update", targets: ["osrm"] });
    const key = randomUUID();
    await leases.delegate({
      leaseId: lease.leaseId,
      child: {
        key,
        parentKey: null,
        parent: owner,
        execution: child,
        kind: "generation-hardlinks",
        phase: "hardlinks",
        recipient: "data-manager",
        targets: ["osrm"],
      },
    });
    // A widened target subset and a replayed child key are refused.
    await expect(
      leases.delegate({
        leaseId: lease.leaseId,
        child: {
          key: randomUUID(),
          parentKey: null,
          parent: owner,
          execution: execution("data-manager"),
          kind: "generation-hardlinks",
          phase: "hardlinks",
          recipient: "data-manager",
          targets: ["motis"],
        },
      }),
    ).rejects.toThrow(/Widened/);
    await expect(
      leases.settle({ leaseId: lease.leaseId, key: null, settlement: settled(owner) }),
    ).rejects.toThrow(/Unsettled attempted child/);
    await leases.settle({ leaseId: lease.leaseId, key, settlement: settled(child) });
    await leases.settle({ leaseId: lease.leaseId, key: null, settlement: settled(owner) });
    await leases.release({ leaseId: lease.leaseId });
    expect(leases.listSync()).toEqual([]);
  });

  it("marks an unknown outcome as needing recovery and keeps the lease", async () => {
    const { infraDir, leases } = backend(),
      owner = execution();
    const lease = await leases.acquire({ owner, ownerKind: "service.stop", targets: ["alpha"] });
    const record = await leases.settle({
      leaseId: lease.leaseId,
      key: null,
      settlement: { ...settled(owner), outcome: "unknown", publication: "unknown" },
    });
    expect(record.state).toBe("recovery_required");
    await expect(leases.release({ leaseId: lease.leaseId })).rejects.toThrow();
    expect(heldTargets(infraDir)).toEqual(["alpha"]);
  });

  it("writes the store as plain, schema-checked JSON", async () => {
    const { store, leases } = backend(),
      owner = execution();
    await leases.acquire({ owner, ownerKind: "service.stop", targets: ["alpha"] });
    const file = JSON.parse(readFileSync(join(store.directory, "leases.json"), "utf8"));
    expect(file).toMatchObject({ version: 1, leases: [{ owner, targets: ["alpha"] }] });
    expect(JSON.stringify(file)).not.toContain("signature");
  });

  it("serializes concurrent writers on the store lock", async () => {
    const { leases } = backend();
    const owners = Array.from({ length: 8 }, () => execution());
    const results = await Promise.allSettled(
      owners.map((owner) =>
        leases.acquire({ owner, ownerKind: "service.stop", targets: ["shared"] }),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(leases.listSync().map((lease) => lease.targets)).toEqual([["shared"]]);
  });
  it("refuses a state directory that its group or others can reach", async () => {
    const { infraDir, leases } = backend();
    mkdirSync(leaseStoreDirectory(infraDir), { recursive: true, mode: 0o755 });
    chmodSync(leaseStoreDirectory(infraDir), 0o755);
    await expect(
      leases.acquire({ owner: execution(), ownerKind: "service.stop", targets: ["redis"] }),
    ).rejects.toThrow(/must be a directory owned by uid/);
  });
});
