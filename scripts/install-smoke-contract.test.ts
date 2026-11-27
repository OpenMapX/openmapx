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
import { runInNewContext } from "node:vm";
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

  it("runs the checked-in script", () => {
    const steps = Object.values(workflow.jobs).flatMap((job) => job.steps);
    expect(steps.some((step) => step.run === "bash scripts/ci/install-smoke.sh")).toBe(true);
    expect(statSync(resolve(root, "scripts/ci/install-smoke.sh")).mode & 0o111).not.toBe(0);
  });
});

describe.each(["install-smoke", "update-smoke"])("%s concurrency", (name) => {
  const { concurrency } = parse(
    readFileSync(resolve(root, `.github/workflows/${name}.yml`), "utf8"),
  ) as { concurrency: { group: string; "cancel-in-progress": string } };
  const run = (event_name: string, run_id: number, extra: Record<string, unknown> = {}) => ({
    github: {
      workflow: name,
      ref: "refs/heads/main",
      run_id,
      run_attempt: 1,
      event_name,
      event: {},
      ...extra,
    },
    format: (pattern: string, ...values: unknown[]) =>
      pattern.replace(/\{(\d+)\}/g, (_, n) => String(values[Number(n)])),
  });
  const evaluate = (value: string, context: unknown) =>
    value.replace(/\$\{\{(.*?)\}\}/g, (_, expression) =>
      String(runInNewContext(expression, context as object)),
    );
  const group = (context: unknown) => evaluate(concurrency.group, context);

  it("cancels only superseded pull-request runs", () => {
    expect(concurrency["cancel-in-progress"]).toBe(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not a JS template
      "${{ github.event_name == 'pull_request' }}",
    );
    const pr = (run_id: number, number: number) =>
      run("pull_request", run_id, {
        ref: `refs/pull/${number}/merge`,
        event: { pull_request: { number } },
      });
    expect(group(pr(1, 7))).toBe(group(pr(2, 7)));
    expect(group(pr(1, 7))).not.toBe(group(pr(2, 8)));
  });

  it("lets a newer main push replace only the pending main run", () => {
    expect(group(run("push", 1))).toBe(group(run("push", 2)));
    expect(group(run("push", 1))).not.toBe(group(run("push", 2, { run_attempt: 2 })));
  });

  it("keeps nightly and manual runs out of the shared main group", () => {
    const main = group(run("push", 1));
    for (const event of ["schedule", "workflow_dispatch"]) {
      expect(group(run(event, 2))).not.toBe(main);
      expect(group(run(event, 2))).not.toBe(group(run(event, 3)));
    }
  });
});

describe("install smoke script", () => {
  it("generates every secret at random and never prints the environment", () => {
    for (const key of ["POSTGRES_PASSWORD", "BETTER_AUTH_SECRET"])
      expect(script).toContain(`set_env_secret ${key}\n`);
    // Render generates the data-manager tokens, database role passwords and
    // the API's secrets key file.
    expect(script).not.toContain("DATA_MANAGER_AUTH_TOKEN");
    expect(script).not.toContain("OPENMAPX_SECRETS_KEY");
    expect(script).toContain("openssl rand -hex 32");
    expect(script).not.toMatch(
      /\bcat\b[^\n]*\.env|docker inspect[^\n]*\.Config\.Env|docker compose[^\n]* config\b/,
    );
  });

  it("checks in the api container that tini is PID 1 and accepts only the whole passing verdict", () => {
    const check = readFileSync(resolve(root, "scripts/smoke/installed-code-loading.mjs"), "utf8");
    expect(check).toContain('readFileSync("/proc/1/comm", "utf8")');
    expect(check).toMatch(/if \(init !== "tini"\)/);
    expect(check).toContain('reason: "pid 1 is not tini"');
    const assertion = script.slice(
      script.indexOf("assert_installed_code_loading() {"),
      script.indexOf("start_infrastructure() {"),
    );
    expect(assertion).toContain("< scripts/smoke/installed-code-loading.mjs | tail -n 1");
    expect(assertion).toContain(`[[ "$verdict" == '{"ok":true}' ]]`);
    expect(script).toMatch(/\n {2}assert_installed_code_loading\n/);
  });

  it("checks in the api container that the API can write its runtime directory", () => {
    const assertion = script.slice(
      script.indexOf("assert_installed_code_loading() {"),
      script.indexOf("start_infrastructure() {"),
    );
    expect(assertion).toContain(
      `docker exec "$api_container" sh -c 'test -w /var/lib/openmapx/runtime && test -s /var/lib/openmapx/runtime/boot-marker.json' ||\n    fail "the api cannot write its runtime directory"`,
    );
  });
});

