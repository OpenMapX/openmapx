import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  resolve(import.meta.dirname, "../.github/workflows/docs.yml"),
  "utf8",
);
const sha = "a".repeat(40);
const digest = `sha256:${"b".repeat(64)}`;

describe("independent docs publication", () => {
  it.each(["ok", "pull-failure", "missing-digest", "compose-pull-failure"])(
    "deploy instructions pin one digest and stop on %s",
    (scenario) => {
      const readme = readFileSync(resolve(import.meta.dirname, "../docs/README.md"), "utf8");
      const script = readme.split("```bash\n")[2]?.split("```")[0];
      if (!script) throw new Error("Missing deployment instructions");
      const temp = mkdtempSync(join(tmpdir(), "openmapx-docs-deploy-"));
      try {
        writeFileSync(
          join(temp, "docker"),
          `#!/bin/sh
printf '%s | %s\\n' "$*" "$OPENMAPX_DOCS_IMAGE" >> "$CALLS"
case "$*" in
  'pull '*) [ "$SCENARIO" != pull-failure ];;
  'image inspect '*) cat "$INSPECT";;
  *' pull') [ "$SCENARIO" != compose-pull-failure ];;
esac
`,
        );
        chmodSync(join(temp, "docker"), 0o755);
        writeFileSync(
          join(temp, "inspect"),
          JSON.stringify([
            {
              RepoDigests:
                scenario === "missing-digest"
                  ? []
                  : [`example.org/docs@${digest}`, `ghcr.io/openmapx/docs@${digest}`],
            },
          ]),
        );
        const result = spawnSync("bash", ["-c", script], {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${temp}:${process.env.PATH}`,
            CALLS: join(temp, "calls"),
            INSPECT: join(temp, "inspect"),
            SCENARIO: scenario,
          },
        });
        expect(result.status).toBe(scenario === "ok" ? 0 : 1);
        const calls = readFileSync(join(temp, "calls"), "utf8");
        if (scenario === "ok") expect(calls).toContain(`up -d | ghcr.io/openmapx/docs@${digest}`);
        else expect(calls).not.toContain("up -d");
      } finally {
        rmSync(temp, { recursive: true, force: true });
      }
    },
  );
  it("runs on its own source changes and weekly refresh, without an application CI dependency", () => {
    expect(workflow).toContain('"docs/**"');
    expect(workflow).toContain("schedule:");
    expect(workflow).not.toContain("pull_request:");
    expect(workflow).toContain("branches: [main]");
    expect(workflow).not.toMatch(/workflow_run:|workflow_call:|needs:/);
    expect(workflow).not.toContain("release-manifest");
    expect(workflow).toContain("context: docs");
    expect(workflow).toContain("push-by-digest=true");
    expect(workflow).toContain("no-cache: ${{ github.event_name == 'schedule'");
  });
  it("gates main publication on two exact-digest scans and never publishes PR images", () => {
    const build = workflow.indexOf("- name: Build docs candidate");
    const audit = workflow.indexOf("- name: Audit docs candidate");
    const gate = workflow.indexOf("- name: Gate docs candidate");
    const publish = workflow.indexOf("- name: Publish and verify docs aliases");
    expect(build).toBeGreaterThan(0);
    expect(audit).toBeGreaterThan(build);
    expect(gate).toBeGreaterThan(audit);
    expect(publish).toBeGreaterThan(gate);
    for (const start of [audit, gate, publish]) {
      const end = workflow.indexOf("      - name:", start + 10);
      const step = workflow.slice(start, end < 0 ? undefined : end);
      expect(step).not.toMatch(/^ {8}if:/m);
      expect(step).not.toContain("continue-on-error:");
    }
    expect(workflow).toContain('exit-code: "1"');
    expect(workflow).toContain('ignore-unfixed: "true"');
    expect(workflow.match(/version: v0\.76\.1/g)).toHaveLength(2);
  });
  it.each(["ok", "type-error", "build-error"])(
    "fails the shared Docker recipe on %s",
    (scenario) => {
      const dockerfile = readFileSync(resolve(import.meta.dirname, "../docs/Dockerfile"), "utf8");
      const commands = dockerfile
        .replace(/\\\n/g, " ")
        .split("\n")
        .filter((line) => /^RUN /.test(line) && /\bpnpm (typecheck|build)\b/.test(line))
        .map((line) => line.slice(4));
      const temp = mkdtempSync(join(tmpdir(), "openmapx-docs-validator-"));
      try {
        writeFileSync(
          join(temp, "pnpm"),
          `#!/bin/sh
printf '%s\\n' "$*" >> "$CALLS"
case "$SCENARIO:$1" in
  type-error:typecheck) exit 31;;
  build-error:build) exit 37;;
esac
`,
        );
        chmodSync(join(temp, "pnpm"), 0o755);
        let status: number | null = 0;
        for (const command of commands) {
          const result = spawnSync("sh", ["-c", command], {
            cwd: temp,
            encoding: "utf8",
            env: {
              ...process.env,
              PATH: `${temp}:${process.env.PATH}`,
              CALLS: join(temp, "calls"),
              SCENARIO: scenario,
            },
          });
          status = result.status;
          if (status !== 0) break;
        }
        expect(status).toBe(scenario === "ok" ? 0 : scenario === "type-error" ? 31 : 37);
        expect(readFileSync(join(temp, "calls"), "utf8").trim().split("\n")).toEqual(
          scenario === "type-error" ? ["typecheck"] : ["typecheck", "build"],
        );
      } finally {
        rmSync(temp, { recursive: true, force: true });
      }
    },
  );

  it("keeps one secret-free PR docs build in the required CI matrix", () => {
    const ci = readFileSync(resolve(import.meta.dirname, "../.github/workflows/ci.yml"), "utf8");
    const dockerJob = ci.split("  docker-build:\n")[1].split("  # Aggregate gate.")[0];
    expect(ci.split("concurrency:")[0]).toMatch(/pull_request:\n/);
    expect(ci.split("concurrency:")[0]).not.toContain("paths:");
    expect(dockerJob).toContain("context=docs");
    expect(dockerJob).toContain("dockerfile=docs/Dockerfile");
    expect(dockerJob).toContain("contents: read");
    expect(dockerJob).not.toMatch(/packages: write|login-action|secrets:/);
    expect(dockerJob).toContain("push: false");
    expect(dockerJob).toContain("pull: $" + "{{ matrix.app == 'docs' }}");
    expect(ci).toContain("needs.docker-build.result != 'success'");
    expect(workflow).not.toContain("pnpm -C docs typecheck");
  });

  it.each<[string, string | undefined, boolean]>([
    ['["docs"]', "success", false],
    ['["docs"]', "failure", true],
    ['["docs"]', "cancelled", true],
    ['["docs"]', "skipped", true],
    ['["docs"]', undefined, true],
    ["", "skipped", true],
    ["[]", "skipped", false],
  ])("requires applicable docs result apps=%s result=%s", (apps, result, shouldFail) => {
    const ci = readFileSync(resolve(import.meta.dirname, "../.github/workflows/ci.yml"), "utf8");
    const condition =
      ci
        .split("  ci:\n")[1]
        .split("  release:\n")[0]
        .match(/if: >-\n([\s\S]*?)\n {8}run:/)?.[1] ?? "";
    expect(condition).not.toBe("");
    const needs = Object.fromEntries(
      [
        "lint",
        "types",
        "test-node",
        "test-linux-user",
        "test-agent-mounts",
        "test-web",
        "mobile",
        "database",
        "build",
      ].map((job) => [job, { result: "success" }]),
    );
    expect(
      runInNewContext(
        condition.replace(/needs\.([\w-]+)/g, 'needs["$1"]'),
        {
          needs: {
            ...needs,
            "docker-changes": { result: "success", outputs: { apps } },
            "docker-build": { result },
          },
          github: { event_name: "pull_request" },
        },
        { timeout: 1000 },
      ),
    ).toBe(shouldFail);
  });

  async function selectSource(eventName: string, ref: string) {
    const source = workflow.match(/ {10}script: \|\n((?: {12}.*\n|\n)*)/)?.[1];
    if (!source) throw new Error("Missing trusted docs source selection");
    const script = source
      .split("\n")
      .map((line) => line.slice(12))
      .join("\n");
    const outputs: Record<string, string> = {};
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
    await new AsyncFunction("context", "github", "core", "process", script)(
      { eventName, ref, sha, runId: 123, repo: { owner: "OpenMapX", repo: "openmapx" } },
      {
        rest: {
          git: {
            getRef: async (request: unknown) => {
              expect(request).toEqual({ owner: "OpenMapX", repo: "openmapx", ref: "heads/main" });
              return { data: { object: { sha: "c".repeat(40) } } };
            },
          },
        },
      },
      {
        setOutput: (name: string, value: string) => {
          outputs[name] = value;
        },
      },
      { env: { GITHUB_RUN_ATTEMPT: "2" } },
    );
    return outputs;
  }

  it.each(["push", "schedule", "workflow_dispatch"])(
    "selects current trusted main for %s",
    async (event) => {
      expect(await selectSource(event, "refs/heads/main")).toEqual({
        sha: "c".repeat(40),
        release: `${"c".repeat(40)}-123-2`,
      });
    },
  );

  it.each([
    ["pull_request", "refs/pull/1/merge"],
    ["pull_request_target", "refs/heads/main"],
    ["workflow_dispatch", "refs/heads/feature"],
    ["push", "refs/tags/v0.1.0-alpha.1"],
    ["repository_dispatch", "refs/heads/main"],
  ])("rejects publication source event=%s ref=%s", async (event, ref) => {
    await expect(selectSource(event, ref)).rejects.toThrow(
      "Docs publication requires trusted main",
    );
  });

  it.each([false, true])(
    "publishes only the approved digest and rejects mismatches=%s",
    (mismatch) => {
      const start = workflow.indexOf("      - name: Publish and verify docs aliases");
      const run = workflow.slice(start).match(/ {8}run: \|\n((?: {10}.*\n|\n)*)/)?.[1];
      if (!run) throw new Error("Missing docs publication script");
      const script = run
        .split("\n")
        .map((line) => line.slice(10))
        .join("\n");
      const temp = mkdtempSync(join(tmpdir(), "openmapx-docs-publish-"));
      try {
        const docker = join(temp, "docker");
        writeFileSync(
          docker,
          `#!/bin/sh\nprintf '%s\\n' "$*" >> "$CALLS"\ncase "$*" in *inspect*) echo "$EXPECTED";; esac\n`,
        );
        chmodSync(docker, 0o755);
        const result = spawnSync("bash", ["-euo", "pipefail", "-c", script], {
          cwd: temp,
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${temp}:${process.env.PATH}`,
            CALLS: join(temp, "calls"),
            EXPECTED: mismatch ? `sha256:${"c".repeat(64)}` : digest,
            IMAGE: "ghcr.io/openmapx/docs",
            RELEASE_SHA: sha,
            RELEASE_ID: `${sha}-1-1`,
            DIGEST: digest,
            GITHUB_STEP_SUMMARY: join(temp, "summary"),
          },
        });
        expect(result.status).toBe(mismatch ? 1 : 0);
        const calls = readFileSync(join(temp, "calls"), "utf8");
        expect(calls).toContain(`ghcr.io/openmapx/docs@${digest}`);
        expect(calls).toContain(`--tag ghcr.io/openmapx/docs:${sha}-1-1`);
        if (mismatch) expect(calls).not.toContain("--tag ghcr.io/openmapx/docs:latest");
        else expect(calls).toContain("--tag ghcr.io/openmapx/docs:latest");
      } finally {
        rmSync(temp, { recursive: true, force: true });
      }
    },
  );
});
