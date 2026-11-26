import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { SpawnWithBufferedLogsOptions } from "../spawn";

// The helper only accepts allowlisted https remotes. These tests serve a local
// fixture instead: the spawn wrapper records each git invocation exactly as the
// helper made it, then points the allowlisted URL at the fixture and permits the
// `file` transport for that one process.
const remote = vi.hoisted(() => ({
  canonical: "https://github.com/fixture/many-files",
  fixture: "",
  traceDirectory: "",
  withoutLazyFetchVariable: false,
  calls: [] as { args: string[]; env: NodeJS.ProcessEnv | undefined }[],
}));

vi.mock("../spawn", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../spawn")>();
  return {
    ...actual,
    spawnWithBufferedLogs: (
      cmd: string,
      args: string[],
      opts: SpawnWithBufferedLogsOptions = {},
    ) => {
      remote.calls.push({ args: [...args], env: opts.env });
      if (cmd !== "git" || !remote.fixture) return actual.spawnWithBufferedLogs(cmd, args, opts);
      const env: NodeJS.ProcessEnv = {
        ...opts.env,
        GIT_ALLOW_PROTOCOL: "file",
        GIT_TRACE2_EVENT: remote.traceDirectory,
      };
      if (remote.withoutLazyFetchVariable) delete env.GIT_NO_LAZY_FETCH;
      return actual.spawnWithBufferedLogs(
        cmd,
        args.map((arg) => (arg === remote.canonical ? remote.fixture : arg)),
        { ...opts, env },
      );
    },
  };
});

const { GIT_CLONE_MAX_FILE_BYTES, GitCloneQuotaError, gitShallowCloneSnapshot } = await import(
  "../git-clone"
);

const FILE_COUNT = 50;
const fixtureEnvironment = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};

let fixtures = "";
const scratch: string[] = [];

function git(args: string[]): string {
  return execFileSync("git", args, { env: fixtureEnvironment, encoding: "utf8" });
}

/** A bare repository with many small files, optionally one over the per-file limit. */
function bareRepository(name: string, options: { oversized: boolean; allowFilter: boolean }) {
  const work = join(fixtures, `${name}-work`);
  mkdirSync(join(work, "src"), { recursive: true });
  for (let index = 0; index < FILE_COUNT; index += 1) {
    writeFileSync(join(work, "src", `file-${index}.txt`), `fixture file ${index}\n`);
  }
  writeFileSync(join(work, "README.md"), "# Fixture\n");
  if (options.oversized) {
    const handle = openSync(join(work, "huge.bin"), "w");
    ftruncateSync(handle, GIT_CLONE_MAX_FILE_BYTES + 1);
    closeSync(handle);
  }
  git(["init", "--quiet", "--initial-branch=main", work]);
  git(["-C", work, "add", "--all"]);
  git(["-C", work, "commit", "--quiet", "--message", "fixture"]);
  const bare = join(fixtures, `${name}.git`);
  git(["clone", "--quiet", "--bare", "--no-local", work, bare]);
  git(["-C", bare, "config", "uploadpack.allowFilter", String(options.allowFilter)]);
  return `file://${bare}`;
}

/** Count the processes any traced git process started whose argv mentions `needle`. */
function childStarts(needle: string): number {
  let count = 0;
  for (const name of readdirSync(remote.traceDirectory)) {
    for (const line of readFileSync(join(remote.traceDirectory, name), "utf8").split("\n")) {
      if (!line.includes('"event":"child_start"')) continue;
      const event = JSON.parse(line) as { argv?: string[] };
      if (event.argv?.some((arg) => arg.includes(needle))) count += 1;
    }
  }
  return count;
}

/** Count the times any git process in the trace contacted the fixture remote. */
function remoteRoundTrips(): number {
  return childStarts("git-upload-pack");
}

const repositories = {
  filtered: "",
  filteredOversized: "",
  unfiltered: "",
  unfilteredOversized: "",
};

beforeAll(() => {
  fixtures = mkdtempSync(join(tmpdir(), "openmapx-clone-fixture-"));
  repositories.filtered = bareRepository("filtered", { oversized: false, allowFilter: true });
  repositories.filteredOversized = bareRepository("filtered-oversized", {
    oversized: true,
    allowFilter: true,
  });
  repositories.unfiltered = bareRepository("unfiltered", { oversized: false, allowFilter: false });
  repositories.unfilteredOversized = bareRepository("unfiltered-oversized", {
    oversized: true,
    allowFilter: false,
  });
  return () => rm(fixtures, { recursive: true, force: true });
}, 60_000);

