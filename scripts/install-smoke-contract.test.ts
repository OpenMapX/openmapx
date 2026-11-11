import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
      "assert_agent_without_checkout",
      "assert_check_clean",
    ]);
    inOrder(body("assert_agent_without_checkout"), [
      "label=com.docker.compose.service=ops-agent",
      "docker inspect --format '{{range .Mounts}}{{.Source}}",
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
      expect(script).toContain(`set_env_secret ${key}\n`);
    expect(script).toContain("openssl rand -hex 32");
    expect(script).not.toMatch(
      /\bcat\b[^\n]*\.env|docker inspect[^\n]*\.Config\.Env|docker compose[^\n]* config\b/,
    );
  });
});

describe("install smoke script behaviour", () => {
  const scratch: string[] = [];
  afterEach(() => {
    for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function tree(): string {
    const dir = mkdtempSync(join(tmpdir(), "install-smoke-test-"));
    scratch.push(dir);
    mkdirSync(join(dir, "scripts/ci"), { recursive: true });
    mkdirSync(join(dir, "infra/docker"), { recursive: true });
    copyFileSync(
      resolve(root, "scripts/ci/install-smoke.sh"),
      join(dir, "scripts/ci/install-smoke.sh"),
    );
    copyFileSync(
      resolve(root, "infra/docker/.env.example"),
      join(dir, "infra/docker/.env.example"),
    );
    return dir;
  }

  /** Stubs for the tools the script needs; docker records every call and answers as configured. */
  function stubs(dir: string, answers: { containers?: string; volumes?: string }): string {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const log = join(dir, "docker-calls.log");
    writeFileSync(
      join(bin, "docker"),
      `#!/bin/sh
echo "$*" >> "${log}"
case "$1 $2" in
  "ps --all") printf '%s' "${answers.containers ?? ""}" ;;
  "volume ls") printf '%s' "${answers.volumes ?? ""}" ;;
esac
exit 0
`,
      { mode: 0o755 },
    );
    for (const tool of ["node", "openssl", "pnpm", "curl", "awk"])
      writeFileSync(join(bin, tool), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    return bin;
  }

  function runScript(dir: string, bin: string) {
    return spawnSync("bash", [join(dir, "scripts/ci/install-smoke.sh")], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, INSTALL_SMOKE_SKIP_BUILD: "1" },
    });
  }

  const dockerCalls = (dir: string) =>
    existsSync(join(dir, "docker-calls.log"))
      ? readFileSync(join(dir, "docker-calls.log"), "utf8").trim().split("\n")
      : [];

  it("refuses beside an existing .env and removes nothing", () => {
    const dir = tree();
    const bin = stubs(dir, {});
    writeFileSync(join(dir, "infra/docker/.env"), "POSTGRES_PASSWORD=keep-me\n");
    mkdirSync(join(dir, "infra/docker/data"));
    writeFileSync(join(dir, "infra/docker/data/file"), "data");

    const result = runScript(dir, bin);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("already exists; this check only runs on a fresh checkout");
    expect(readFileSync(join(dir, "infra/docker/.env"), "utf8")).toBe(
      "POSTGRES_PASSWORD=keep-me\n",
    );
    expect(existsSync(join(dir, "infra/docker/data/file"))).toBe(true);
    expect(dockerCalls(dir).filter((call) => /^(rm|network rm|volume rm)\b/.test(call))).toEqual(
      [],
    );
  });

  it.each([
    ["containers", { containers: "abc123" }, "already has containers"],
    ["volumes", { volumes: "docker_openmapx-pgdata" }, "already has volumes"],
  ])("refuses when the project already has %s and removes nothing", (_name, answers, message) => {
    const dir = tree();
    const bin = stubs(dir, answers);
    mkdirSync(join(dir, "infra/docker/state"));
    writeFileSync(join(dir, "infra/docker/state/record"), "state");

    const result = runScript(dir, bin);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
    expect(existsSync(join(dir, "infra/docker/state/record"))).toBe(true);
    expect(dockerCalls(dir).filter((call) => /^(rm|network rm|volume rm)\b/.test(call))).toEqual(
      [],
    );
    expect(result.stderr).not.toContain("container states");
  });

  /** Runs set_env_secret from the sourced script against a copy of the env template. */
  function writeSecret(githubActions: boolean) {
    const dir = tree();
    const envFile = join(dir, "infra/docker/.env");
    copyFileSync(join(dir, "infra/docker/.env.example"), envFile);
    const result = spawnSync(
      "bash",
      [
        "-c",
        'source "$1"; env_file="$2"; set_env_secret POSTGRES_PASSWORD',
        "bash",
        join(dir, "scripts/ci/install-smoke.sh"),
        envFile,
      ],
      {
        cwd: dir,
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_ACTIONS: githubActions ? "1" : "",
        },
      },
    );
    return {
      result,
      env: readFileSync(envFile, "utf8"),
      template: readFileSync(join(dir, "infra/docker/.env.example"), "utf8"),
    };
  }

  /**
   * Runs assert_agent_without_checkout from the sourced script, whose
   * checkout is the temporary tree, against a docker that lists `containers`
   * and answers each inspect with the mounts `mounts` gives for that tree.
   */
  function agentMountCheck(containers: string, mounts: (root: string) => string[]) {
    const dir = tree();
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(dir, "mounts"),
      mounts(dir)
        .map((mount) => `${mount}\n`)
        .join(""),
    );
    writeFileSync(
      join(bin, "docker"),
      `#!/bin/sh
case "$1" in
  ps) printf '%s' "${containers}" ;;
  inspect) cat "${join(dir, "mounts")}" ;;
esac
`,
      { mode: 0o755 },
    );
    return spawnSync(
      "bash",
      [
        "-c",
        'source "$1"; assert_agent_without_checkout',
        "bash",
        join(dir, "scripts/ci/install-smoke.sh"),
      ],
      { cwd: dir, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } },
    );
  }

  it("passes when the ops-agent mounts only directories below the checkout", () => {
    const result = agentMountCheck("agent1\n", (root) => [
      "/var/run/docker.sock\t/var/run/docker.sock",
      `${root}/infra/docker\t${root}/infra/docker`,
      `${root}/infra/docker/state\t${root}/infra/docker/state`,
    ]);
    expect(result.status, result.stderr).toBe(0);
  });

  it.each([
    ["source", (root: string) => `${root}\t/srv/elsewhere`],
    ["destination", (root: string) => `/srv/elsewhere\t${root}`],
    ["resolved source", (root: string) => `${realpathSync(root)}\t/srv/elsewhere`],
  ])("fails when an ops-agent mount's %s is the checkout", (_name, mount) => {
    const result = agentMountCheck("agent1\n", (root) => [
      "/var/run/docker.sock\t/var/run/docker.sock",
      mount(root),
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("the ops-agent container mounts the checkout");
  });

  it("fails when no ops-agent container is running", () => {
    const result = agentMountCheck("", () => []);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no ops-agent container is running");
  });

  it("writes a clean 64-hex secret and masks it on stdout under GitHub Actions", () => {
    const { result, env, template } = writeSecret(true);

    expect(result.status, result.stderr).toBe(0);
    const value = env.match(/^POSTGRES_PASSWORD=(.*)$/m)?.[1];
    expect(value).toMatch(/^[0-9a-f]{64}$/);
    expect(env).not.toContain("add-mask");
    expect(env.split("\n").length).toBe(template.split("\n").length);
    expect(result.stdout.trim()).toBe(`::add-mask::${value}`);
  });

  it("prints no mask command outside GitHub Actions", () => {
    const { result, env } = writeSecret(false);

    expect(result.status, result.stderr).toBe(0);
    expect(env.match(/^POSTGRES_PASSWORD=(.*)$/m)?.[1]).toMatch(/^[0-9a-f]{64}$/);
    expect(result.stdout).toBe("");
  });
});
