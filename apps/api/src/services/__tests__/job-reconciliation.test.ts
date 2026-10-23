import { afterEach, expect, it, vi } from "vitest";

const reconcile = vi.hoisted(() => vi.fn());
vi.mock("../job-runner", () => ({ jobRunner: { reconcile } }));
const { reconcileAdminJobs, startAdminJobReconciliation, stopAdminJobReconciliation } =
  await import("../job-reconciliation");
afterEach(async () => {
  await stopAdminJobReconciliation();
  vi.useRealTimers();
  reconcile.mockReset();
});
it("runs at startup/every five seconds, coalesces passes, and stops on shutdown", async () => {
  vi.useFakeTimers();
  let finish!: () => void;
  reconcile
    .mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue(undefined);
  startAdminJobReconciliation();
  expect(reconcile).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(15_000);
  expect(reconcile).toHaveBeenCalledTimes(1);
  finish();
  await vi.advanceTimersByTimeAsync(5_000);
  expect(reconcile).toHaveBeenCalledTimes(2);
  await stopAdminJobReconciliation();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(reconcile).toHaveBeenCalledTimes(2);
});
it("clears a failed read pass for the next attempt and preserves the requested bound", async () => {
  reconcile.mockRejectedValueOnce(new Error("read unavailable")).mockResolvedValue(undefined);
  await expect(reconcileAdminJobs({ limit: 8 })).rejects.toThrow("read unavailable");
  await reconcileAdminJobs({ limit: 8 });
  expect(reconcile).toHaveBeenLastCalledWith({ limit: 8 }, expect.any(AbortSignal));
});
