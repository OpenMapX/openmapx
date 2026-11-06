import { describe, expect, it } from "vitest";
import { OpsObservationPending } from "../services/ops-client";
import { observeOriginalOperation } from "./observe-original-operation";

const identity = {
  kind: "configurationMaintenance.settle" as const,
  operationKey: "original-key",
  operationId: "original-job",
};
describe("original-operation test observation", () => {
  it("resumes the same observation after a lost read without restarting its scenario", async () => {
    let reads = 0;
    await expect(
      observeOriginalOperation(
        async () => {
          if (++reads === 1) throw new OpsObservationPending(identity, "unavailable");
          return "settled";
        },
        identity,
        new AbortController().signal,
      ),
    ).resolves.toBe("settled");
    expect(reads).toBe(2);
  });
  it.each(["operationKey", "operationId", "kind"])("does not retry changed %s", async (field) => {
    let reads = 0;
    const error = new OpsObservationPending({ ...identity, [field]: "different" }, "unavailable");
    await expect(
      observeOriginalOperation(
        async () => {
          reads++;
          throw error;
        },
        identity,
        new AbortController().signal,
      ),
    ).rejects.toBe(error);
    expect(reads).toBe(1);
  });
  it.each(["invalid_identity", "recovery_required", "transport", "observer_deadline"] as const)(
    "does not hide %s failures",
    async (reason) => {
      let reads = 0;
      const error = new OpsObservationPending(identity, reason);
      await expect(
        observeOriginalOperation(
          async () => {
            reads++;
            throw error;
          },
          identity,
          new AbortController().signal,
        ),
      ).rejects.toBe(error);
      expect(reads).toBe(1);
    },
  );
  it("does not retry assertions or failed operations", async () => {
    let reads = 0;
    const error = Error("assertion failed");
    await expect(
      observeOriginalOperation(
        async () => {
          reads++;
          throw error;
        },
        identity,
        new AbortController().signal,
      ),
    ).rejects.toBe(error);
    expect(reads).toBe(1);
  });
  it("limits resumption to three observations and respects the original abort signal", async () => {
    let reads = 0;
    const error = new OpsObservationPending(identity, "unavailable");
    await expect(
      observeOriginalOperation(
        async () => {
          reads++;
          throw error;
        },
        identity,
        new AbortController().signal,
      ),
    ).rejects.toBe(error);
    expect(reads).toBe(3);
    await expect(
      observeOriginalOperation(
        async () => {
          reads++;
        },
        identity,
        AbortSignal.abort(),
      ),
    ).rejects.toThrow();
    expect(reads).toBe(3);
  });
});
