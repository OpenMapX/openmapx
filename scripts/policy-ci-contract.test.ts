import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");

function read(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), "utf8");
}

describe("repository policy gate", () => {
  it("collects every deterministic offline invariant in one script", () => {
    const rootPackage = JSON.parse(read("package.json")) as {
      scripts: Record<string, string>;
    };

    expect(rootPackage.scripts["check:policy"]?.split(" && ")).toEqual([
      "pnpm check-legal-tables",
      "pnpm check-legal-updated",
      "pnpm check-data-flows",
      "pnpm check-subject-data",
      "pnpm check-license-metadata",
      "pnpm check-air-quality-release-gates",
      "pnpm check-toolchain-pins",
      "pnpm check-feed-ids",
      "pnpm check-credential-keys",
      "pnpm check-dockerfile-sync",
      "pnpm check-image-size-dos",
      "pnpm check-docker-context-secrets",
      "pnpm check-ops-authority",
    ]);
  });

  it("runs the policy gate in required CI with its standalone docs dependencies", () => {
    const workflow = read(".github/workflows/ci.yml");

    expect(workflow).toMatch(
      /- name: Check repository policy invariants\n(?:\s+#.*\n)*\s+run: pnpm check:policy/,
    );
    expect(workflow).toMatch(
      /- name: Probe patched image parsers\n(?:\s+#.*\n)*\s+run: pnpm check-image-size-dos/,
    );
    expect(workflow).toMatch(
      /- name: Check Docker build contexts for secrets\n(?:\s+#.*\n)*\s+run: pnpm check-docker-context-secrets/,
    );
    expect(workflow).toMatch(
      /- name: Check host authority confinement\n(?:\s+#.*\n)*\s+run: pnpm check-ops-authority/,
    );
    const docsInstall = workflow.indexOf("- run: pnpm -C docs install --frozen-lockfile");
    const policyGate = workflow.indexOf("run: pnpm check:policy");
    expect(docsInstall).toBeGreaterThan(-1);
    expect(docsInstall).toBeLessThan(policyGate);
    expect(workflow).toMatch(/OPENMAPX_POLICY_BASE:.*github\.event\.pull_request\.base\.sha/);
  });

  it("runs the live production audit in CI without adding network access to local hooks", () => {
    const rootPackage = JSON.parse(read("package.json")) as {
      scripts: Record<string, string>;
    };
    const workflow = read(".github/workflows/ci.yml");
    const preCommit = read(".husky/pre-commit");

    expect(rootPackage.scripts["check-production-audits"]).toBe(
      "node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types scripts/check-production-audits.ts",
    );
    expect(rootPackage.scripts["check:policy"]).not.toContain("check-production-audits");
    expect(preCommit).not.toContain("check-production-audits");
    expect(workflow).toMatch(
      /- name: Audit production dependencies\n(?:\s+#.*\n)*\s+run: pnpm check-production-audits/,
    );
    const docsInstall = workflow.indexOf("- run: pnpm -C docs install --frozen-lockfile");
    const auditGate = workflow.indexOf("run: pnpm check-production-audits");
    expect(docsInstall).toBeGreaterThan(-1);
    expect(auditGate).toBeGreaterThan(docsInstall);
  });

  it("regenerates ignored native projects before auditing their release surface", () => {
    const workflow = read(".github/workflows/ci.yml");
    const prebuild = workflow.indexOf("run: pnpm mobile:prebuild:check");
    const permissionAudit = workflow.indexOf(
      "run: pnpm --filter @openmapx/mobile assert-permissions",
    );

    expect(prebuild).toBeGreaterThan(-1);
    expect(permissionAudit).toBeGreaterThan(prebuild);
    expect(workflow).not.toContain("run: pnpm --filter @openmapx/mobile assert-generated");
  });
});
