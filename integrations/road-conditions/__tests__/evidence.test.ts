import { describe, expect, it } from "vitest";
import { isUnconfirmedCrowd } from "../evidence";

describe("isUnconfirmedCrowd", () => {
  it("is true for a self-reported crowd event", () => {
    expect(isUnconfirmedCrowd({ originKind: "crowd", evidenceState: "self_reported" })).toBe(true);
  });

  it("is true for a crowd event with no evidenceState", () => {
    expect(isUnconfirmedCrowd({ originKind: "crowd" })).toBe(true);
  });

  it("is false once a crowd event is externally_resolved", () => {
    expect(isUnconfirmedCrowd({ originKind: "crowd", evidenceState: "externally_resolved" })).toBe(
      false,
    );
  });

  it("is false for a feed event", () => {
    expect(isUnconfirmedCrowd({ originKind: "feed", evidenceState: "self_reported" })).toBe(false);
  });

  it("is false for an event with no originKind (official third-party provider)", () => {
    expect(isUnconfirmedCrowd({})).toBe(false);
  });
});
