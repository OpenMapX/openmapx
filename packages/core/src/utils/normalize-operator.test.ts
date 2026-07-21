import { describe, expect, it } from "vitest";
import { normalizeOperator } from "./normalize-operator.js";

describe("normalizeOperator", () => {
  it("collapses legal suffixes and punctuation to a stable key", () => {
    expect(normalizeOperator("IONITY GmbH")).toBe("ionity");
    expect(normalizeOperator("Ionity")).toBe("ionity");
    expect(normalizeOperator("Fastned B.V.")).toBe("fastned");
    expect(normalizeOperator("  EnBW  ")).toBe("enbw");
    expect(normalizeOperator(undefined)).toBe("");
  });
});
