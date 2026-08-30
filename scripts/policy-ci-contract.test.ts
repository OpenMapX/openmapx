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

  it("runs the same policy gate in required CI and the local hook", () => {
    const workflow = read(".github/workflows/ci.yml");
    const preCommit = read(".husky/pre-commit");

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
    expect(preCommit).toContain("pnpm check:policy || exit 1");
  });

  it("clears Git hook-local paths before tests create temporary repositories", () => {
    const prePush = read(".husky/pre-push");
    const cleanup = prePush.indexOf("unset \\");
    const checks = prePush.indexOf("pnpm check-types");

    expect(cleanup).toBeGreaterThan(-1);
    expect(cleanup).toBeLessThan(checks);
    const cleanupBlock = prePush.slice(cleanup, checks);
    for (const variable of [
      "GIT_ALTERNATE_OBJECT_DIRECTORIES",
      "GIT_COMMON_DIR",
      "GIT_CONFIG",
      "GIT_CONFIG_COUNT",
      "GIT_CONFIG_PARAMETERS",
      "GIT_DIR",
      "GIT_GRAFT_FILE",
      "GIT_IMPLICIT_WORK_TREE",
      "GIT_INDEX_FILE",
      "GIT_NO_REPLACE_OBJECTS",
      "GIT_OBJECT_DIRECTORY",
      "GIT_PREFIX",
      "GIT_REPLACE_REF_BASE",
      "GIT_SHALLOW_FILE",
      "GIT_WORK_TREE",
    ]) {
      expect(cleanupBlock).toContain(variable);
    }
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
