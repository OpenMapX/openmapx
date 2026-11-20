import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { codeOnly } from "../../packages/core/src/__tests__/support/sourceScan";

/**
 * A test whose shared setup branches on its own name (`task.name`,
 * `currentTestName`) breaks silently when the test is renamed: the setup no
 * longer injects the fault and the test may still pass. Tests choose their
 * setup through `test.extend` fixtures or an explicit scenario instead.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TEST_FILE = /\.test\.(ts|tsx|mts|cts|js|mjs)$/;
const NAME_READ = /\.task\s*\.\s*name\b|\bcurrentTestName\b/;

function trackedTestFiles(): string[] {
  return execFileSync("git", ["ls-files", "-z"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\0")
    .filter((path) => TEST_FILE.test(path) && existsSync(resolve(REPO_ROOT, path)));
}

/** Lines of `source` whose code reads the running test's name. */
function testNameReads(source: string, fileName: string): number[] {
  if (!source.includes("currentTestName") && !/\.task\s*\.\s*name/.test(source)) return [];
  return codeOnly(source, fileName)
    .split("\n")
    .flatMap((line, index) => (NAME_READ.test(line) ? [index + 1] : []));
}

describe("test setup selection", () => {
  it("finds a name read in setup and ignores one in prose", () => {
    expect(
      testNameReads(
        [
          "beforeEach(async (context) => {",
          '  // context.task.name used to pick the fault; "expect.getState().currentTestName" too',
          '  faults = context.task.name.startsWith("consumes");',
          "  const name = expect.getState().currentTestName;",
          "});",
        ].join("\n"),
        "fixture.test.ts",
      ),
    ).toEqual([3, 4]);
  });

  it("no test chooses its setup by reading its own name", () => {
    const reads = trackedTestFiles().flatMap((path) =>
      testNameReads(readFileSync(resolve(REPO_ROOT, path), "utf8"), path).map(
        (line) => `${path}:${line}`,
      ),
    );
    expect(reads, "use test.extend fixtures or an explicit scenario instead").toEqual([]);
  });
});
