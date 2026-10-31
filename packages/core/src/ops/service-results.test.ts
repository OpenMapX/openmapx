import { describe, expect, it } from "vitest";
import { OPS_KIND_POLICIES } from "./contract";
import { opsFailureResultSchema } from "./job-evidence";
import { createServiceBatchResult, serviceBatchResultSchema } from "./service-results";

describe("service batch evidence", () => {
  it("keeps unknown attempted targets separate from skipped targets", () => {
    expect(createServiceBatchResult(["alpha", "beta"], ["alpha"], [], [])).toEqual({
      outcome: "partial",
      completedServiceIds: ["alpha"],
      failedServiceIds: [],
      skippedServiceIds: [],
    });
  });
  it("rejects unadmitted, duplicate, overlapping and falsely successful results", () => {
    expect(() => createServiceBatchResult(["alpha"], ["beta"], [], [])).toThrow();
    expect(() => createServiceBatchResult(["alpha"], ["alpha"], ["alpha"], [])).toThrow();
    expect(() => createServiceBatchResult(["alpha", "alpha"], ["alpha"], [], [])).toThrow();
    expect(
      serviceBatchResultSchema.safeParse({
        outcome: "success",
        completedServiceIds: [],
        failedServiceIds: [],
        skippedServiceIds: [],
      }).success,
    ).toBe(false);
    expect(
      serviceBatchResultSchema.safeParse({
        outcome: "success",
        completedServiceIds: ["alpha"],
        failedServiceIds: ["beta"],
        skippedServiceIds: [],
      }).success,
    ).toBe(false);
  });
  it("fits all 256 maximum-length service IDs in the build-all failure budget", () => {
    const ids = Array.from(
      { length: 256 },
      (_, i) => `service-${String(i).padStart(3, "0")}-${"x".repeat(52)}`,
    );
    const serviceBatch = createServiceBatchResult(ids, ids.slice(0, 128), ids.slice(128), []);
    const failure = opsFailureResultSchema.parse({ serviceBatch });
    expect(JSON.stringify(failure).length).toBeGreaterThan(16 * 1024);
    expect(Buffer.byteLength(JSON.stringify(failure))).toBeLessThanOrEqual(
      OPS_KIND_POLICIES["services.buildAll"].maxResultBytes,
    );
  });
});
