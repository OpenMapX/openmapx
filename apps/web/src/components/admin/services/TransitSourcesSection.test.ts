import { describe, expect, it } from "vitest";
import { sourceStateLabel, type TransitSource } from "./TransitSourcesSection";

function source(overrides: Partial<TransitSource>): TransitSource {
  return {
    id: "de-test",
    region: "de",
    name: "Test",
    format: "gtfs",
    origin: "catalog",
    requested: true,
    active: true,
    lifecycle: "active",
    ...overrides,
  };
}

describe("transit source state labels", () => {
  it("makes desired, active, and pending states explicit", () => {
    expect(sourceStateLabel(source({}))).toBe("Requested · active");
    expect(sourceStateLabel(source({ lifecycle: "update-pending" }))).toBe(
      "Update pending · active",
    );
    expect(sourceStateLabel(source({ lifecycle: "removal-pending", requested: false }))).toBe(
      "Removal pending · active",
    );
    expect(
      sourceStateLabel(source({ lifecycle: "add-pending", active: false, requested: true })),
    ).toBe("Add pending · not active");
    expect(sourceStateLabel(source({ lifecycle: "failed", active: false }))).toBe(
      "Requested · failed",
    );
    expect(
      sourceStateLabel(source({ lifecycle: "disabled", active: false, requested: false })),
    ).toBe("Disabled · not active");
  });
});
