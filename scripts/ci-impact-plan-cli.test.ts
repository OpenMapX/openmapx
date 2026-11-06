import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

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
  write(".gitignore", "event.json\noutput.txt\n");
  const base = commit();
  git("update-ref", "refs/remotes/origin/main", base);
  const select = (
    head: string,
    action = "synchronize",
    changes: object = {},
    requestedBase = base,
  ) => {
    const event = join(root, "event.json"),
      output = join(root, "output.txt");
    writeFileSync(
      event,
      JSON.stringify({
        action,
        changes,
        pull_request: { head: { sha: head }, base: { sha: requestedBase } },
      }),
    );
    writeFileSync(output, "");
    const result = spawnSync(process.execPath, [launcher, "select"], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
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
  return {
    root,
    git,
    write,
    commit,
    base,
    select,
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
      f.git("update-ref", "refs/remotes/origin/main", head);
      // An old stacked target still has its old privileged workflow definition.
      expect(f.select(head, "edited", { body: { from: "old" } }).plan.code).toBe(true);
      f.write("docs/docs/new.md", "prose");
      const candidate = f.commit();
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
