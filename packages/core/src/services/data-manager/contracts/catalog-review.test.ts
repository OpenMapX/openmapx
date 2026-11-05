import { describe, expect, it } from "vitest";
import { normalizeDataExecutionInput } from "./executions";

describe("catalog durable input identities", () => {
  const proposalId = "00000000-0000-4000-8000-000000000001",
    validationId = "00000000-0000-4000-8000-000000000002";
  it("retains exact proposal and normalized countries for validation", () => {
    expect(
      normalizeDataExecutionInput({
        kind: "catalog.validate",
        proposalId,
        countries: ["DE", "at", "de"],
      }),
    ).toEqual({ kind: "catalog.validate", proposalId, countries: ["at", "de"] });
  });
  it("activates only an exact reviewed pair/evidence identity with no raw refs or passed flags", () => {
    const input = {
      kind: "catalog.activate",
      proposalId,
      validationId,
      expectedGenerationId: null,
      diffDigest: "a".repeat(64),
      acknowledgeLicenseChanges: true,
    };
    expect(normalizeDataExecutionInput(input)).toEqual(input);
    expect(() => normalizeDataExecutionInput({ ...input, passed: true })).toThrow();
    expect(() => normalizeDataExecutionInput({ ...input, ref: "main" })).toThrow();
  });
});
