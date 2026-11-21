import { describe, expect, it } from "vitest";
import { catalogTranslator } from "@/test/catalogTranslator";
import { sourceStateLabel, type TransitSource } from "./TransitSourcesSection";

const t = catalogTranslator("adminServices");

function source(overrides: Partial<TransitSource>): TransitSource {
  return {
    sourceRevision: "a".repeat(64),
    desiredState: "enabled",
    actions: { enable: false, disable: true, remove: false, reason: null },
    id: "de-test",
    region: "de",
    name: "Test",
    format: "gtfs",
    origin: "catalog",
    license: {},
    requested: true,
    active: true,
    lifecycle: "active",
    ...overrides,
  };
}

describe("transit source state labels", () => {
  it("makes desired, active, and pending states explicit", () => {
    expect(sourceStateLabel(source({}), t)).toBe("Requested · active");
    expect(sourceStateLabel(source({ lifecycle: "update-pending" }), t)).toBe(
      "Update pending · active",
    );
    expect(sourceStateLabel(source({ lifecycle: "removal-pending", requested: false }), t)).toBe(
      "Removal pending · active",
    );
    expect(
      sourceStateLabel(source({ lifecycle: "add-pending", active: false, requested: true }), t),
    ).toBe("Add pending · not active");
    expect(sourceStateLabel(source({ lifecycle: "failed", active: false }), t)).toBe(
      "Requested · failed",
    );
    expect(
      sourceStateLabel(source({ lifecycle: "disabled", active: false, requested: false }), t),
    ).toBe("Disabled · not active");
  });
});
