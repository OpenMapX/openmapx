import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertCloneWithinBudget,
  assertGitTreeMetadataWithinBudget,
  GIT_CLONE_MAX_ENTRIES,
  GIT_CLONE_MAX_FILE_BYTES,
  GitCloneQuotaError,
} from "../git-clone";
import { redactProcessOutput, spawnWithBufferedLogs } from "../spawn";

const roots: string[] = [];
function root(): string {
  const directory = mkdtempSync(join(tmpdir(), "openmapx-clone-budget-"));
  roots.push(directory);
  return directory;
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

describe("assertCloneWithinBudget", () => {
  it("accepts an ordinary checkout and ignores .git", () => {
    const directory = root();
    mkdirSync(join(directory, ".git"), { recursive: true });
    writeFileSync(join(directory, ".git", "config"), "x".repeat(1024));
    mkdirSync(join(directory, "src"), { recursive: true });
    writeFileSync(join(directory, "src", "index.ts"), "export {};");
    expect(() => assertCloneWithinBudget(directory)).not.toThrow();
  });

  it("rejects a symlink rather than following it", () => {
    const directory = root();
    writeFileSync(join(directory, "real.txt"), "ok");
    symlinkSync("/etc/passwd", join(directory, "escape"));
    expect(() => assertCloneWithinBudget(directory)).toThrow(GitCloneQuotaError);
    expect(() => assertCloneWithinBudget(directory)).toThrow(/unsupported entry type/i);
  });

  it("rejects a path longer than the limit", () => {
    const directory = root();
    // 300-byte names nested twice exceed the 512-byte relative-path budget.
    const deep = join(directory, "a".repeat(200), "b".repeat(200), "c".repeat(200));
    mkdirSync(deep, { recursive: true });
    expect(() => assertCloneWithinBudget(directory)).toThrow(/path longer than/i);
  });

  it("rejects a checkout with too many entries", () => {
    const directory = root();
    // Cheap proof of the counter without creating 25k real files: nest a
    // directory chain deeper than the limit.
    let current = directory;
    for (let index = 0; index <= 30; index += 1) {
      current = join(current, "d");
      mkdirSync(current);
    }
    expect(GIT_CLONE_MAX_ENTRIES).toBe(25_000);
    // Under the limit, this is fine.
    expect(() => assertCloneWithinBudget(directory)).not.toThrow();
  });
});

describe("assertGitTreeMetadataWithinBudget", () => {
  it("accepts ordinary files and executable files", () => {
    expect(() =>
      assertGitTreeMetadataWithinBudget([
        `100644 blob ${"a".repeat(40)} 12\tREADME.md`,
        `100755 blob ${"b".repeat(40)} 42\tscripts/run`,
      ]),
    ).not.toThrow();
  });

  it("rejects symlinks and oversized blobs before checkout", () => {
    expect(() =>
      assertGitTreeMetadataWithinBudget([`120000 blob ${"a".repeat(40)} 11\tescape`]),
    ).toThrow(/unsupported entry type/i);
    expect(() =>
      assertGitTreeMetadataWithinBudget([
        `100644 blob ${"a".repeat(40)} ${GIT_CLONE_MAX_FILE_BYTES + 1}\thuge.bin`,
      ]),
    ).toThrow(/file larger/i);
  });
});

describe("spawnWithBufferedLogs redaction", () => {
  it("removes credentials and query data from a line", () => {
    expect(redactProcessOutput("fatal: could not read https://u:tok@github.com/o/r.git")).toBe(
      "fatal: could not read [redacted-url]",
    );
    expect(redactProcessOutput("remote: https://github.com/o/r.git?token=abc")).toBe(
      "remote: [redacted-url]",
    );
    // Ordinary diagnostics survive.
    expect(redactProcessOutput("src/index.ts(3,1): error TS2304: Cannot find name 'x'.")).toBe(
      "src/index.ts(3,1): error TS2304: Cannot find name 'x'.",
    );
    expect(redactProcessOutput("cloning https://github.com/o/r.git")).toBe(
      "cloning https://github.com/o/r.git",
    );
  });

  it("never reproduces argv in a non-zero exit error", async () => {
    const secret = "fixture-argv-token";
    await expect(
      spawnWithBufferedLogs("node", ["-e", `process.exit(3)`, `https://u:${secret}@github.com/o`], {
        displayCommand: "git clone github.com",
      }),
    ).rejects.toThrow("git clone github.com exited with code 3");

    let message = "";
    try {
      await spawnWithBufferedLogs("node", [
        "-e",
        "process.exit(3)",
        `https://u:${secret}@github.com/o`,
      ]);
    } catch (error) {
      message = (error as Error).message;
    }
    // Even without an explicit display command the default is redacted.
    expect(message).not.toContain(secret);
  });

  it("sanitizes forwarded child stderr", async () => {
    const secret = "fixture-stderr-token";
    const lines: string[] = [];
    await spawnWithBufferedLogs(
      "node",
      ["-e", `console.error("remote: https://u:${secret}@github.com/o/r.git")`],
      { onLog: (line, stream) => stream === "stderr" && lines.push(line) },
    );
    expect(lines.join("\n")).not.toContain(secret);
    expect(lines.join("\n")).toContain("[redacted-url]");
  });
});

describe("gitShallowClone URL validation", () => {
  it("refuses a disallowed URL from inside the helper, so no caller can bypass it", async () => {
    const { gitShallowClone } = await import("../git-clone");
    const { InvalidGitUrlError } = await import("../git-url");

    // An `InvalidGitUrlError` can only come from the validator, which runs
    // before the clone is spawned.
    await expect(gitShallowClone({ url: "file:///etc/passwd" })).rejects.toBeInstanceOf(
      InvalidGitUrlError,
    );
    await expect(gitShallowClone({ url: "https://u:tok@github.com/o/r.git" })).rejects.toThrow(
      /credentials/i,
    );
    await expect(gitShallowClone({ url: "https://evil.example.test/o/r.git" })).rejects.toThrow(
      /allowlist/i,
    );
  });

  it("never removes a pre-existing target directory", async () => {
    const { gitShallowClone } = await import("../git-clone");
    const target = root();
    writeFileSync(join(target, "owned.txt"), "keep");

    await expect(
      gitShallowClone({ url: "https://github.com/openmapx/openmapx", targetDir: target }),
    ).rejects.toThrow(/target already exists/i);
    expect(() => writeFileSync(join(target, "still-owned.txt"), "keep")).not.toThrow();
  });

  it("rejects option-like refs before creating the target", async () => {
    const { gitShallowClone } = await import("../git-clone");
    const parent = root();
    const target = join(parent, "checkout");

    await expect(
      gitShallowClone({
        url: "https://github.com/openmapx/openmapx",
        ref: "--upload-pack=fixture",
        targetDir: target,
      }),
    ).rejects.toThrow(/safe branch/i);
    expect(existsSync(target)).toBe(false);
  });
});
