import { assert } from "vitest";

/** A value the test started, admitted or read earlier; the test fails if it is missing. */
export function present<T>(value: T | null | undefined): T {
  assert.exists(value, "a value the test set up earlier is missing");
  return value;
}
