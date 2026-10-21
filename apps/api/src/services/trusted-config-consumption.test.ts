import { describe, expect, it } from "vitest";
import { consumePublishedTrustedConfiguration } from "./trusted-config-publisher";

describe("trusted configuration cleanup evidence", () => {
  it("retains a known submitted result despite publisher cleanup failure", async () => {
    const value = { outcome: "committed", revisionId: "synthetic" };
    const result = await consumePublishedTrustedConfiguration(
      {
        abort: async () => {
          throw new Error("cleanup");
        },
      },
      async () => value,
    ).catch((error) => error);
    expect(result).toMatchObject({
      submission: { status: "fulfilled", value },
      cleanupFailed: true,
    });
  });
  it("retains both primary rejection and cleanup failure without inferring non-commit", async () => {
    const primary = new Error("transport lost");
    const result = await consumePublishedTrustedConfiguration(
      {
        abort: async () => {
          throw new Error("cleanup");
        },
      },
      async () => {
        throw primary;
      },
    ).catch((error) => error);
    expect(result).toMatchObject({
      submission: { status: "rejected", reason: primary },
      cleanupFailed: true,
    });
  });
});
