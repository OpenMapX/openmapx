import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type Step = { uses?: string; run?: string; with?: Record<string, unknown> };
type Workflow = { on?: unknown; jobs: Record<string, { steps?: Step[] }> };

const SETUP = "./.github/actions/setup-workspace";
const directory = new URL("../.github/workflows/", import.meta.url);
const workflows = Object.fromEntries(
  readdirSync(directory)
    .filter((name) => name.endsWith(".yml"))
    .map((name) => [name, parse(readFileSync(new URL(name, directory), "utf8")) as Workflow]),
);
const action = parse(
  readFileSync(new URL("../.github/actions/setup-workspace/action.yml", import.meta.url), "utf8"),
) as { runs: { using: string; steps: Step[] } };

/**
 * Workflows that keep the setup steps inline: trusted or privileged contexts
 * must not run action code from the checked-out tree, release workflows own
 * their install flags, and the smoke tests install as an operator would.
 */
const INLINE_WORKFLOWS = [
  "docker.yml",
  "install-smoke.yml",
  "package-release.yml",
  "pr-title.yml",
  "update-smoke.yml",
];
/** Jobs whose install differs from the plain frozen install. */
const INLINE_JOBS = ["ci.yml#warm-dependency-cache"];

const jobs = Object.entries(workflows).flatMap(([file, workflow]) =>
  Object.entries(workflow.jobs).map(([id, job]) => ({ file, id, steps: job.steps ?? [] })),
);
const usesAction = (step: Step, name: string) => step.uses?.split("@")[0] === name;

describe("workspace setup in workflows", () => {
  it("installs pnpm, the .nvmrc Node with the pnpm cache, and the frozen lockfile", () => {
    const { using, steps } = action.runs;
    expect(using).toBe("composite");
    expect(steps.map((step) => step.uses?.split("@")[0] ?? step.run)).toEqual([
      "pnpm/action-setup",
      "actions/setup-node",
      "pnpm install --frozen-lockfile",
    ]);
    expect(steps[1]?.with).toEqual({ "node-version-file": ".nvmrc", cache: "pnpm" });
  });

  it("uses the shared setup everywhere except the inline workflows and jobs", () => {
    const inline = jobs
      .filter(({ steps }) => steps.some((step) => usesAction(step, "pnpm/action-setup")))
      .map(({ file, id }) => (INLINE_WORKFLOWS.includes(file) ? file : `${file}#${id}`));
    expect([...new Set(inline)].sort()).toEqual([...INLINE_WORKFLOWS, ...INLINE_JOBS].sort());
  });

  it("checks out the repository before the shared setup and never in a trusted workflow", () => {
    for (const { file, id, steps } of jobs) {
      const setup = steps.findIndex((step) => step.uses === SETUP);
      if (setup === -1) continue;
      expect(INLINE_WORKFLOWS, `${file}#${id}`).not.toContain(file);
      const checkout = steps.findIndex((step) => usesAction(step, "actions/checkout"));
      expect(checkout, `${file}#${id}`).toBeGreaterThanOrEqual(0);
      expect(checkout, `${file}#${id}`).toBeLessThan(setup);
    }
    for (const [file, workflow] of Object.entries(workflows)) {
      const triggers =
        typeof workflow.on === "object" && workflow.on !== null ? Object.keys(workflow.on) : [];
      if (!triggers.includes("pull_request_target")) continue;
      const steps = Object.values(workflow.jobs).flatMap((job) => job.steps ?? []);
      expect(
        steps.some((step) => step.uses === SETUP),
        file,
      ).toBe(false);
    }
  });
});
