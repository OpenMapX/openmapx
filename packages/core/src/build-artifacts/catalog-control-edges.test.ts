import { describe, expect, it } from "vitest";
import { verifyFiniteControlEdge } from "./target-lease";

describe("finite catalog workflow edges", () => {
  it("allows validation's staging and restoration leaves without promotion/activation", () => {
    for (const phase of [
      "stop-staging",
      "restart-staging",
      "proxy-stage",
      "proxy-restore",
    ] as const)
      expect(() =>
        verifyFiniteControlEdge("data-manager", "catalog.validate", phase, "ops-agent"),
      ).not.toThrow();
    for (const phase of [
      "promote-primary",
      "stop-primary",
      "recover-primary",
      "proxy-commit",
      "paired-pin-commit",
    ] as const)
      expect(() =>
        verifyFiniteControlEdge("data-manager", "catalog.validate", phase, "ops-agent"),
      ).toThrow();
  });
  it("keeps paired commit specific to activation and the intended recipient", () => {
    expect(() =>
      verifyFiniteControlEdge("data-manager", "catalog.activate", "paired-pin-commit", "ops-agent"),
    ).not.toThrow();
    expect(() =>
      verifyFiniteControlEdge("data-manager", "transit-sync", "paired-pin-commit", "ops-agent"),
    ).toThrow();
    expect(() =>
      verifyFiniteControlEdge(
        "data-manager",
        "catalog.activate",
        "paired-pin-commit",
        "data-manager",
      ),
    ).toThrow();
  });
});
