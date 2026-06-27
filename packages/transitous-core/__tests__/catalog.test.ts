import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureCatalog } from "../src/catalog.js";
import type { CommandRunner } from "../src/runner.js";

let tmp: string | undefined;

afterEach(() => {
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  }
});

function recordingRunner(): {
  runner: CommandRunner;
  calls: Array<{ command: string; args: string[] }>;
} {
  const calls: Array<{ command: string; args: string[] }> = [];
  const runner: CommandRunner = async (command, args) => {
    calls.push({ command, args });
  };
  return { runner, calls };
}

describe("ensureCatalog", () => {
  it("clones with safe.directory + the -- injection guard when the catalog is absent", async () => {
    tmp = mkdtempSync(join(tmpdir(), "openmapx-catalog-clone-"));
    const catalogDir = join(tmp, ".transitous-catalog");
    const { runner, calls } = recordingRunner();

    const result = await ensureCatalog({
      dataDir: tmp,
      catalogDir,
      repoUrl: "https://example.test/transitous.git",
      runner,
    });

    expect(result).toBe(catalogDir);
    expect(calls).toEqual([
      {
        command: "git",
        args: [
          "-c",
          `safe.directory=${catalogDir}`,
          "clone",
          "--depth",
          "1",
          "--recurse-submodules",
          "--shallow-submodules",
          "--",
          "https://example.test/transitous.git",
          catalogDir,
        ],
      },
    ]);
  });

  it("pulls + updates submodules (no reset) for an existing checkout", async () => {
    tmp = mkdtempSync(join(tmpdir(), "openmapx-catalog-cached-"));
    const catalogDir = join(tmp, ".transitous-catalog");
    mkdirSync(join(catalogDir, ".git"), { recursive: true });
    const { runner, calls } = recordingRunner();

    await ensureCatalog({ dataDir: tmp, catalogDir, repoUrl: "x", runner });

    const verbs = calls.map((c) => c.args.find((a) => ["pull", "submodule", "reset"].includes(a)));
    expect(verbs).toEqual(["pull", "submodule"]);
  });

  it("resets --hard before pulling when reset is requested", async () => {
    tmp = mkdtempSync(join(tmpdir(), "openmapx-catalog-reset-"));
    const catalogDir = join(tmp, ".transitous-catalog");
    mkdirSync(join(catalogDir, ".git"), { recursive: true });
    const { runner, calls } = recordingRunner();

    await ensureCatalog({ dataDir: tmp, catalogDir, repoUrl: "x", runner, reset: true });

    const verbs = calls.map((c) => c.args.find((a) => ["pull", "submodule", "reset"].includes(a)));
    expect(verbs).toEqual(["reset", "pull", "submodule"]);
  });

  it("tolerates a failed pull and still updates submodules", async () => {
    tmp = mkdtempSync(join(tmpdir(), "openmapx-catalog-pullfail-"));
    const catalogDir = join(tmp, ".transitous-catalog");
    mkdirSync(join(catalogDir, ".git"), { recursive: true });
    const calls: string[] = [];
    const runner: CommandRunner = async (_command, args) => {
      if (args.includes("pull")) throw new Error("network down");
      calls.push(args.find((a) => a === "submodule") ?? "");
    };

    await expect(ensureCatalog({ dataDir: tmp, catalogDir, repoUrl: "x", runner })).resolves.toBe(
      catalogDir,
    );
    expect(calls).toContain("submodule");
  });
});
