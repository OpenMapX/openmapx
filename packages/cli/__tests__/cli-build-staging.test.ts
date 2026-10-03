import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareStagedBuildDir, promoteStagedBuildDirs } from "../src/lib/build-staging";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "openmapx-build-staging-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function dirWith(path: string, content: string): string {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "file"), content);
  return path;
}

describe("staged build dirs", () => {
  it("clears leftover .prev and .next before a build starts", () => {
    const live = dirWith(join(tmp, "graph"), "LIVE");
    dirWith(`${live}.prev`, "STALE");
    dirWith(`${live}.next`, "STALE");

    const next = prepareStagedBuildDir(live);

    expect(existsSync(`${live}.prev`)).toBe(false);
    expect(existsSync(join(next, "file"))).toBe(false);
    expect(readFileSync(join(live, "file"), "utf-8")).toBe("LIVE");
  });

  it("swaps several dirs as one unit", () => {
    const a = dirWith(join(tmp, "a"), "OLD-A");
    const b = dirWith(join(tmp, "b"), "OLD-B");
    const swaps = [
      { liveDir: a, nextDir: dirWith(join(tmp, "a.next"), "NEW-A") },
      { liveDir: b, nextDir: dirWith(join(tmp, "b.next"), "NEW-B") },
    ];

    promoteStagedBuildDirs(swaps);

    expect(readFileSync(join(a, "file"), "utf-8")).toBe("NEW-A");
    expect(readFileSync(join(b, "file"), "utf-8")).toBe("NEW-B");
    expect(existsSync(`${a}.prev`)).toBe(false);
    expect(existsSync(`${b}.prev`)).toBe(false);
  });

  it("restores every live dir when a later swap fails", () => {
    const a = dirWith(join(tmp, "a"), "OLD-A");
    const b = dirWith(join(tmp, "b"), "OLD-B");
    const aNext = dirWith(join(tmp, "a.next"), "NEW-A");

    expect(() =>
      promoteStagedBuildDirs([
        { liveDir: a, nextDir: aNext },
        { liveDir: b, nextDir: join(tmp, "missing.next") },
      ]),
    ).toThrow();

    expect(readFileSync(join(a, "file"), "utf-8")).toBe("OLD-A");
    expect(readFileSync(join(b, "file"), "utf-8")).toBe("OLD-B");
    expect(readFileSync(join(aNext, "file"), "utf-8")).toBe("NEW-A");
  });
});
