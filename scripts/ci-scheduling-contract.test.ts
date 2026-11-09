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
  it("keeps the unenforced type report out of the required aggregate", () => {
    const job = ci.jobs["types-unenforced"];
    expect(ci.jobs.ci.needs).not.toContain("types-unenforced");
    expect(validationJobs).not.toContain("types-unenforced");
    expect(job.needs).toBe("select");
    expect(job.if).toContain("needs.select.outputs.code == 'true'");
    expect(job["timeout-minutes"]).toBeGreaterThan(0);
    expect(job["continue-on-error"]).toBeUndefined();
    const run = job.steps.map((step: { run?: string }) => step.run ?? "").join("\n");
    expect(run).toContain('pnpm check-types:unenforced --summary "$GITHUB_STEP_SUMMARY"');
    // The required type check must never run the projects that still fail.
    expect(
      ci.jobs.types.steps.some((step: { run?: string }) => step.run?.includes("unenforced")),
    ).toBe(false);
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
