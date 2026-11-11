import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { codeReceipt } from "./ci-code-evidence.mjs";

const launcher = resolve(import.meta.dirname, "ci-impact-plan.mjs");

function fixture(approvedScopes = ["docs", "web", "mobile"]) {
  const root = mkdtempSync(join(tmpdir(), "openmapx-ci-impact-"));
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "user.name=CI fixture",
        "-c",
        "user.email=ci@example.invalid",
        ...args,
      ],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  const write = (path: string, contents: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  };
  const commit = () => {
    git("add", ".");
    git("commit", "--quiet", "-m", "test: fixture");
    return git("rev-parse", "HEAD");
  };
  git("init", "--quiet");
  write("README.md", "fixture");
  write("scripts/ci-impact-rollout.json", JSON.stringify({ version: 1, approvedScopes }));
  write(".gitignore", "event.json\noutput.txt\nbin/\nprovider.json\n");
  write(
    "bin/gh",
    `#!${process.execPath}\nconst fs=require('node:fs');try{const data=JSON.parse(fs.readFileSync(${JSON.stringify(join(root, "provider.json"))},'utf8'));const path=process.argv.at(-1).split('?')[0];if(!data[path])process.exit(1);process.stdout.write(JSON.stringify(process.argv.includes('--slurp')?[data[path]]:data[path]));}catch{process.exit(1)}`,
  );
  chmodSync(join(root, "bin/gh"), 0o755);
  const base = commit();
  git("update-ref", "refs/remotes/origin/main", base);
  const select = (
    head: string,
    action = "synchronize",
    changes: object = {},
    requestedBase = base,
    baseRef = "main",
  ) => {
    const event = join(root, "event.json"),
      output = join(root, "output.txt");
    writeFileSync(
      event,
      JSON.stringify({
        action,
        changes,
        pull_request: {
          number: 12,
          head: { sha: head },
          base: { sha: requestedBase, ref: baseRef, repo: { id: 66 } },
        },
      }),
    );
    writeFileSync(output, "");
    const result = spawnSync(process.execPath, [launcher, "select"], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_ACTIONS: "false",
        GITHUB_REPOSITORY: "fixture/repo",
        GITHUB_RUN_ID: "500",
        GITHUB_RUN_ATTEMPT: "1",
        PATH: `${join(root, "bin")}:${process.env.PATH}`,
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_EVENT_PATH: event,
        GITHUB_OUTPUT: output,
      },
    });
    const entries = Object.fromEntries(
      readFileSync(output, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );
    return { result, plan: entries.plan ? JSON.parse(entries.plan) : null, entries };
  };
  const provider = (head: string, extra = {}) => {
    const run = {
      id: 100,
      run_number: 100,
      run_started_at: "2026-11-07T00:00:00Z",
      repository: { id: 66 },
      workflow_id: 55,
      event: "pull_request",
      path: ".github/workflows/ci.yml",
      head_sha: head,
      run_attempt: 1,
      status: "completed",
      conclusion: "success",
      ...extra,
    };
    write(
      "provider.json",
      JSON.stringify({
        "repos/fixture/repo/pulls/12": {
          number: 12,
          state: "open",
          head: { sha: head },
          base: { ref: "main", repo: { id: 66 } },
        },
        "repos/fixture/repo/actions/runs/500": { ...run, id: 500 },
        "repos/fixture/repo/actions/runs/100": run,
        "repos/fixture/repo/actions/workflows/55/runs": { total_count: 1, workflow_runs: [run] },
        "repos/fixture/repo/actions/runs/100/jobs": {
          total_count: 3,
          jobs: [
            {
              name: "select required validation",
              run_id: 100,
              run_attempt: 1,
              head_sha: head,
              status: "completed",
              conclusion: "success",
              steps: [
                {
                  name: `CI source v1 ${JSON.stringify(codeReceipt({ code: true, head, number: 12, baseRepositoryId: 66, baseRef: "main", runId: 100, attempt: 1 }))}`,
                  status: "completed",
                  conclusion: "success",
                },
              ],
            },
            {
              name: "lint",
              run_id: 100,
              run_attempt: 1,
              head_sha: head,
              status: "completed",
              conclusion: "success",
            },
            {
              name: "lint / types / test",
              run_id: 100,
              run_attempt: 1,
              head_sha: head,
              status: "completed",
              conclusion: "success",
            },
          ],
        },
      }),
    );
  };
  const verify = (plan: { head: string; base: string }) =>
    spawnSync(process.execPath, [launcher, "verify-reuse"], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${join(root, "bin")}:${process.env.PATH}`,
        GITHUB_EVENT_PATH: join(root, "event.json"),
        GITHUB_REPOSITORY: "fixture/repo",
        GITHUB_RUN_ID: "500",
        CI_PLAN: JSON.stringify(plan),
        CI_HEAD: plan.head,
        CI_BASE: plan.base,
        CI_NEEDS: JSON.stringify(
          Object.fromEntries(
            [
              "select",
              "lint",
              "types",
              "test-node",
              "test-linux-user",
              "test-agent-image",
              "test-web",
              "mobile",
              "database",
              "build",
              "docker-changes",
              "docker-build",
            ].map((id) => [id, { result: id === "select" ? "success" : "skipped" }]),
          ),
        ),
      },
    });
  return {
    root,
    git,
    write,
    commit,
    base,
    select,
    provider,
    verify,
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}
describe("complete immutable Git diff selection", () => {
  it("cannot approve selective skipping through a candidate policy change", () => {
    const f = fixture([]);
    try {
      f.write(
        "scripts/ci-impact-rollout.json",
        JSON.stringify({ version: 1, approvedScopes: ["docs"] }),
      );
      const policy = f.commit();
      f.write("docs/docs/page.md", "prose");
      const candidate = f.commit();
      const plan = f.select(candidate, "synchronize", {}, policy).plan;
      expect(plan.proposedScope).toBe("docs");
      expect(plan.scope).toBe("full");
      expect(Object.values(plan.jobs).every(Boolean)).toBe(true);
    } finally {
      f.close();
    }
  });
  it("reads all 350 changed docs paths without API truncation and preserves head/base identity", () => {
    const f = fixture();
    try {
      for (let n = 0; n < 350; n++) f.write(`docs/docs/page-${n}.md`, "prose");
      const head = f.commit(),
        selected = f.select(head);
      expect(selected.result.status, selected.result.stderr).toBe(0);
      expect(selected.plan.scope).toBe("docs");
      expect(selected.plan.head).toBe(head);
      expect(selected.plan.base).toBe(f.base);
      f.write("packages/core/src/last.ts", "export const changed = true");
      expect(f.select(f.commit()).plan.scope).toBe("full");
    } finally {
      f.close();
    }
  });
  it("retains removed inputs on renames and never treats a symlink as plain docs prose", () => {
    const f = fixture();
    try {
      f.write("packages/core/src/original.ts", "original");
      const base = f.commit();
      mkdirSync(join(f.root, "docs/docs"), { recursive: true });
      f.git("mv", "packages/core/src/original.ts", "docs/docs/moved.md");
      expect(f.select(f.commit(), "synchronize", {}, base).plan.scope).toBe("full");
      mkdirSync(join(f.root, "docs/docs"), { recursive: true });
      symlinkSync("../../README.md", join(f.root, "docs/docs/linked.md"));
      expect(f.select(f.commit()).plan.scope).toBe("full");
    } finally {
      f.close();
    }
  });
  it("cannot enable metadata-only rollout from an untrusted PR change", () => {
    const f = fixture();
    try {
      f.write(
        ".github/workflows/pr-title.yml",
        "# CI metadata gate v1\nnode scripts/validate-pr-metadata.mjs",
      );
      const head = f.commit();
      expect(f.select(head, "edited", { body: { from: "old" } }).plan.code).toBe(true);
      f.git("update-ref", "refs/remotes/origin/stack", f.base);
      f.git("update-ref", "refs/remotes/origin/main", head);
      // An old stacked target still has its old privileged workflow definition.
      expect(f.select(head, "edited", { body: { from: "old" } }, f.base, "stack").plan.code).toBe(
        true,
      );
      expect(f.select(head, "edited", { body: { from: "old" } }).plan.code).toBe(true);
      f.provider(head);
      const reused = f.select(head, "edited", { body: { from: "old" } });
      expect(reused.plan.code).toBe(false);
      expect(f.verify(reused.plan).status).toBe(0);
      f.provider(head, { status: "in_progress", conclusion: null });
      expect(f.verify(reused.plan).status).toBe(1);
      expect(f.select(head, "edited", { body: { from: "old" } }).plan.code).toBe(true);
      f.provider(head, { conclusion: "failure" });
      expect(f.verify(reused.plan).status).toBe(1);
      expect(f.select(head, "edited", { body: { from: "old" } }).plan.code).toBe(true);
      // A source can be rerun after the run inventory was read. Its fresh
      // endpoint must override a stale successful list entry and job receipt.
      for (const changed of [{ status: "in_progress", conclusion: null }, { run_attempt: 2 }]) {
        f.provider(head);
        const stale = JSON.parse(readFileSync(join(f.root, "provider.json"), "utf8"));
        Object.assign(stale["repos/fixture/repo/actions/runs/100"], changed);
        f.write("provider.json", JSON.stringify(stale));
        expect(f.verify(reused.plan).status).toBe(1);
        expect(f.select(head, "edited", { body: { from: "old" } }).plan.code).toBe(true);
      }
      f.provider(head);
      const inventory = JSON.parse(readFileSync(join(f.root, "provider.json"), "utf8"));
      inventory["repos/fixture/repo/actions/workflows/55/runs"].total_count = 2;
      f.write("provider.json", JSON.stringify(inventory));
      expect(f.select(head, "edited", { body: { from: "old" } }).plan.code).toBe(true);
      expect(f.verify(reused.plan).status).toBe(1);
      f.write("docs/docs/new.md", "prose");
      const candidate = f.commit();
      f.provider(candidate);
      expect(f.select(candidate, "edited", { body: { from: "old" } }, head).plan.code).toBe(false);
      expect(f.select(head, "edited", { base: { ref: { from: "main" } } }).plan.scope).toBe("full");
    } finally {
      f.close();
    }
  });
  it("fails without a selection receipt when its comparison commit is unavailable", () => {
    const f = fixture();
    try {
      f.write("docs/docs/a.md", "prose");
      const selected = f.select(f.commit(), "synchronize", {}, "c".repeat(40));
      expect(selected.result.status).not.toBe(0);
      expect(selected.plan).toBeNull();
    } finally {
      f.close();
    }
  });
});
