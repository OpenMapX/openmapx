import { describe, expect, it } from "vitest";
import { createDirectAdminOpsKey, parseDirectOpsIdempotency } from "../direct-ops-idempotency";

describe("direct admin operations idempotency", () => {
  it("reuses one key for an admin intent and separates admin identities", () => {
    const value = "018f7b8a-3c7a-7b91-a9b0-9d6dd0f51ab1";
    expect(createDirectAdminOpsKey("admin-a", value)).toBe(
      createDirectAdminOpsKey("admin-a", value),
    );
    expect(createDirectAdminOpsKey("admin-a", value)).not.toBe(
      createDirectAdminOpsKey("admin-b", value),
    );
  });

  it.each([
    [undefined],
    ["short"],
    ["--flag-shaped-idempotency"],
    ["contains whitespace invalid"],
    ["x".repeat(129)],
    [["valid-value-123456", "duplicate-value-123"]],
  ])("rejects a missing or malformed caller-retained value %#", (value) => {
    expect(() => parseDirectOpsIdempotency(value)).toThrow("Idempotency-Key");
  });
});
