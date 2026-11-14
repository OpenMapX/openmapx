import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = resolve(import.meta.dirname, "..");

type Step = { uses?: string; run?: string; with?: Record<string, unknown> };

const workflow = parse(
  readFileSync(resolve(root, ".github/workflows/update-smoke.yml"), "utf8"),
) as {
  permissions: Record<string, string>;
  jobs: Record<
    string,
    { permissions: Record<string, string>; "timeout-minutes": number; steps: Step[] }
  >;
};
const script = readFileSync(resolve(root, "scripts/ci/update-smoke.sh"), "utf8");

describe("update smoke workflow", () => {
  it("holds read-only permissions, pinned actions and a bounded run", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    for (const job of Object.values(workflow.jobs)) {
      expect(job.permissions).toEqual({ contents: "read" });
      expect(job["timeout-minutes"]).toBe(90);
      for (const step of job.steps) {
        if (step.uses) expect(step.uses).toMatch(/@[0-9a-f]{40}( #.*)?$/);
        if (step.uses?.startsWith("actions/checkout@"))
          expect(step.with?.["persist-credentials"]).toBe(false);
      }
    }
  });

  it("runs the checked-in script, which reuses the install smoke", () => {
    const steps = Object.values(workflow.jobs).flatMap((job) => job.steps);
    expect(steps.some((step) => step.run === "bash scripts/ci/update-smoke.sh")).toBe(true);
    expect(statSync(resolve(root, "scripts/ci/update-smoke.sh")).mode & 0o111).not.toBe(0);
    expect(script).toContain('source "$root/scripts/ci/install-smoke.sh"');
  });
});
