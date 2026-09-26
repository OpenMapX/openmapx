import { describe, expect, it } from "vitest";
import { validObservedAt } from "./observationTime";

describe("upstream observation time", () => {
  const now = new Date("2026-09-26T10:00:00Z");

  it("keeps a reported timestamp with an explicit timezone", () => {
    expect(validObservedAt("2026-09-25T12:34:56Z", now)).toBe("2026-09-25T12:34:56Z");
  });

  it.each(["bad", "2026-09-27T10:00:00Z", "2026-02-30T10:00:00Z", "2026-09-25T12:00:00"])(
    "rejects a malformed, future or timezone-less observation: %s",
    (value) => expect(validObservedAt(value, now)).toBeUndefined(),
  );
});
