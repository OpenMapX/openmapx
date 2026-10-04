import { expect, it } from "vitest";
import { operations } from "./workloads";

it("checks returned identities as well as counts for mutations and API reads", () => {
  for (const name of ["ingestion", "cleanup", "api"] as const) {
    const operation = operations(name, 0, 1000)[0];
    const rows = Array.from({ length: 10 }, (_, i) => ({ id: i + 101, value: 1, user_id: 0 }));
    expect(() => operation.check(rows)).toThrow();
  }
});
it("checks ordered search proximity results", () => {
  const operation = operations("search", 0, 1000)[1];
  expect(() =>
    operation.check(
      Array.from({ length: 10 }, (_, i) => ({ gers_id: String(i + 101).padStart(8, "0") })),
    ),
  ).toThrow();
});