/** Runs `body` in a shell that has sourced the install smoke script. */
function sourced(body: string, env: Record<string, string> = {}) {
  return spawnSync(
    "bash",
    ["-c", `source "$1"; ${body}`, "bash", resolve(root, "scripts/ci/install-smoke.sh")],
    { cwd: root, encoding: "utf8", env: { ...process.env, ...env } },
  );
}

describe("shared smoke helpers", () => {
  it("keeps one definition of the administrator session", () => {
    const update = readFileSync(resolve(root, "scripts/ci/update-smoke.sh"), "utf8");
    expect(script).toContain("create_admin_session() {");
    expect(update).not.toContain("create_admin_session() {");
    expect(update).not.toMatch(/^admin_email=/m);
  });
  it("waits until a job has succeeded and fails on a failed one", () => {
    const ok = sourced(
      `admin_api() { echo '{"id":"j1","type":"extension.install","status":"succeeded"}'; }; wait_for_job j1 5`,
    );
    expect(ok.status).toBe(0);
    const bad = sourced(
      `admin_api() { echo '{"id":"j1","type":"extension.install","status":"failed"}'; }; wait_for_job j1 5`,
    );
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toContain("job j1 (extension.install): failed");
  });
  it("gives up after the timeout", () => {
    const stuck = sourced(
      `admin_api() { echo '{"id":"j1","type":"extension.install","status":"running"}'; }; wait_for_job j1 1`,
    );
    expect(stuck.status).not.toBe(0);
    expect(stuck.stderr).toContain("job j1 (extension.install): running");
  });
  it("installs with the caller's options and waits for the queued job", () => {
    const run = sourced(
      `admin_cli() { echo "args: $*"; echo "Install queued (job j9). Track it under Admin → Activity."; }; wait_for_job() { echo "waited $1"; }; install_extension https://example.org/extension.json --confirmation abc`,
    );
    expect(run.stdout).toContain(
      "args: ext install https://example.org/extension.json --confirmation abc",
    );
    expect(run.stdout).toContain("waited j9");
    const silent = sourced(`admin_cli() { echo "nothing"; }; install_extension demo`);
    expect(silent.stderr).toContain("ext install printed no job id");
  });
  it("reads the confirmation fingerprint from the preview", () => {
    const run = sourced(
      `admin_cli() { printf '{\\n  "confirmation": "%s"\\n}\\n' "${"a".repeat(64)}"; }; extension_confirmation demo`,
    );
    expect(run.stdout.trim()).toBe("a".repeat(64));
    const line = sourced(
      `admin_cli() { echo "Grants: none"; echo "Confirmation: ${"b".repeat(64)}"; }; extension_confirmation demo`,
    );
    expect(line.stdout.trim()).toBe("b".repeat(64));
    const none = sourced(`admin_cli() { echo "nothing"; }; extension_confirmation demo`);
    expect(none.stderr).toContain("ext preview printed no confirmation");
  });
  it("appends the session and the origin to every CLI call", () => {
    const run = sourced(`openmapx() { echo "$*"; }; cookie_file=/tmp/c; admin_cli ext list`);
    expect(run.stdout.trim()).toBe("ext list --session-file /tmp/c --api-origin https://localhost");
  });
});

