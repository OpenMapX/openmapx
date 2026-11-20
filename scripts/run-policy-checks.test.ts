import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { POLICY_CHECKS, runPolicyChecks } from "./run-policy-checks.mjs";

const rootPackage = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { scripts: Record<string, string> };

describe("policy check runner", () => {
  it("runs from check:policy and names only existing root scripts, once each", () => {
    expect(rootPackage.scripts["check:policy"]).toBe("node scripts/run-policy-checks.mjs");
    expect(new Set(POLICY_CHECKS).size).toBe(POLICY_CHECKS.length);
    for (const name of POLICY_CHECKS) expect(rootPackage.scripts, name).toHaveProperty(name);
  });

  it("runs every check after a failure and reports each failed one", () => {
    const ran: string[] = [];
    const failed = runPolicyChecks(
      (name) => {
        ran.push(name);
        return name === "first" || name === "third" ? 1 : 0;
      },
      ["first", "second", "third", "fourth"],
    );
    expect(ran).toEqual(["first", "second", "third", "fourth"]);
    expect(failed).toEqual(["first", "third"]);
  });

  it("reports nothing when every check passes", () => {
    expect(runPolicyChecks(() => 0, ["first", "second"])).toEqual([]);
  });
});
