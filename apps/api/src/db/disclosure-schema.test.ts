import { describe, expect, it } from "vitest";
import { dataDisclosureEvent } from "./disclosure-schema.js";

describe("disclosure ledger schema", () => {
  it("exposes nullable subject attribution and no payload-bearing columns", () => {
    expect(dataDisclosureEvent.userId.notNull).toBe(false);
    expect(Object.keys(dataDisclosureEvent)).not.toContain("payload");
    expect(Object.keys(dataDisclosureEvent)).not.toContain("body");
  });
});
