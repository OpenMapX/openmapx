import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type Step = {
  name?: string;
  run?: string;
  if?: string;
  "continue-on-error"?: boolean;
};

const workflow = parse(
  readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
);
const job = workflow.jobs["test-linux-user"];
const steps: Step[] = job.steps;

describe("required Linux deployment-user gate", () => {
  it("runs the complete suite selection with one file worker", () => {
    const step = steps.find(
      (value) =>
        value.name === "Run the agent, core and data-manager suites and the deployment-user test",
    );
    expect(step?.run?.trim().split(/\s+/)).toEqual([
      "umask",
      "002",
      "&&",
      "corepack",
      "pnpm",
      "exec",
      "vitest",
      "run",
      "--project",
      "node",
      "--maxWorkers=1",
      "apps/ops-agent",
      "packages/core",
      "services/data-manager",
      "scripts/ops-agent-deployment-user.test.ts",
    ]);
  });

  it("keeps the pinned runtime, deployment identity, umask and failure handling", () => {
    const version = readFileSync(new URL("../.nvmrc", import.meta.url), "utf8").trim();
    const [image, digest] = job.container.image.split("@");
    expect(image).toBe(`node:${version}-bookworm`);
    expect(digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(job.container.options).toBe("--user 1001:1001 --init");
    expect(job.env).toEqual({
      HOME: "/tmp/home",
      COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
      OPENMAPX_TEST_DEPLOYMENT_USER: "1001",
    });
    expect(job.defaults.run.shell).toBe("bash");
    expect(job["timeout-minutes"]).toBe(30);
    const confirmation = steps.find((step) => step.name === "Confirm the user and umask");
    expect(confirmation?.run).toContain("umask 002");
    expect(confirmation?.run).toContain('test "$(id -u)" = 1001 && test "$(umask)" = 0002');
    expect(job["continue-on-error"]).toBeUndefined();
    for (const step of steps) expect(step["continue-on-error"]).toBeUndefined();
  });

  it("requires the Linux job to succeed before the aggregate can pass", () => {
    const aggregate = workflow.jobs.ci;
    expect(aggregate.needs).toContain("test-linux-user");
    const failure = (aggregate.steps as Step[]).find(
      (step) => step.name === "Fail if any gate job did not succeed",
    );
    expect(failure?.if).toContain("needs.test-linux-user.result != 'success'");
  });
});
