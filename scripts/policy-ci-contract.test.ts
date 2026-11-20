import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { POLICY_CHECKS } from "./run-policy-checks.mjs";

const root = resolve(import.meta.dirname, "..");

function read(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), "utf8");
}

type Step = { name?: string; run?: string };

describe("repository policy gate", () => {
  it("runs the live production audit in CI without adding network access to local hooks", () => {
    const rootPackage = JSON.parse(read("package.json")) as {
      scripts: Record<string, string>;
    };
    const workflow = parse(read(".github/workflows/ci.yml")) as {
      jobs: Record<string, { steps?: Step[] }>;
    };
    const preCommit = read(".husky/pre-commit");

    expect(rootPackage.scripts["check-production-audits"]).toBe(
      "node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types scripts/check-production-audits.ts",
    );
    expect(POLICY_CHECKS).not.toContain("check-production-audits");
    expect(preCommit).not.toContain("check-production-audits");
    const steps = workflow.jobs.lint?.steps ?? [];
    const docsInstall = steps.findIndex(
      (step) => step.run === "pnpm -C docs install --frozen-lockfile",
    );
    const policy = steps.findIndex((step) => step.run === "pnpm check:policy");
    const auditGate = steps.findIndex((step) => step.name === "Audit production dependencies");
    expect(steps[auditGate]?.run).toBe("pnpm check-production-audits");
    expect(docsInstall).toBeGreaterThan(-1);
    expect(policy).toBeGreaterThan(docsInstall);
    expect(auditGate).toBeGreaterThan(docsInstall);
  });
});
