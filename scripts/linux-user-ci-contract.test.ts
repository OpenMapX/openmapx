import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { selectFilePartition } from "./database-test-shards.mjs";
import { deploymentFiles } from "./test-linux-user.mjs";

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
    expect(step?.run?.replace("${{ matrix.part }}", "1").trim().split(/\s+/)).toEqual([
      "umask",
      "002",
      "&&",
      "corepack",
      "pnpm",
      "exec",
      "node",
      "scripts/test-linux-user.mjs",
      "1/2",
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
    expect(
      aggregate.steps.some((step: Step) => step.run === "node scripts/ci-impact-plan.mjs verify"),
    ).toBe(true);
    expect(job.strategy.matrix.part).toEqual([1, 2]);
    expect(job.strategy["fail-fast"]).toBe(false);
  });
});

it("covers the same complete deployment-user file inventory across isolated shards", () => {
  const root = resolve(import.meta.dirname, "..");
  const collect = (args: string[]) => {
    const result = spawnSync(
      process.execPath,
      [resolve(root, "node_modules/vitest/vitest.mjs"), ...args],
      { cwd: root, encoding: "utf8", timeout: 30000 },
    );
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout);
  };
  const full = collect(["list", ...deploymentFiles, "--project", "node", "--filesOnly", "--json"])
    .map((row: { file: string }) => row.file.replace(`${root}/`, ""))
    .sort();
  const union = [1, 2]
    .flatMap(
      (part) =>
        selectFilePartition({ filters: deploymentFiles, part, total: 2, collect, cwd: root })
          .selected,
    )
    .sort();
  expect(full.length).toBeGreaterThan(0);
  expect(union).toEqual(full);
  expect(new Set(union).size).toBe(union.length);
}, 90000);
