import { describe, expect, it } from "vitest";
import { calculateSubjectRequestDueAt } from "./deadline.js";
import { assertAssemblyReady, assertValidRequestTransition } from "./request-contracts.js";

describe("privacy request service invariants", () => {
  it("uses a calendar deadline rather than a fixed duration", () => {
    expect(
      calculateSubjectRequestDueAt(new Date("2024-01-31T00:00:00Z"), "UTC").toISOString(),
    ).toBe("2024-02-29T00:00:00.000Z");
  });

  it("rejects direct terminal or repeated transitions", () => {
    expect(() => assertValidRequestTransition("received", "closed")).toThrow();
    expect(() => assertValidRequestTransition("ready", "withdrawn")).not.toThrow();
  });

  it("does not permit assembly while a mandatory task is pending", () => {
    expect(() => assertAssemblyReady([{ status: "pending", required: true }])).toThrow(
      "unresolved",
    );
  });
});
