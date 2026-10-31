import { createServiceBatchResult } from "@openmapx/core/ops";
import { describe, expect, it, vi } from "vitest";
import { AdminJobFailure } from "../admin-job-failure";
import type { JobContext } from "../job-runner";
import { finishServiceBatch } from "../service-batch-result";

describe("finishServiceBatch", () => {
  function context() {
    const ctx = {
      checkpointResult: { retained: true } as Record<string, unknown>,
      checkpoint: vi.fn(async (result: Record<string, unknown>) => {
        ctx.checkpointResult = result;
      }),
    };
    return ctx as unknown as JobContext;
  }
  it("retains the checkpoint and returns only a successful nonempty batch", async () => {
    const ctx = context();
    const batch = createServiceBatchResult(["alpha"], ["alpha"], [], []);
    await expect(finishServiceBatch(ctx, batch)).resolves.toEqual(batch);
    expect(ctx.checkpointResult).toMatchObject({ retained: true, serviceBatch: batch });
  });
  it.each(["partial", "failed", "empty"] as const)(
    "checkpoints %s before throwing a typed job failure",
    async (mode) => {
      const ctx = context();
      const batch =
        mode === "empty"
          ? createServiceBatchResult([], [], [], [])
          : createServiceBatchResult(
              ["alpha", "beta"],
              mode === "partial" ? ["alpha"] : [],
              ["beta"],
              mode === "failed" ? ["alpha"] : [],
            );
      const error = await finishServiceBatch(ctx, batch).catch((error) => error);
      expect(error).toBeInstanceOf(AdminJobFailure);
      expect(error.result).toEqual(ctx.checkpointResult);
      expect(error.result.serviceBatch).toEqual(batch);
    },
  );
});
