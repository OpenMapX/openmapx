/** How every crash-point scenario declares its test.
 *
 * Scenarios that fail on today's code because of a defect the update-system
 * replacement removes are listed, with a one-line reason, in
 * `known-failures.json`. Listed scenarios run as expected failures: the suite
 * stays green while the defect exists and turns red as soon as one passes,
 * which is when its entry must be removed. Entries may only ever be removed;
 * scenario files never change to make a scenario pass. */
import { readFileSync } from "node:fs";
import { it } from "vitest";

const knownFailures = JSON.parse(
  readFileSync(new URL("./known-failures.json", import.meta.url), "utf8"),
) as Record<string, string>;

export function scenario(name: string, run: () => Promise<void>, timeout: number): void {
  if (Object.hasOwn(knownFailures, name)) it.fails(name, run, timeout);
  else it(name, run, timeout);
}
