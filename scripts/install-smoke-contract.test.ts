import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = resolve(import.meta.dirname, "..");

type Step = { uses?: string; run?: string; with?: Record<string, unknown> };

const workflow = parse(
  readFileSync(resolve(root, ".github/workflows/install-smoke.yml"), "utf8"),
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
const script = readFileSync(resolve(root, "scripts/ci/install-smoke.sh"), "utf8");

describe("install smoke workflow", () => {
  it("runs on main, nightly and manually, and on pull requests only for the install path", () => {
    expect(workflow.on.push.branches).toEqual(["main"]);
    expect(workflow.on.schedule).toHaveLength(1);
    expect(workflow.on).toHaveProperty("workflow_dispatch");
    expect(workflow.on).not.toHaveProperty("pull_request_target");
    expect(workflow.on.pull_request.paths).toEqual([
      "packages/cli/**",
      "packages/core/src/services/**",
      "packages/core/src/build-artifacts/**",
      "apps/ops-agent/**",
      "services/**",
      "infra/docker/**",
      "apps/*/Dockerfile",
      "scripts/ci/install-smoke.sh",
      ".github/workflows/install-smoke.yml",
    ]);
  });

  it("holds read-only permissions and pinned actions", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    for (const job of Object.values(workflow.jobs)) {
      expect(job.permissions).toEqual({ contents: "read" });
      expect(job["timeout-minutes"]).toBeGreaterThan(0);
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
    expect(workflow.concurrency.group).toContain("github.run_id");
  });

  it("runs the checked-in script", () => {
    const steps = Object.values(workflow.jobs).flatMap((job) => job.steps);
    expect(steps.some((step) => step.run === "bash scripts/ci/install-smoke.sh")).toBe(true);
    expect(statSync(resolve(root, "scripts/ci/install-smoke.sh")).mode & 0o111).not.toBe(0);
  });
});

describe("install smoke script", () => {
  it("follows the documented commands in order", () => {
    const body = (name: string) =>
      script.match(new RegExp(`^${name}\\(\\) \\{\\n([\\s\\S]*?)^\\}`, "m"))?.[1];
    // Each fragment must occur after the previous one.
    const inOrder = (text: string | undefined, fragments: string[]) => {
      expect(text).toBeDefined();
      let from = 0;
      for (const fragment of fragments) {
        const at = (text as string).indexOf(fragment, from);
        expect(at, `${fragment} after offset ${from}`).toBeGreaterThanOrEqual(0);
        from = at + fragment.length;
      }
    };
    inOrder(body("render_stack"), [
      "openmapx services selected",
      "openmapx compose release --status",
      "openmapx compose render",
    ]);
    inOrder(body("start_infrastructure"), [
      "openmapx services start postgis redis traefik app-api data-manager",
      "openmapx services status",
      "assert_data_manager_status",
    ]);
    expect(body("assert_data_manager_status")).toContain("http://localhost:4000/status");
    expect(body("assert_check_clean")).toContain("openmapx check --no-probe");
    inOrder(body("case_install"), [
      "configure_environment",
      "render_stack",
      "start_infrastructure",
      "assert_check_clean",
      "openmapx compose up",
      "assert_stack_healthy",
      "assert_check_clean",
    ]);
  });

  it("builds the five application images and selects the local release", () => {
    expect(script).toContain(
      "built_services=(app-api app-web ops-agent data-manager transitous-runner)",
    );
    expect(script).toContain("set_env OPENMAPX_RELEASE local");
  });

  it("generates every secret at random and never prints the environment", () => {
    for (const key of [
      "POSTGRES_PASSWORD",
      "BETTER_AUTH_SECRET",
      "OPENMAPX_SECRETS_KEY",
      "DATA_MANAGER_AUTH_TOKEN",
      "OPENMAPX_LOCAL_ADMIN_TOKEN",
    ])
      expect(script).toContain(`set_env ${key} "$(random_secret)"`);
    expect(script).toContain("openssl rand -hex 32");
    expect(script).not.toMatch(
      /\bcat\b[^\n]*\.env|docker inspect[^\n]*\.Config\.Env|docker compose[^\n]* config\b/,
    );
  });

  it("refuses to run beside an existing deployment", () => {
    expect(script).toContain("already exists; this check only runs on a fresh checkout");
    expect(script).toContain("already has containers");
    expect(script).toContain("already has volumes");
  });
});
