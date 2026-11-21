import examples from "./dbNavigator.json";

const [first, second, third, fourth, ...extra] = examples;
if (
  first === undefined ||
  second === undefined ||
  third === undefined ||
  fourth === undefined ||
  extra.length > 0
) {
  throw new Error("Expected exactly four DB Navigator examples");
}

/** Supplied examples with synthetic booking identifiers. */
export const dbNavigatorExamples: readonly [string, string, string, string] = [
  first,
  second,
  third,
  fourth,
];
