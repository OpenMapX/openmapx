import { expect, it } from "vitest";
import {
  criticalAdvisoryFor,
  mergeCriticalAdvisories,
  widerAdvisory,
} from "./extension-critical-advisory";

const bounded = { reason: "fixed in 1.2.1", maxVersion: "1.2.0" };
const unbounded = { reason: "every version" };
const unreadable = { reason: "bad bound", maxVersion: "next" };

it("treats a bound that is not a version as covering every version, in either order", () => {
  // criticalAdvisoryFor denies every version for such a bound, so a merge keeps it.
  expect(criticalAdvisoryFor({ critical: new Map([["x", unreadable]]) }, "x", "9.0.0")).toBe(
    unreadable,
  );
  expect(widerAdvisory(bounded, unreadable)).toBe(unreadable);
  expect(widerAdvisory(unreadable, bounded)).toBe(unreadable);
  expect(widerAdvisory(bounded, unbounded)).toBe(unbounded);
  expect(widerAdvisory(bounded, { reason: "later", maxVersion: "1.3.0" }).maxVersion).toBe("1.3.0");
  expect(
    mergeCriticalAdvisories([
      ["x", bounded],
      ["x", unreadable],
    ]).get("x"),
  ).toBe(unreadable);
});
