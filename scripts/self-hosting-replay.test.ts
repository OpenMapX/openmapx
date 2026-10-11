import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  fstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  compareLogical,
  comparePair,
  counterDelta,
  identifyWorktree,
  parseArgs,
  resolveOutput,
  runReplayInvocation,
  summarize,
  validateBuildReuse,
} from "./self-hosting-replay";

const reportRace = vi.hoisted(() => ({
  afterAccess: undefined as ((path: unknown, descriptor?: number) => void) | undefined,
}));
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    lstatSync: (...args: Parameters<typeof actual.lstatSync>) => {
      const stat = actual.lstatSync(...args);
      reportRace.afterAccess?.(args[0]);
      return stat;
    },
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      const fd = actual.openSync(...args);
      reportRace.afterAccess?.(args[0], fd);
      return fd;
    },
  };
});

const roots: string[] = [];
afterEach(() => {
  reportRace.afterAccess = undefined;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const args = [
  "--baseline-oc-root",
  "/baseline",
  "--candidate-oc-root",
  "/candidate",
  "--runs",
  "5",
];
describe("disposable replay boundary", () => {
  it("rejects connection environment and arbitrary connection flags before work", () => {
    for (const key of ["DATABASE_URL", "PGHOST", "PGSERVICE", "PGPORT"]) {
      expect(() => parseArgs(args, { [key]: "unowned" })).toThrow(/connection/i);
    }
    expect(() => parseArgs([...args, "--dsn", "postgres://unowned"], {})).toThrow(/unknown/i);
    expect(() => parseArgs([...args, "--container", "production"], {})).toThrow(/unknown/i);
  });
  it("refuses an unowned URL through the actual CLI before build or database work", () => {
    const result = spawnSync(
      "pnpm",
      ["-C", "packages/cli", "exec", "tsx", "../../scripts/self-hosting-replay.ts", ...args],
      {
        cwd: resolve(import.meta.dirname, ".."),
        encoding: "utf8",
        timeout: 30_000,
        env: { ...process.env, DATABASE_URL: "postgres://unowned.invalid/forbidden" },
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("argument validation");
    expect(result.stderr).not.toContain("unowned.invalid");
  });
  it("requires both explicit roots and at least five repetitions", () => {
    expect(() => parseArgs([], {})).toThrow();
    expect(() => parseArgs([...args, "--runs", "1"], {})).toThrow();
    expect(parseArgs(args, {}).runs).toBe(5);
  });
  it("invalidates a successful report before a failed rerun reaches provenance validation", () => {
    const harnessRoot = resolve(import.meta.dirname, "..");
    mkdirSync(join(harnessRoot, "plans"), { recursive: true });
    const output = mkdtempSync(join(harnessRoot, "plans", "replay-test-"));
    roots.push(output);
    writeFileSync(
      join(output, "summary.json"),
      JSON.stringify({
        status: "COMPLETE",
        invocationId: "old",
        correctness: { equal: true, differences: 0 },
      }),
    );
    writeFileSync(
      join(output, "runs.json"),
      JSON.stringify({ status: "COMPLETE", invocationId: "old", results: [] }),
    );
    const result = spawnSync(
      "pnpm",
      [
        "-C",
        "packages/cli",
        "exec",
        "tsx",
        "../../scripts/self-hosting-replay.ts",
        ...args,
        "--output",
        output,
      ],
      {
        cwd: harnessRoot,
        encoding: "utf8",
        timeout: 30_000,
        env: Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) => !["DATABASE_URL", "PGHOST", "PGSERVICE", "PGPORT"].includes(key),
          ),
        ),
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("worktree identity");
    const summary = JSON.parse(readFileSync(join(output, "summary.json"), "utf8"));
    const runs = JSON.parse(readFileSync(join(output, "runs.json"), "utf8"));
    expect(summary.status).toBe("INCOMPLETE");
    expect(summary.correctness?.equal).not.toBe(true);
    expect(summary.invocationId).not.toBe("old");
    expect(runs.invocationId).toBe(summary.invocationId);
    expect(runs.status).toBe("INCOMPLETE");
  });
  it("retains the opened prior report when its pathname is replaced", async () => {
    const output = mkdtempSync(join(tmpdir(), "replay-report-race-"));
    roots.push(output);
    const previous = join(output, "runs.json");
    const original = { identities: ["captured"], builds: ["original"], results: [] };
    writeFileSync(previous, JSON.stringify(original));
    reportRace.afterAccess = (path) => {
      if (path !== previous) return;
      reportRace.afterAccess = undefined;
      renameSync(previous, join(output, "captured.json"));
      writeFileSync(previous, JSON.stringify({ identities: ["replacement"], builds: [] }));
    };
    await runReplayInvocation(output, async ({ previousReport }) => {
      expect(previousReport).toEqual(original);
      return { runs: { results: [] }, summary: { correctness: { equal: true } } };
    });
    const runs = JSON.parse(readFileSync(previous, "utf8"));
    const summary = JSON.parse(readFileSync(join(output, "summary.json"), "utf8"));
    expect(runs.status).toBe("COMPLETE");
    expect(summary.invocationId).toBe(runs.invocationId);
  });
  it.each(["symlink", "directory", "invalid-json"])(
    "leaves completion invalidated when the prior report is %s",
    async (kind) => {
      const output = mkdtempSync(join(tmpdir(), "replay-invalid-report-"));
      roots.push(output);
      const previous = join(output, "runs.json");
      writeFileSync(join(output, "summary.json"), JSON.stringify({ status: "COMPLETE" }));
      if (kind === "symlink") {
        writeFileSync(join(output, "target.json"), "{}");
        symlinkSync(join(output, "target.json"), previous);
      } else if (kind === "directory") mkdirSync(previous);
      else writeFileSync(previous, "invalid");
      let reachedWork = false;
      await expect(
        runReplayInvocation(output, async () => {
          reachedWork = true;
          return { runs: {}, summary: {} };
        }),
      ).rejects.toThrow();
      expect(reachedWork).toBe(false);
      expect(JSON.parse(readFileSync(join(output, "summary.json"), "utf8")).status).toBe(
        "INCOMPLETE",
      );
    },
  );
  it("rejects a prior FIFO through a bounded owned child", () => {
    const output = mkdtempSync(join(tmpdir(), "replay-report-fifo-"));
    roots.push(output);
    const previous = join(output, "runs.json");
    expect(spawnSync("/usr/bin/mkfifo", [previous]).status).toBe(0);
    const program = `
import { runReplayInvocation } from ${JSON.stringify(pathToFileURL(resolve(import.meta.dirname, "self-hosting-replay.ts")).href)};
runReplayInvocation(process.argv[1], async () => { throw new Error('unexpected work'); })
  .then(() => { process.exitCode = 2; })
  .catch(error => { console.error(error.message); process.exitCode = 1; });
`;
    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "-e", program, output],
      { encoding: "utf8", timeout: 10_000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("regular owned file");
    expect(JSON.parse(readFileSync(join(output, "summary.json"), "utf8")).status).toBe(
      "INCOMPLETE",
    );
  });
  it("closes the prior report descriptor when parsing fails", async () => {
    const output = mkdtempSync(join(tmpdir(), "replay-report-close-"));
    roots.push(output);
    const previous = join(output, "runs.json");
    writeFileSync(previous, "invalid JSON");
    let descriptor: number | undefined;
    reportRace.afterAccess = (path, opened) => {
      if (path === previous && opened !== undefined) descriptor = opened;
    };
    await expect(
      runReplayInvocation(output, async () => ({ runs: {}, summary: {} })),
    ).rejects.toThrow();
    expect(descriptor).toBeTypeOf("number");
    if (descriptor === undefined) throw new Error("Expected an opened report descriptor");
    expect(() => fstatSync(descriptor)).toThrow(expect.objectContaining({ code: "EBADF" }));
  });
  it("resolves CLI output under the harness worktree regardless of cwd", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "replay-")));
    roots.push(root);
    mkdirSync(join(root, "plans"));
    expect(resolveOutput(root, "plans/replay-results")).toBe(join(root, "plans/replay-results"));
    expect(() => resolveOutput(root, "../results")).toThrow();
    symlinkSync(tmpdir(), join(root, "plans", "escape"));
    expect(() => resolveOutput(root, "plans/escape/results")).toThrow();
  });
  it("requires an isolated clean worktree and records its real revision", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "replay-git-")));
    roots.push(root);
    const main = join(root, "main"),
      linked = join(root, "linked");
    mkdirSync(main);
    const git = (args: string[]) =>
      execFileSync("git", args, {
        cwd: main,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    git(["init"]);
    mkdirSync(join(main, "packages/storage"), { recursive: true });
    writeFileSync(
      join(main, "packages/storage/package.json"),
      JSON.stringify({ name: "@openconditions/storage" }),
    );
    git(["add", "."]);
    git([
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "fixture",
    ]);
    git(["worktree", "add", "--detach", linked]);
    expect(() => identifyWorktree(main)).toThrow(/isolated/);
    expect(identifyWorktree(linked)).toMatchObject({
      revision: git(["rev-parse", "HEAD"]),
      dirty: false,
    });
    writeFileSync(join(linked, "new-source.ts"), "export const changed = true;");
    expect(() => identifyWorktree(linked)).toThrow(/Commit/);
    rmSync(join(linked, "new-source.ts"));
    writeFileSync(join(linked, "packages/storage/package.json"), "{}");
    expect(() => identifyWorktree(linked)).toThrow(/Commit/);
  });
  it("compares stable logical values without erasing freshness or history", () => {
    expect(compareLogical({ b: 2, a: [1] }, { a: [1], b: 2 }).equal).toBe(true);
    expect(compareLogical({ computed_at: "t0" }, { computed_at: "t1" }).equal).toBe(false);
    expect(compareLogical({ revision: 1 }, { revision: 2 }).equal).toBe(false);
  });
  it("refuses different fixtures or inputs before comparing equal rows", () => {
    const baseline = {
      revision: "a",
      fixtureHash: "fixture",
      inputHash: "input",
      logical: { revision: 1 },
    };
    expect(() => comparePair(baseline, { ...baseline, revision: "b", inputHash: "other" })).toThrow(
      /input/,
    );
    expect(() =>
      comparePair(baseline, { ...baseline, revision: "b", fixtureHash: "other" }),
    ).toThrow(/fixture/);
    expect(comparePair(baseline, baseline)).toMatchObject({ equal: true, control: true });
    expect(comparePair(baseline, { ...baseline, revision: "b" })).toMatchObject({
      equal: true,
      control: false,
    });
  });
  it("rejects counter resets and negative deltas", () => {
    expect(
      counterDelta(
        { reset: "t0", values: { wal: "100" } },
        { reset: "t0", values: { wal: "132" } },
      ),
    ).toEqual({ wal: "32" });
    expect(() =>
      counterDelta(
        { reset: "t0", values: { wal: "100" } },
        { reset: "t1", values: { wal: "132" } },
      ),
    ).toThrow(/reset/);
    expect(() =>
      counterDelta({ reset: "t0", values: { wal: "100" } }, { reset: "t0", values: { wal: "1" } }),
    ).toThrow(/decreas/);
  });
  it("reuses only exact clean revisions and every successfully built artifact", () => {
    const identity = { path: "/baseline", revision: "a", dirty: false };
    const identities = [identity];
    const artifacts = [{ "packages/storage/dist/index.js": "a".repeat(64) }];
    const builds = [
      {
        command: ["pnpm", "exec", "turbo", "run", "build", "--force", "--concurrency=1"],
        exitCode: 0,
        artifacts: artifacts[0],
      },
    ];
    expect(validateBuildReuse({ identities, builds }, identities, artifacts)[0]).toMatchObject({
      reusedFromPreviousRun: true,
      artifacts: artifacts[0],
    });
    expect(() =>
      validateBuildReuse({ identities, builds }, [{ ...identity, revision: "b" }], artifacts),
    ).toThrow(/identity/);
    expect(() =>
      validateBuildReuse({ identities, builds }, identities, [
        { ...artifacts[0], "extra.js": "b".repeat(64) },
      ]),
    ).toThrow(/artifact/);
    for (const replacement of [{ command: ["arbitrary"] }, { exitCode: 1 }, { artifacts: {} }]) {
      expect(() =>
        validateBuildReuse(
          { identities, builds: [{ ...builds[0], ...replacement }] },
          identities,
          artifacts,
        ),
      ).toThrow();
    }
    expect(() => validateBuildReuse({}, identities, artifacts)).toThrow();
  });

  it.each(["interruption", "logical difference", "provenance failure", "cleanup failure"])(
    "keeps a rerun incomplete after %s instead of retaining prior success",
    async (failure) => {
      const output = mkdtempSync(join(tmpdir(), "replay-report-"));
      roots.push(output);
      const identities = [{ path: "/baseline", revision: "a", dirty: false }];
      const artifacts = [{ "packages/storage/dist/index.js": "a".repeat(64) }];
      const builds = [
        {
          command: ["pnpm", "exec", "turbo", "run", "build", "--force", "--concurrency=1"],
          exitCode: 0,
          artifacts: artifacts[0],
        },
      ];
      const report = { identities, builds, results: [{ correctness: { equal: true } }] };
      await runReplayInvocation(output, async () => ({
        runs: report,
        summary: { correctness: { equal: true, differences: 0 } },
      }));
      const prior = JSON.parse(readFileSync(join(output, "summary.json"), "utf8"));
      expect(prior.status).toBe("COMPLETE");
      await expect(
        runReplayInvocation(output, async (invocation) => {
          expect(
            validateBuildReuse(invocation.previousReport, identities, artifacts)[0]
              .reusedFromPreviousRun,
          ).toBe(true);
          invocation.writeRuns({
            identities,
            builds,
            results: [{ correctness: { equal: false } }],
          });
          const cleanup = async () => {
            if (failure === "cleanup failure") throw new Error(failure);
          };
          try {
            if (failure === "logical difference") {
              const arm = {
                revision: "a",
                fixtureHash: "f",
                inputHash: "i",
                logical: { revision: 1 },
              };
              if (!comparePair(arm, { ...arm, logical: { revision: 2 } }).equal)
                throw new Error(failure);
            }
            if (failure === "provenance failure")
              validateBuildReuse(invocation.previousReport, identities, [
                { "packages/storage/dist/index.js": "b".repeat(64) },
              ]);
            if (failure === "interruption") throw new Error(failure);
            return { runs: report, summary: { correctness: { equal: true } } };
          } finally {
            await cleanup();
          }
        }),
      ).rejects.toThrow();
      const summary = JSON.parse(readFileSync(join(output, "summary.json"), "utf8"));
      const runs = JSON.parse(readFileSync(join(output, "runs.json"), "utf8"));
      expect(summary).toMatchObject({ status: "INCOMPLETE", invocationId: runs.invocationId });
      expect(summary.invocationId).not.toBe(prior.invocationId);
      expect(summary.correctness?.equal).not.toBe(true);
      expect(runs.status).toBe("INCOMPLETE");
      expect(runs.results).toEqual([{ correctness: { equal: false } }]);
      expect(validateBuildReuse(runs, identities, artifacts)[0].reusedFromPreviousRun).toBe(true);
    },
  );

  it("publishes complete matching reports only after asynchronous cleanup settles", async () => {
    const output = mkdtempSync(join(tmpdir(), "replay-report-"));
    roots.push(output);
    let release!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = runReplayInvocation(output, async (invocation) => {
      invocation.writeRuns({ results: [{ correctness: { equal: true } }] });
      try {
        return { runs: { results: [] }, summary: { correctness: { equal: true } } };
      } finally {
        await cleanup;
      }
    });
    expect(JSON.parse(readFileSync(join(output, "summary.json"), "utf8")).status).toBe(
      "INCOMPLETE",
    );
    release();
    await pending;
    const summary = JSON.parse(readFileSync(join(output, "summary.json"), "utf8"));
    const runs = JSON.parse(readFileSync(join(output, "runs.json"), "utf8"));
    expect(summary.status).toBe("COMPLETE");
    expect(runs).toMatchObject({ status: "COMPLETE", invocationId: summary.invocationId });
    expect(readdirSync(output).some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it("leaves a reused directory incomplete when the actual reporting process is interrupted", async () => {
    const output = mkdtempSync(join(tmpdir(), "replay-interrupted-"));
    roots.push(output);
    await runReplayInvocation(output, async () => ({
      runs: { results: [] },
      summary: { correctness: { equal: true } },
    }));
    const prior = JSON.parse(readFileSync(join(output, "summary.json"), "utf8"));
    const scoped = createRequire(resolve(import.meta.dirname, "../packages/cli/package.json"));
    const script = pathToFileURL(resolve(import.meta.dirname, "self-hosting-replay.ts")).href;
    const child = spawn(
      process.execPath,
      [
        "--import",
        scoped.resolve("tsx"),
        "--input-type=module",
        "--eval",
        `import {runReplayInvocation} from ${JSON.stringify(script)}; await runReplayInvocation(${JSON.stringify(output)}, async invocation => { invocation.writeRuns({results:[{correctness:{equal:true}}]}); process.stdout.write("READY\\n"); await new Promise(() => {setInterval(() => {}, 1000)}); });`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const exited = new Promise((resolve) =>
      child.once("exit", (code, signal) => resolve({ code, signal })),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Reporting child did not start")), 10_000);
        child.once("error", reject);
        child.stdout.on("data", (data) => {
          if (String(data).includes("READY")) resolve();
        });
        child.once("exit", () => reject(new Error("Reporting child exited before interruption")));
      });
      child.kill("SIGTERM");
      expect(await exited).toEqual({ code: null, signal: "SIGTERM" });
      const summary = JSON.parse(readFileSync(join(output, "summary.json"), "utf8"));
      const runs = JSON.parse(readFileSync(join(output, "runs.json"), "utf8"));
      expect(summary).toMatchObject({ status: "INCOMPLETE", invocationId: runs.invocationId });
      expect(summary.invocationId).not.toBe(prior.invocationId);
      expect(summary.correctness?.equal).not.toBe(true);
      expect(runs.status).toBe("INCOMPLETE");
    } finally {
      if (timer) clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await exited;
    }
  });

  it("reports medians, nearest rank p95 and spread from every repetition", () => {
    expect(summarize([9, 1, 5, 3, 7])).toEqual({ median: 5, p95: 9, min: 1, max: 9, count: 5 });
    expect(() => summarize([])).toThrow();
  });
});
