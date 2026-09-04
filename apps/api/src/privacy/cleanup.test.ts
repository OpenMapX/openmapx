import { describe, expect, it } from "vitest";
import { runPrivacyCleanup } from "./cleanup.js";

describe("privacy cleanup", () => {
  it("does not mark a failed physical deletion as deleted", async () => {
    const calls: string[] = [];
    const result = await runPrivacyCleanup({
      artifacts: [{ id: "a", state: "expired", storageKey: "objects/a.bin" }],
      deleteArtifact: async () => {
        throw new Error("disk");
      },
      markDeleted: async () => {
        calls.push("deleted");
      },
      incident: async () => {
        calls.push("incident");
      },
    });
    expect(result.failed).toBe(1);
    expect(calls).toEqual(["incident"]);
  });
});
