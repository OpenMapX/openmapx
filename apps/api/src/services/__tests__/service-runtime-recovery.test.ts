import { describe, expect, it, vi } from "vitest";
import {
  reconcileDurableServiceRuntime,
  reconcileServiceRuntime,
} from "../service-runtime-recovery";

function result(exitCode: number, stderr = "") {
  return {
    exitCode,
    classification:
      exitCode === 0
        ? ("ok" as const)
        : /no such service/i.test(stderr)
          ? ("not_found" as const)
          : ("nonzero" as const),
  };
}

describe("service runtime recovery", () => {
  it("fails closed when an orphaned container cannot be removed", async () => {
    const remove = vi.fn().mockResolvedValue(result(1, "cannot connect to Docker"));
    const initializeRegistry = vi.fn();

    await expect(
      reconcileServiceRuntime(
        {
          runtimeRecoveryNeeded: true,
          orphanedServiceIds: ["probe"],
          restartServiceIds: [],
          incidentId: `recovery_${"a".repeat(64)}`,
        },
        { remove, recreate: vi.fn(), initializeRegistry, renderCompose: vi.fn() },
      ),
    ).rejects.toThrow("Failed to remove stale service runtime probe");

    expect(initializeRegistry).not.toHaveBeenCalled();
  });

  it("does not checkpoint a zero-exit containment failure as completed recovery work", async () => {
    const checkpoint = vi.fn();
    const initializeRegistry = vi.fn();

    await expect(
      reconcileServiceRuntime(
        {
          runtimeRecoveryNeeded: true,
          orphanedServiceIds: ["probe"],
          restartServiceIds: [],
          incidentId: `recovery_${"f".repeat(64)}`,
        },
        {
          remove: vi.fn().mockResolvedValue({
            exitCode: 0,
            classification: "containment_failure",
          }),
          recreate: vi.fn(),
          initializeRegistry,
          renderCompose: vi.fn(),
          checkpoint,
        },
      ),
    ).rejects.toThrow("Failed to remove stale service runtime probe");

    expect(checkpoint).not.toHaveBeenCalled();
    expect(initializeRegistry).not.toHaveBeenCalled();
  });

  it("allows a crash before the new service was ever rendered", async () => {
    const remove = vi.fn().mockResolvedValue(result(1, "no such service: fresh-service"));
    const initializeRegistry = vi.fn();
    const renderCompose = vi.fn();

    await reconcileServiceRuntime(
      {
        runtimeRecoveryNeeded: true,
        orphanedServiceIds: ["fresh-service"],
        restartServiceIds: [],
        incidentId: `recovery_${"a".repeat(64)}`,
      },
      { remove, recreate: vi.fn(), initializeRegistry, renderCompose },
    );

    expect(initializeRegistry).toHaveBeenCalledOnce();
    expect(renderCompose).toHaveBeenCalledOnce();
  });

  it("renders the restored selection before recreating previously enabled services", async () => {
    const order: string[] = [];
    const recreate = vi.fn(async (id: string) => {
      order.push(`recreate:${id}`);
      return result(0);
    });

    await reconcileServiceRuntime(
      {
        runtimeRecoveryNeeded: true,
        orphanedServiceIds: ["changed"],
        restartServiceIds: ["old"],
        incidentId: `recovery_${"a".repeat(64)}`,
      },
      {
        remove: vi.fn(async () => {
          order.push("remove");
          return result(0);
        }),
        recreate,
        initializeRegistry: vi.fn(async () => {
          order.push("registry");
        }),
        renderCompose: vi.fn(async () => {
          order.push("render");
        }),
      },
    );

    expect(order).toEqual(["remove", "registry", "render", "recreate:old"]);
    expect(recreate).toHaveBeenCalledWith("old");
  });

  it("durably checkpoints exact remaining work after every successful effect", async () => {
    const checkpoints: Array<{ orphanedServiceIds: string[]; restartServiceIds: string[] }> = [];
    const recovery = {
      runtimeRecoveryNeeded: true,
      incidentId: `recovery_${"b".repeat(64)}`,
      orphanedServiceIds: ["new-a", "new-b"],
      restartServiceIds: ["old-a"],
    };
    await reconcileServiceRuntime(recovery, {
      remove: vi.fn().mockResolvedValue(result(0)),
      recreate: vi.fn().mockResolvedValue(result(0)),
      initializeRegistry: vi.fn(),
      renderCompose: vi.fn(),
      checkpoint: vi.fn(async (remaining) => {
        checkpoints.push({
          orphanedServiceIds: [...remaining.orphanedServiceIds],
          restartServiceIds: [...remaining.restartServiceIds],
        });
      }),
    });
    expect(checkpoints).toEqual([
      { orphanedServiceIds: ["new-b"], restartServiceIds: ["old-a"] },
      { orphanedServiceIds: [], restartServiceIds: ["old-a"] },
      { orphanedServiceIds: [], restartServiceIds: [] },
    ]);
  });

  it("stops before the next effect when a remaining-work checkpoint fails", async () => {
    const remove = vi.fn().mockResolvedValue(result(0));
    await expect(
      reconcileServiceRuntime(
        {
          runtimeRecoveryNeeded: true,
          incidentId: `recovery_${"c".repeat(64)}`,
          orphanedServiceIds: ["new-a", "new-b"],
          restartServiceIds: [],
        },
        {
          remove,
          recreate: vi.fn(),
          initializeRegistry: vi.fn(),
          renderCompose: vi.fn(),
          checkpoint: vi.fn().mockRejectedValue(new Error("fsync failed")),
        },
      ),
    ).rejects.toThrow("fsync failed");
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("retains exact partial work across a second startup and clears only after all effects succeed", async () => {
    let retained = null as null | {
      version: 1;
      incidentId: string;
      orphanedServiceIds: string[];
      restartServiceIds: string[];
    };
    const journal = {
      record: () => structuredClone(retained),
      replace: vi.fn(async (next: NonNullable<typeof retained>) => {
        retained = structuredClone(next);
      }),
      clear: vi.fn(async () => {
        retained = null;
      }),
    };
    const incidentId = `recovery_${"d".repeat(64)}`;
    const firstRemove = vi.fn().mockResolvedValueOnce(result(0)).mockResolvedValueOnce(result(2));
    await expect(
      reconcileDurableServiceRuntime(
        {
          runtimeRecoveryNeeded: true,
          incidentId,
          orphanedServiceIds: ["new-a", "new-b"],
          restartServiceIds: ["old-a"],
        },
        journal,
        {
          remove: firstRemove,
          recreate: vi.fn(),
          initializeRegistry: vi.fn(),
          renderCompose: vi.fn(),
        },
      ),
    ).rejects.toThrow("Failed to remove stale service runtime new-b");
    expect(retained).toEqual({
      version: 1,
      incidentId,
      orphanedServiceIds: ["new-b"],
      restartServiceIds: ["old-a"],
    });
    expect(journal.clear).not.toHaveBeenCalled();

    const secondRemove = vi.fn().mockResolvedValue(result(0));
    const recreate = vi.fn().mockResolvedValue(result(0));
    await reconcileDurableServiceRuntime(
      { runtimeRecoveryNeeded: false, orphanedServiceIds: [], restartServiceIds: [] },
      journal,
      {
        remove: secondRemove,
        recreate,
        initializeRegistry: vi.fn(),
        renderCompose: vi.fn(),
      },
    );
    expect(secondRemove).toHaveBeenCalledWith("new-b");
    expect(recreate).toHaveBeenCalledWith("old-a");
    expect(retained).toBeNull();
    expect(journal.clear).toHaveBeenCalledOnce();
  });

  it("persists a discovered incident before dispatch and fails closed on journal failure", async () => {
    const remove = vi.fn();
    await expect(
      reconcileDurableServiceRuntime(
        {
          runtimeRecoveryNeeded: true,
          incidentId: `recovery_${"e".repeat(64)}`,
          orphanedServiceIds: ["new-a"],
          restartServiceIds: [],
        },
        {
          record: () => null,
          replace: vi.fn().mockRejectedValue(new Error("journal fsync failed")),
          clear: vi.fn(),
        },
        {
          remove,
          recreate: vi.fn(),
          initializeRegistry: vi.fn(),
          renderCompose: vi.fn(),
        },
      ),
    ).rejects.toThrow("journal fsync failed");
    expect(remove).not.toHaveBeenCalled();
  });
});
