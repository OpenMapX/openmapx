import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = resolve(import.meta.dirname, "..");

type Step = { uses?: string; run?: string; with?: Record<string, unknown> };

const workflow = parse(
  readFileSync(resolve(root, ".github/workflows/update-smoke.yml"), "utf8"),
) as {
  on: {
    push: { branches: string[] };
    schedule: { cron: string }[];
    pull_request: { paths: string[] };
  } & Record<string, unknown>;
  permissions: Record<string, string>;
  concurrency: { group: string; "cancel-in-progress": unknown };
  jobs: Record<
    string,
    { permissions: Record<string, string>; "timeout-minutes": number; steps: Step[] }
  >;
};
const script = readFileSync(resolve(root, "scripts/ci/update-smoke.sh"), "utf8");

describe("update smoke workflow", () => {
  it("runs on main, nightly and manually, and on pull requests for the update path", () => {
    expect(workflow.on.push.branches).toEqual(["main"]);
    expect(workflow.on.schedule).toHaveLength(1);
    expect(workflow.on).toHaveProperty("workflow_dispatch");
    expect(workflow.on).not.toHaveProperty("pull_request_target");
    expect(workflow.on.pull_request.paths).toEqual(
      expect.arrayContaining([
        "packages/cli/**",
        "packages/core/src/build-artifacts/**",
        "apps/ops-agent/**",
        "services/**",
        "scripts/ci/install-smoke.sh",
        "scripts/ci/update-smoke.sh",
        ".github/workflows/update-smoke.yml",
      ]),
    );
  });

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

  it("cancels superseded pull-request runs but never a run on main", () => {
    expect(workflow.concurrency["cancel-in-progress"]).toBe(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not a JS template
      "${{ github.event_name == 'pull_request' }}",
    );
    expect(workflow.concurrency.group).toContain("github.event.pull_request.number");
  });

  it("runs the checked-in script, which reuses the install smoke", () => {
    const steps = Object.values(workflow.jobs).flatMap((job) => job.steps);
    expect(steps.some((step) => step.run === "bash scripts/ci/update-smoke.sh")).toBe(true);
    expect(statSync(resolve(root, "scripts/ci/update-smoke.sh")).mode & 0o111).not.toBe(0);
    expect(script).toContain('source "$root/scripts/ci/install-smoke.sh"');
  });

  it("covers the self-update and every contained failure", () => {
    const cases = /cases="\$\{UPDATE_SMOKE_CASES:-([^}]*)\}"/.exec(script)?.[1]?.split(" ");
    expect(cases).toEqual(["happy", "registry", "unhealthy", "helper", "agent", "cli"]);
    for (const name of cases ?? []) expect(script).toContain(`case_${name}() {`);
  });
});