describe("shared smoke helpers against a stub curl", () => {
  const password = "0123456789abcdef0123456789abcdef0123456789abcdef";
  const cookie = "stubSessionCookieValue.signature";
  const scratch: string[] = [];
  afterEach(() => {
    for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /**
   * A curl that logs each argument, the contents of a `--header @file`, its
   * stdin when it sends a body, and the end of the call; writes a session
   * cookie into a `--cookie-jar`; and answers with $STUB_HTTP and $STUB_BODY
   * as curl does with `--fail-with-body` and `--write-out '%{stderr}%{http_code}'`.
   */
  function stubCurl() {
    const dir = mkdtempSync(join(tmpdir(), "smoke-helpers-test-"));
    scratch.push(dir);
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const log = join(dir, "curl.log");
    writeFileSync(
      join(bin, "curl"),
      `#!/bin/bash
prev=""; data=0; writeout=0
for a in "$@"; do
  printf 'arg: %s\\n' "$a" >>"${log}"
  if [[ "$prev" == --header && "$a" == @* ]]; then
    printf 'header-file: %s\\n' "$(cat "\${a#@}")" >>"${log}"
  fi
  if [[ "$prev" == --cookie-jar ]]; then
    printf '#HttpOnly_localhost\\tFALSE\\t/\\tTRUE\\t0\\tbetter-auth.session_token\\t%s\\n' "${cookie}" >"$a"
  fi
  [[ "$a" == --data-binary || "$a" == --data ]] && data=1
  [[ "$a" == --write-out ]] && writeout=1
  prev="$a"
done
if ((data)); then printf 'stdin: %s\\n' "$(cat)" >>"${log}"; fi
echo "end" >>"${log}"
printf '%s' "$STUB_BODY"
if [[ "$STUB_HTTP" == 000 ]]; then
  echo "curl: (7) Failed to connect to localhost port 443" >&2
  if ((writeout)); then printf 000 >&2; fi
  exit 7
fi
if ((STUB_HTTP >= 400)); then
  echo "curl: (22) The requested URL returned error: $STUB_HTTP" >&2
  if ((writeout)); then printf '%s' "$STUB_HTTP" >&2; fi
  exit 22
fi
if ((writeout)); then printf '%s' "$STUB_HTTP" >&2; fi
exit 0
`,
      { mode: 0o755 },
    );
    writeFileSync(join(bin, "openssl"), `#!/bin/sh\necho ${password}\n`, { mode: 0o755 });
    writeFileSync(join(dir, "session-cookie"), `better-auth.session_token=${cookie}\n`, {
      mode: 0o600,
    });
    const run = (body: string, answer: { http?: string; body?: string } = {}) =>
      sourced(`cookie_file="${join(dir, "session-cookie")}"; work="${dir}"; ${body}`, {
        PATH: `${bin}:${process.env.PATH}`,
        STUB_HTTP: answer.http ?? "200",
        STUB_BODY: answer.body ?? "{}",
      });
    /** The calls curl received, each as its log lines. */
    const calls = () =>
      readFileSync(log, "utf8")
        .split("end\n")
        .filter(Boolean)
        .map((call) => call.split("\n").filter(Boolean));
    return { dir, run, calls };
  }

  it("declares JSON only with a body and passes the cookie by file", () => {
    const { run, calls } = stubCurl();
    const result = run(`admin_api GET /api/admin/thing; admin_api POST /api/admin/thing '{"a":1}'`);
    expect(result.status, result.stderr).toBe(0);
    const received = calls();
    expect(received).toHaveLength(2);
    const [get = [], post = []] = received;
    expect(get).toContain("arg: https://localhost/api/admin/thing");
    expect(get.some((line) => /content-type/i.test(line))).toBe(false);
    expect(get.some((line) => line.startsWith("stdin:"))).toBe(false);
    expect(post).toContain("arg: content-type: application/json");
    expect(post).toContain('stdin: {"a":1}');
    for (const call of [get, post]) {
      expect(call).toContain(`header-file: cookie: better-auth.session_token=${cookie}`);
      expect(call.filter((line) => line.startsWith("arg:")).join("\n")).not.toContain(cookie);
    }
  });

  it("creates the session without showing the password or the cookie, also under a trace", () => {
    const { dir, run, calls } = stubCurl();
    const result = run(`openmapx() { :; }; set -x; create_admin_session`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("+ read -r admin_password");
    for (const output of [result.stdout, result.stderr]) {
      expect(output).not.toContain(password);
      expect(output).not.toContain(cookie);
    }
    const received = calls();
    expect(received).toHaveLength(2);
    const [signUp = [], signIn = []] = received;
    expect(signUp).toContain("arg: https://localhost/api/auth/sign-up/email");
    expect(signIn).toContain("arg: https://localhost/api/auth/sign-in/email");
    expect(signIn).toContain(
      `stdin: {"email":"update-smoke@openmapx.org","password":"${password}"}`,
    );
    for (const call of [signUp, signIn])
      expect(call.filter((line) => line.startsWith("arg:")).join("\n")).not.toContain(password);
    const session = join(dir, "session-cookie");
    expect(readFileSync(session, "utf8")).toBe(`better-auth.session_token=${cookie}\n`);
    expect(statSync(session).mode & 0o777).toBe(0o600);
  });

  it("polls the application job and names its error when it failed", () => {
    const { run, calls } = stubCurl();
    const result = run(`wait_for_job j1 5`, {
      body: '{"id":"j1","type":"extension.install","status":"failed","error":"boom\\nagain"}',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("job j1 (extension.install): failed (error: boom again)");
    expect(calls()[0]).toContain("arg: https://localhost/api/admin/jobs/j1?source=application");
  });

  it.each([
    [
      "an error status",
      { http: "404", body: '{"message":"secret-body-text"}' },
      "job j1 (unknown): unanswered (last poll: HTTP 404, no job status in the answer)",
    ],
    [
      "an answer that is not a job",
      { http: "200", body: "<html>secret-body-text</html>" },
      "job j1 (unknown): unanswered (last poll: HTTP 200, no job status in the answer)",
    ],
    [
      "no answer",
      { http: "000", body: "" },
      "job j1 (unknown): unanswered (last poll: no HTTP answer (curl exit 7))",
    ],
    [
      "a job still running",
      { http: "200", body: '{"id":"j1","type":"extension.install","status":"running"}' },
      "job j1 (extension.install): running (last poll: HTTP 200, job status running)",
    ],
  ])("names what the last poll got at the timeout: %s", (_name, answer, message) => {
    const { run } = stubCurl();
    const result = run(`wait_for_job j1 1`, answer);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(message);
    expect(result.stdout + result.stderr).not.toContain("secret-body-text");
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
    ["volumes", { volumes: "openmapx_openmapx-pgdata" }, "already has volumes"],
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
  function agentMountCheck(
    containers: string,
    mounts: (root: string) => string[],
    inspectExit = 0,
  ) {
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
  inspect) cat "${join(dir, "mounts")}"; exit ${inspectExit} ;;
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

  it("fails when docker inspect fails, rather than reading no mounts", () => {
    const result = agentMountCheck("agent1\n", () => [], 1);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("docker inspect could not read the mounts");
  });

  it("fails when no ops-agent container is running", () => {
    const result = agentMountCheck("", () => []);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no ops-agent container is running");
  });

  /** Runs assert_no_legacy_warnings from the sourced script on `name`.log holding `output`. */
  function legacyWarningCheck(name: string, output: string | null) {
    const dir = tree();
    const work = join(dir, "work");
    mkdirSync(work);
    if (output !== null) writeFileSync(join(work, `${name}.log`), output);
    return spawnSync(
      "bash",
      [
        "-c",
        'source "$1"; work="$2"; assert_no_legacy_warnings "$3"',
        "bash",
        join(dir, "scripts/ci/install-smoke.sh"),
        work,
        name,
      ],
      { cwd: dir, encoding: "utf8" },
    );
  }

  it("passes a render that prints no message about an older installation", () => {
    const result = legacyWarningCheck(
      "render",
      "Rendered 9 services into infra/docker/state/ops-agent/configurations/cfg1_x\n",
    );
    expect(result.status, result.stderr).toBe(0);
  });

  it.each([
    [
      "render",
      "The operations agent keeps the whole checkout mounted. It moves to its narrow mounts in a render on the host once nothing it needs is missing.",
    ],
    [
      "render",
      "The routes could not be written to services/traefik/config/dynamic, where a Traefik started by an Earlier Release still reads them: EACCES.",
    ],
    [
      "render",
      "The Transitous API keys have not been copied out of the checkout (infra/docker/secrets/transitous-api-keys/api-keys.json is missing): render again.",
    ],
    [
      "render",
      "services/martin/config/martin.yaml can't be read for the one-time import of your service file edits: it is a symbolic link. Render now uses the release's files, so an edit there would be lost: replace it with a regular file of yours holding your version, or delete it if the release's version will do (git restore services/martin/config/martin.yaml), and render again.",
    ],
    [
      "render",
      "Docker could not say whether a container still mounts services/traefik/config/dynamic; the routes were written there too.",
    ],
    [
      "check",
      "Traefik still reads its routes from services/traefik/config/dynamic, where render keeps writing them until no container mounts that directory.",
    ],
  ])("fails and shows the line when the %s output holds one", (name, message) => {
    const result = legacyWarningCheck(name, `Rendered\n⚠ ${message}\nDone\n`);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
    expect(result.stderr).not.toContain("Done");
    expect(result.stderr).toContain(
      `${name} printed a message about converting an older installation`,
    );
  });

  it("fails when the output it should read is missing", () => {
    const result = legacyWarningCheck("check", null);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("check.log is missing");
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
