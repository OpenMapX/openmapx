/** How every crash-point scenario declares its test.
 *
 * Scenarios that fail on today's code because of a defect the update-system
 * replacement removes are listed in `known-failures.json`, each with a
 * one-line reason and the signature of its failure: a regular expression the
 * failure's text must match. A listed scenario passes only when it fails that
 * way within its normal timeout. It turns red when it passes (its entry must
 * then be removed), when it fails any other way, and when it hangs. Entries
 * may only ever be removed; scenario files never change to make a scenario
 * pass. */
import { readFileSync } from "node:fs";
import { it } from "vitest";

export interface KnownFailure {
  /** Why the scenario fails today, for readers. */
  readonly reason: string;
  /** A regular expression the failure's text must match. */
  readonly fails: string;
}

const knownFailures = JSON.parse(
  readFileSync(new URL("./known-failures.json", import.meta.url), "utf8"),
) as Record<string, KnownFailure>;

function shown(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** The text a failure signature is matched against: the error's message and,
 * for an assertion, the values it compared. */
export function failureText(error: unknown): string {
  if (!(error instanceof Error)) return shown(error);
  const parts = [error.message];
  const { actual, expected } = error as Error & { actual?: unknown; expected?: unknown };
  if (actual !== undefined) parts.push(`actual: ${shown(actual)}`);
  if (expected !== undefined) parts.push(`expected: ${shown(expected)}`);
  return parts.join("\n");
}

/** Runs a listed scenario: resolves only when it fails with its signature. */
export async function expectKnownFailure(
  entry: KnownFailure,
  run: () => Promise<void>,
): Promise<void> {
  let failure: unknown;
  let failed = false;
  try {
    await run();
  } catch (error) {
    failure = error;
    failed = true;
  }
  if (!failed)
    throw new Error("This known failure now passes: remove its entry from known-failures.json");
  if (!new RegExp(entry.fails).test(failureText(failure))) throw failure;
}

export function scenario(name: string, run: () => Promise<void>, timeout: number): void {
  const entry = Object.hasOwn(knownFailures, name) ? knownFailures[name] : undefined;
  if (entry) it(name, () => expectKnownFailure(entry, run), timeout);
  else it(name, run, timeout);
}
