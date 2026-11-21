import { assert } from "vitest";
import { createOpenConditionsClient } from "../client.js";

/** A value the fixture is known to hold; the test fails if it is missing. */
export function found<T>(value: T | null | undefined, what = "fixture value"): T {
  assert.exists(value, `${what} is missing`);
  return value;
}

/** The element at `index`, counting back from the end for a negative one; the test fails if there is none. */
export function nth<T>(values: readonly T[], index: number): T {
  return found(values.at(index), `element ${index} of ${values.length}`);
}

/** A configured OpenConditions client; the test fails if the arguments configure none. */
export function connectedClient(...args: Parameters<typeof createOpenConditionsClient>) {
  return found(createOpenConditionsClient(...args), "the OpenConditions client");
}

/** The licensing an attribution carries; the test fails without one. */
export function licensingOf<L>(
  attribution: { readonly sourceId?: string; readonly licensing?: L } | undefined,
): L {
  assert.isDefined(attribution, "the attribution is missing");
  assert.isDefined(
    attribution.licensing,
    `${attribution.sourceId ?? "the attribution"} carries no licensing`,
  );
  return attribution.licensing;
}

/** The first record of a `/features` answer; the test fails if it has none. */
export function recordOf<R>(answer: { readonly records: readonly R[] }): R {
  return found(answer.records[0], "the answer's record");
}

/** The latest readings a `/features` answer expands for one feature; the test fails without them. */
export function latestOf<R>(
  answer: { readonly latest: Readonly<Record<string, R[]>> },
  featureId: string,
): R[] {
  return found(answer.latest[featureId], `the readings of ${featureId}`);
}

/** The offers a `/features` answer expands for one feature; the test fails without them. */
export function offersOf<R>(
  answer: { readonly offers: Readonly<Record<string, R[]>> },
  featureId: string,
): R[] {
  return found(answer.offers[featureId], `the offers of ${featureId}`);
}
