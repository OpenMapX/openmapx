import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");

function read(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), "utf8");
}

describe("repository policy gate", () => {
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
});
