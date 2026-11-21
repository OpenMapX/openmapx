import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { validationJobs } from "./ci-impact-plan.mjs";
import { databaseMatrix } from "./database-test-shards.mjs";

const ci = parse(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));
const release = parse(
  readFileSync(new URL("../.github/workflows/docker.yml", import.meta.url), "utf8"),
);
function evaluate(value: string, context: unknown) {
  return value.replace(/\$\{\{(.*?)\}\}/g, (_, expression) =>
    String(runInNewContext(expression, context as object)),
  );
}
const event = (id: number, action = "synchronize") => ({
  github: {
    workflow: "CI",
    ref: "refs/heads/main",
    run_id: id,
    run_attempt: 1,
    event_name: "push",
    event: { action, pull_request: {}, changes: {} },
  },
  format: (pattern: string, ...values: unknown[]) =>
    pattern.replace(/\{(\d+)\}/g, (_, n) => String(values[Number(n)])),
});

describe("CI scheduling and context preservation", () => {
  it("allows a new main run alongside an already-publishing predecessor", () => {
    expect(evaluate(ci.concurrency.group, event(1))).not.toBe(
      evaluate(ci.concurrency.group, event(2)),
    );
    expect(release.concurrency["cancel-in-progress"]).toBe(false);
    expect(ci.jobs.release.concurrency).toBeUndefined();
    for (const id of validationJobs) {
      const job = ci.jobs[id];
      const context = { ...event(1), matrix: { group: "coordinator-recovery", part: 1 } };
      expect(job.concurrency["cancel-in-progress"]).toBe(true);
      expect(evaluate(job.concurrency.group, context)).toBe(
        evaluate(job.concurrency.group, { ...context, ...event(2) }),
      );
    }
  });
  it("isolates manual runs, retries, and PR jobs from source-wide main cancellation", () => {
    const group = ci.jobs.lint.concurrency.group;
    const push = event(1);
    const schedule = event(2);
    schedule.github.event_name = "schedule";
    expect(evaluate(group, push)).toBe(evaluate(group, schedule));
    for (const eventName of ["workflow_dispatch", "pull_request"]) {
      const first = event(1);
      first.github.event_name = eventName;
      const second = event(2);
      second.github.event_name = eventName;
      expect(evaluate(group, first)).not.toBe(evaluate(group, second));
      expect(evaluate(group, first)).not.toBe(evaluate(group, push));
    }
    const retry = event(1);
    retry.github.run_attempt = 2;
    expect(evaluate(group, retry)).not.toBe(evaluate(group, push));
    const policy = ci.concurrency["cancel-in-progress"];
    const metadata = event(1, "edited");
    metadata.github.event_name = "pull_request";
    expect(evaluate(policy, metadata)).toBe("false");
    expect(
      ci.jobs.database.steps.find((step: { uses?: string }) =>
        step.uses?.startsWith("actions/upload-artifact@"),
      ).with.overwrite,
    ).toBe(true);
  });
  it("gives every database and Linux partition a separate cancellation key", () => {
    const keys = databaseMatrix.map((matrix) =>
      evaluate(ci.jobs.database.concurrency.group, { ...event(1), matrix }),
    );
    expect(new Set(keys).size).toBe(databaseMatrix.length);
    expect(
      evaluate(ci.jobs["test-linux-user"].concurrency.group, { ...event(1), matrix: { part: 1 } }),
    ).not.toBe(
      evaluate(ci.jobs["test-linux-user"].concurrency.group, { ...event(1), matrix: { part: 2 } }),
    );
  });
  it("does not let metadata events cancel code work or overwrite its required context with a skipped job", () => {
    const context = event(1, "edited");
    context.github.event_name = "pull_request";
    const metadata = evaluate(ci.concurrency.group, context);
    const code = evaluate(ci.concurrency.group, {
      ...context,
      github: { ...context.github, event: { ...context.github.event, action: "synchronize" } },
    });
    expect(metadata).not.toBe(code);
    expect(ci.jobs.ci.name).toBe("lint / types / test");
    expect(ci.jobs.ci.if).toContain("github.event_name == 'pull_request'");
    expect(ci.jobs.ci.if).toContain("github.event.pull_request.state != 'closed'");
    expect(
      ci.jobs.ci.steps.some(
        (step: { run?: string }) => step.run === "node scripts/ci-impact-plan.mjs verify-reuse",
      ),
    ).toBe(true);
    expect(ci.jobs.select.permissions.actions).toBe("read");
    expect(ci.jobs.ci.permissions.actions).toBe("read");
  });
  it("cancels a pull request's own run after a lint failure without gating other jobs on lint", () => {
    const job = ci.jobs["stop-after-lint-failure"];
    expect(job.needs).toBe("lint");
    expect(job.if).toBe("failure() && github.event_name == 'pull_request'");
    expect(job.permissions).toEqual({ actions: "write" });
    // The write token must never reach candidate code: no checkout, one command.
    expect(job.steps).toHaveLength(1);
    expect(job.steps[0].uses).toBeUndefined();
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Literal shell variables.
    expect(job.steps[0].run).toBe('gh run cancel "${GITHUB_RUN_ID}" --repo "${GITHUB_REPOSITORY}"');
    expect(job.steps[0]["continue-on-error"]).toBe(true);
    expect(ci.jobs.ci.needs).not.toContain("stop-after-lint-failure");
    for (const [id, other] of Object.entries<{ permissions?: { actions?: string } }>(ci.jobs))
      if (id !== "stop-after-lint-failure")
        expect(other.permissions?.actions ?? "read", id).toBe("read");
    // Every validation job still starts with lint, so a passing run is no longer.
    for (const id of validationJobs) expect(ci.jobs[id].needs, id).toBe("select");
    // The aggregate runs after a cancellation and reports the lint failure.
    expect(ci.jobs.ci.if.startsWith("always() &&")).toBe(true);
    expect(ci.jobs.ci.needs).toContain("lint");
  });
  it("type-checks every project in the required types job", () => {
    expect(validationJobs).toContain("types");
    expect(ci.jobs.ci.needs).toContain("types");
    expect(ci.jobs.types["continue-on-error"]).toBeUndefined();
    const run = ci.jobs.types.steps.map((step: { run?: string }) => step.run ?? "").join("\n");
    expect(run).toContain("pnpm check-types");
    // No separate report-only type check remains beside the required one.
    expect(Object.keys(ci.jobs)).not.toContain("types-unenforced");
  });
  it("lets a main push reuse merge-queue validation only through a verifying gate", () => {
    type Step = {
      name?: string;
      if?: string;
      run?: string;
      uses?: string;
      with?: Record<string, string>;
    };
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not a JS template
    expect(ci.jobs.select.outputs.reason).toBe("${{ steps.select.outputs['reason'] }}");
    expect(ci.jobs.ci.if).toContain("needs.select.outputs.reason == 'merge-queue-validated'");
    const steps: Step[] = ci.jobs.ci.steps;
    const verifier = (run: string) =>
      steps.find((step) => step.run === `node scripts/ci-impact-plan.mjs ${run}`);
    // With code false exactly one verifier runs, so the gate is never a green no-op.
    expect(verifier("verify")?.if).toBe(
      "needs.select.outputs.code != 'false' || needs.select.result != 'success'",
    );
    expect(verifier("verify-reuse")?.if).toBe(
      "needs.select.result == 'success' && needs.select.outputs.code == 'false' && needs.select.outputs.reason != 'merge-queue-validated'",
    );
    expect(verifier("verify-merge-queue")?.if).toBe(
      "needs.select.result == 'success' && needs.select.outputs.code == 'false' && needs.select.outputs.reason == 'merge-queue-validated'",
    );
    expect(ci.jobs.release.needs).toBe("ci");

    const warm = ci.jobs["warm-dependency-cache"];
    expect(warm.if).toBe(
      "github.event_name == 'push' && github.ref == 'refs/heads/main' && needs.select.outputs.reason == 'merge-queue-validated'",
    );
    expect(warm.permissions).toEqual({ contents: "read" });
    expect(ci.jobs.ci.needs).not.toContain("warm-dependency-cache");
  });
  it("saves Actions caches only where another run can restore them", () => {
    type Step = { name?: string; if?: string; uses?: string; with?: Record<string, string> };
    const build: Step[] = ci.jobs.build.steps;
    const main =
      "github.ref == 'refs/heads/main' && (github.event_name == 'push' || github.event_name == 'schedule')";
    expect(build.some((step) => /^actions\/cache@/.test(step.uses ?? ""))).toBe(false);
    const save = build.find((step) => step.uses?.startsWith("actions/cache/save@"));
    expect(save?.if).toBe(main);
    expect(
      build.find((step) => step.name === "Prune Turbo build outputs this build did not use")?.if,
    ).toBe(main);
    const docker: Step[] = ci.jobs["docker-build"].steps;
    const image = docker.find((step) => step.uses?.startsWith("docker/build-push-action@"));
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not a JS template
    expect(image?.with?.["cache-to"]).toBe("type=gha,mode=min,scope=${{ matrix.app }}");
  });
  it("reports every required check for a merge-queue entry", () => {
    const load = (name: string) =>
      parse(readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), "utf8"));
    // Job names are the required status checks of the main ruleset.
    const required: Record<string, readonly [string, string]> = {
      ci: ["ci", "lint / types / test"],
      "pr-title": ["validate", "Validate conventional commit title"],
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Literal GitHub Actions expression.
      codeql: ["analyze", "Analyze (${{ matrix.language }})"],
      "dependency-review": ["dependency-review", "review dependencies"],
      cla: ["cla", "check / record signature"],
    };
    for (const [name, [id, check]] of Object.entries(required)) {
      const workflow = load(name);
      expect(workflow.on.merge_group, name).toEqual({ types: ["checks_requested"] });
      expect(workflow.jobs[id]?.name, name).toBe(check);
    }
    // Entries queue behind each other, so no two may share a concurrency group.
    const metadata = load("pr-title").concurrency.group;
    // Actions reads a missing property as empty; JavaScript needs the object.
    const queued = (run_id: number) => ({ github: { run_id, event: { pull_request: {} } } });
    expect(evaluate(metadata, queued(1))).not.toBe(evaluate(metadata, queued(2)));
    expect(
      evaluate(metadata, { github: { run_id: 1, event: { pull_request: { number: 7 } } } }),
    ).toBe(evaluate(metadata, { github: { run_id: 2, event: { pull_request: { number: 7 } } } }));
    // The pull-request-only work of the two trusted workflows is not repeated.
    for (const [name, id] of [
      ["pr-title", "validate"],
      ["cla", "cla"],
    ] as const) {
      const steps: { if?: string }[] = load(name).jobs[id]?.steps ?? [];
      expect(steps[0]?.if, name).toBe("github.event_name == 'merge_group'");
      for (const step of steps.slice(1))
        expect(step.if, name).toBe("github.event_name != 'merge_group'");
    }
    // The aggregate gate checks the shard inventory against the same plan.
    const inventory = ci.jobs.ci.steps.find(
      (step: { name?: string }) => step.name === "Require the complete disjoint database inventory",
    );
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Literal GitHub Actions expression.
    expect(inventory.env.CI_PLAN).toBe("${{ needs.select.outputs.plan }}");
  });
  it("checks out only trusted default-branch code for required metadata validation", () => {
    const workflow = parse(
      readFileSync(new URL("../.github/workflows/pr-title.yml", import.meta.url), "utf8"),
    );
    const steps = workflow.jobs.validate.steps;
    expect(workflow.concurrency["cancel-in-progress"]).toBe(false);
    expect(workflow.jobs.validate.name).toBe("Validate conventional commit title");
    expect(workflow.jobs.validate.permissions.contents).toBe("read");
    const checkout = steps.find((step: { uses?: string }) =>
      step.uses?.startsWith("actions/checkout@"),
    );
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Literal GitHub Actions expression.
    expect(checkout.with.ref).toBe("${{ github.event.repository.default_branch }}");
    expect(checkout.with["persist-credentials"]).toBe(false);
    expect(
      steps.find((step: { run?: string }) => step.run?.includes("pnpm install")).run,
    ).toContain("--ignore-scripts");
    expect(
      steps.some((step: { run?: string }) => step.run === "node scripts/validate-pr-metadata.mjs"),
    ).toBe(true);
  });
});