afterEach(async () => {
  remote.fixture = "";
  remote.withoutLazyFetchVariable = false;
  remote.calls.length = 0;
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function prepare(fixture: string): string {
  const parent = mkdtempSync(join(tmpdir(), "openmapx-clone-target-"));
  scratch.push(parent);
  remote.fixture = fixture;
  remote.traceDirectory = join(parent, "trace");
  mkdirSync(remote.traceDirectory);
  return join(parent, "checkout");
}

function gitCalls(subcommand: string) {
  return remote.calls.filter((call) => call.args[0] === "-C" && call.args[2] === subcommand);
}

describe("gitShallowCloneSnapshot against a local remote", () => {
  it("stages many small files in one fetch, without lazy fetches", async () => {
    const targetDir = prepare(repositories.filtered);

    const snapshot = await gitShallowCloneSnapshot({ url: remote.canonical, targetDir });

    expect(snapshot.directory).toBe(targetDir);
    expect(snapshot.canonicalUrl).toBe(remote.canonical);
    expect(snapshot.commit).toBe(
      git(["-C", repositories.filtered.slice(7), "rev-parse", "main"]).trim(),
    );
    expect(readFileSync(join(targetDir, "src", "file-23.txt"), "utf8")).toBe("fixture file 23\n");
    expect(readdirSync(join(targetDir, "src"))).toHaveLength(FILE_COUNT);
    expect(existsSync(join(targetDir, ".git"))).toBe(false);
    // One fetch, and no git step went back to the remote for a missing blob.
    expect(gitCalls("fetch")).toHaveLength(1);
    expect(remoteRoundTrips()).toBe(1);
  });

  it("starts no background maintenance in the staging repository", async () => {
    const targetDir = prepare(repositories.filtered);
    await gitShallowCloneSnapshot({ url: remote.canonical, targetDir });

    expect(gitCalls("fetch")[0]?.args).toContain("--no-auto-maintenance");
    expect(childStarts("maintenance")).toBe(0);
  });

  it("asks the remote to leave out only blobs above the per-file limit", async () => {
    const targetDir = prepare(repositories.filtered);
    await gitShallowCloneSnapshot({ url: remote.canonical, targetDir });

    const [fetch] = gitCalls("fetch");
    // `blob:limit=<n>` omits blobs of n bytes or more, so a file of exactly the
    // limit is still sent.
    expect(fetch?.args).toContain(`--filter=blob:limit=${GIT_CLONE_MAX_FILE_BYTES + 1}`);
  });

  it("runs every git step with lazy fetching disabled", async () => {
    const targetDir = prepare(repositories.filtered);
    await gitShallowCloneSnapshot({ url: remote.canonical, targetDir });

    const gitInvocations = remote.calls.filter((call) => call.env !== undefined);
    expect(gitInvocations.length).toBeGreaterThanOrEqual(6);
    for (const call of gitInvocations) {
      expect(call.env?.GIT_NO_LAZY_FETCH).toBe("1");
      expect(call.env?.GIT_ALLOW_PROTOCOL).toBe("https");
    }
  });

  it("refuses a file over the per-file limit without downloading it", async () => {
    const targetDir = prepare(repositories.filteredOversized);

    await expect(gitShallowCloneSnapshot({ url: remote.canonical, targetDir })).rejects.toThrow(
      new GitCloneQuotaError(
        `Repository contains a file larger than ${GIT_CLONE_MAX_FILE_BYTES} bytes at huge.bin`,
      ),
    );
    expect(remoteRoundTrips()).toBe(1);
    expect(gitCalls("checkout")).toHaveLength(0);
    expect(existsSync(targetDir)).toBe(false);
  });

  it("refuses an oversized file without a fetch even if git ignored the lazy-fetch variable", async () => {
    // Removing the remote after the fetch is what makes the refusal the same
    // on every git version; the variable is only the second guard.
    const targetDir = prepare(repositories.filteredOversized);
    remote.withoutLazyFetchVariable = true;

    await expect(gitShallowCloneSnapshot({ url: remote.canonical, targetDir })).rejects.toThrow(
      new GitCloneQuotaError(
        `Repository contains a file larger than ${GIT_CLONE_MAX_FILE_BYTES} bytes at huge.bin`,
      ),
    );
    expect(remoteRoundTrips()).toBe(1);
    expect(gitCalls("checkout")).toHaveLength(0);
  });

  it("stages correctly from a remote that ignores the filter", async () => {
    const targetDir = prepare(repositories.unfiltered);

    const snapshot = await gitShallowCloneSnapshot({ url: remote.canonical, targetDir });

    expect(snapshot.directory).toBe(targetDir);
    expect(readFileSync(join(targetDir, "README.md"), "utf8")).toBe("# Fixture\n");
    expect(readdirSync(join(targetDir, "src"))).toHaveLength(FILE_COUNT);
    expect(remoteRoundTrips()).toBe(1);
  });

  it("refuses an oversized file from a remote that ignores the filter, before checkout", async () => {
    const targetDir = prepare(repositories.unfilteredOversized);

    await expect(gitShallowCloneSnapshot({ url: remote.canonical, targetDir })).rejects.toThrow(
      new GitCloneQuotaError(
        `Repository contains a file larger than ${GIT_CLONE_MAX_FILE_BYTES} bytes at huge.bin`,
      ),
    );
    expect(gitCalls("checkout")).toHaveLength(0);
    expect(existsSync(targetDir)).toBe(false);
  });
});
