import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const fixtures: string[] = [];
const gitLocalVariables = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_CONFIG",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS",
  "GIT_DIR",
  "GIT_GRAFT_FILE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PREFIX",
  "GIT_REPLACE_REF_BASE",
  "GIT_SHALLOW_FILE",
  "GIT_WORK_TREE",
];

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "openmapx-hook-"));
  fixtures.push(dir);
  for (const file of [
    ".husky/pre-commit",
    ".husky/pre-push",
    ".husky/commit-msg",
    "scripts/check-staged.mjs",
    "scripts/verify-full.sh",
    "biome.json",
    ".prettierrc.json",
    ".prettierignore",
  ]) {
    if (!existsSync(join(root, file))) continue;
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    copyFileSync(join(root, file), join(dir, file));
  }
  symlinkSync(join(root, "node_modules"), join(dir, "node_modules"), "dir");
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const calls = join(dir, "calls.jsonl");
  writeFileSync(
    join(bin, "pnpm"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ args, gitLocalPresent: ${JSON.stringify(gitLocalVariables)}.filter(key => process.env[key] !== undefined) }) + "\\n");
if (args[0] === "exec" && args[1] === "biome") {
  const r = spawnSync(process.execPath, [${JSON.stringify(join(root, "node_modules/@biomejs/biome/bin/biome"))}, ...args.slice(2)], { stdio: "inherit" });
  process.exit(r.status ?? 1);
}
if (process.env.FULL_VERIFY_FIXTURE !== "1" && args[1] !== "commitlint") process.exit(71);
process.exit(args[0] === process.env.FAIL_COMMAND ? 23 : 0);
`,
    { mode: 0o755 },
  );
  // Isolate orchestration tests from the host's global cross-repository lock.
  writeFileSync(join(bin, "flock"), '#!/bin/sh\nshift 3\nexec "$@"\n', { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, env, encoding: "utf8" });
  git("init", "-q");
  const write = (path: string, contents: string) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), contents);
  };
  const stage = (path: string, contents: string) => {
    write(path, contents);
    git("add", "--", path);
  };
  const run = (file = ".husky/pre-commit", extraEnv: NodeJS.ProcessEnv = {}) =>
    existsSync(join(dir, file))
      ? spawnSync("sh", ["-e", file], { cwd: dir, env: { ...env, ...extraEnv }, encoding: "utf8" })
      : { status: 0, stdout: "", stderr: "" };
  return {
    dir,
    git,
    write,
    stage,
    run,
    calls: () =>
      existsSync(calls)
        ? readFileSync(calls, "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        : [],
  };
}

afterEach(() => {
  for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("ordinary hooks", () => {
  it.each([
    "notes.md",
    "integrations/example/index.ts",
    "packages/core/example.ts",
    "package.json",
  ])("checks %s without broad validation or network access", (path) => {
    const f = fixture();
    f.stage(
      path,
      path.endsWith(".md") ? "# Notes\n" : path.endsWith(".json") ? "{}\n" : "export {};\n",
    );
    expect(f.run().status).toBe(0);
    expect(f.calls()).toEqual([]);
  });

  it("validates the index and leaves partially staged and unrelated working files intact", () => {
    const f = fixture();
    f.stage("partial.ts", "export const value = 1;\n");
    f.write("partial.ts", "export const value= {broken\n");
    f.write("unrelated.ts", "also { invalid\n");
    const index = f.git("write-tree");
    const result = f.run();
    expect(result.status, result.stderr).toBe(0);
    expect(f.git("write-tree")).toBe(index);
    expect(readFileSync(join(f.dir, "partial.ts"), "utf8")).toBe("export const value= {broken\n");
    expect(readFileSync(join(f.dir, "unrelated.ts"), "utf8")).toBe("also { invalid\n");
  });

  it("rejects invalid staged code even when the working copy is repaired", () => {
    const f = fixture();
    f.stage("partial.ts", "export const value= {broken\n");
    f.write("partial.ts", "export const value = 1;\n");
    const index = f.git("write-tree");
    expect(f.run().status).not.toBe(0);
    expect(f.git("write-tree")).toBe(index);
    expect(readFileSync(join(f.dir, "partial.ts"), "utf8")).toBe("export const value = 1;\n");
  });

  it.each(["name with spaces.md", "line\nbreak.yaml", "quote'and[glob].md", "-option.md"])(
    "rejects unformatted staged text with literal path %j without changing it",
    (path) => {
      const f = fixture();
      const contents = path.endsWith(".yaml") ? "key:    value\n" : "#  Heading\n";
      f.stage(path, contents);
      const index = f.git("write-tree");
      expect(f.run().status).not.toBe(0);
      expect(f.git("write-tree")).toBe(index);
      expect(readFileSync(join(f.dir, path), "utf8")).toBe(contents);
    },
  );

  it("rejects staged code that needs formatting without modifying either copy", () => {
    const f = fixture();
    f.stage("format.ts", "export const value=1\n");
    const index = f.git("write-tree");
    expect(f.run().status).not.toBe(0);
    expect(f.git("write-tree")).toBe(index);
    expect(readFileSync(join(f.dir, "format.ts"), "utf8")).toBe("export const value=1\n");
  });

  it("respects Biome exclusions for generated and frozen source", () => {
    const f = fixture();
    f.stage("docs/generated.json", "{unformatted\n");
    f.stage("apps/api/openapi.json", "{unformatted\n");
    expect(f.run().status).toBe(0);
  });

  it.each(["-option.ts", "line\nbreak.ts", "name with spaces.ts", "literal[glob].ts"])(
    "checks staged code at literal path %j",
    (path) => {
      const f = fixture();
      f.stage(path, "export const value = 1;\n");
      expect(f.run().status).toBe(0);
    },
  );

  it("checks a renamed destination and skips deletions and generated text", () => {
    const f = fixture();
    f.stage("before.md", "# Before\n");
    f.git(
      "-c",
      "commit.gpgsign=false",
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.test",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "-qm",
      "fixture",
    );
    f.git("mv", "before.md", "renamed file.md");
    f.stage("pnpm-lock.yaml", "intentionally:    unformatted\n");
    expect(f.run().status).toBe(0);
    f.git("rm", "-f", "renamed file.md");
    expect(f.run().status).toBe(0);
  });

  it("never runs the full suite or acquires the heavy verification lock on push", () => {
    const f = fixture();
    expect(f.run(".husky/pre-push").status).toBe(0);
    expect(f.calls()).toEqual([]);
  });
});

describe("explicit full verification", () => {
  it("runs all local gates in order after clearing hook-local Git paths", () => {
    const f = fixture();
    expect(existsSync(join(f.dir, "scripts/verify-full.sh"))).toBe(true);
    const result = f.run("scripts/verify-full.sh", {
      FULL_VERIFY_FIXTURE: "1",
      ...Object.fromEntries(gitLocalVariables.map((key) => [key, "/invalid/hook-metadata"])),
    });
    expect(result.status, result.stderr).toBe(0);
    expect(f.calls()).toEqual([
      { args: ["lint"], gitLocalPresent: [] },
      { args: ["check-types"], gitLocalPresent: [] },
      { args: ["check:policy"], gitLocalPresent: [] },
      { args: ["check-openapi"], gitLocalPresent: [] },
      { args: ["test", "--maxWorkers=50%"], gitLocalPresent: [] },
    ]);
  });

  it("propagates a failed gate and does not run later gates", () => {
    const f = fixture();
    expect(existsSync(join(f.dir, "scripts/verify-full.sh"))).toBe(true);
    const result = f.run("scripts/verify-full.sh", {
      FULL_VERIFY_FIXTURE: "1",
      FAIL_COMMAND: "check-types",
    });
    expect(result.status).toBe(23);
    expect(f.calls().map((call) => call.args)).toEqual([["lint"], ["check-types"]]);
  });
});
