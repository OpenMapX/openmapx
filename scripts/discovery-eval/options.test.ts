import { expect, it } from "vitest";
import { parseOptions } from "./options.js";

it("resolves operator paths relative to the repository despite pnpm's CLI workspace", () => {
  expect(
    parseOptions(
      ["--evidence", "scripts/example.json", "--baseline", "before/report.json"],
      "/repo",
    ),
  ).toMatchObject({ evidence: "/repo/scripts/example.json", baseline: "/repo/before/report.json" });
});
it("rejects unknown flags and missing paths without repeating potentially secret input", () => {
  expect(() => parseOptions(["--api-key", "secret"], "/repo")).toThrow(/^Usage:/);
  expect(() => parseOptions(["--evidence"], "/repo")).toThrow(/^Usage:/);
});
