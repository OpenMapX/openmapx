import { describe, expect, it, vi } from "vitest";
import { createDataExecutionRuntime } from "./runtime.js";
import type { DataExecutionStore } from "./store.js";

/** The shape a restore leaves behind for an execution that was in progress. */
function closedByRestore(status: "error" | "ok") {
  const id = "00000000-0000-4000-8000-000000000008";
  return {
    triggeredBy: null,
    execution: { executionId: id, operationKey: `opk1_${"b".repeat(20)}` },
    status: {
      id,
      status,
      publication: "not_started",
      cancellationRequestedAt: null,
      deadlineAt: 100,
    },
    input: {},
    operationFingerprint: "b".repeat(64),
    requestedDeadlineAt: null,
    parent: null,
    version: 4,
    children: [],
    reservations: [],
    finishedAt: 1,
  };
}

describe("reconciling an execution closed by a restore", () => {
  it.each(["error", "ok"] as const)(
    "never moves a terminal %s execution back to interrupted or unknown",
    async (status) => {
      const checkpoint = vi.fn();
      const finalize = vi.fn();
      const dispatch = vi.fn();
      const fence = vi.fn().mockResolvedValue(undefined);
      const store = {
        controlJournal: {
          assertOwnedProxyRecoverySettled: vi.fn().mockRejectedValue(new Error("no evidence")),
          repairTerminal: vi.fn().mockRejectedValue(new Error("no evidence")),
          publishTerminal: vi.fn().mockRejectedValue(new Error("no evidence")),
          fenceUnsettledProxyRecovery: fence,
        },
        listUnsettled: async () => [closedByRestore(status)],
        checkpoint,
        finalize,
      } as unknown as DataExecutionStore;
      await createDataExecutionRuntime({ store, dispatch }).reconcile();
      expect(fence).toHaveBeenCalledOnce();
      expect(checkpoint).not.toHaveBeenCalled();
      expect(finalize).not.toHaveBeenCalled();
      expect(dispatch).not.toHaveBeenCalled();
    },
  );
});
