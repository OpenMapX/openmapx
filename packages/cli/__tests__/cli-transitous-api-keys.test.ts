import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type CommandRunner,
  DEFAULT_TRANSITOUS_REPO_URL,
  generateTransitousApiKeys,
} from "../src/lib/transitous-api-keys";

let tmp: string;

function writeTransitousCatalog(catalogDir: string): void {
  mkdirSync(join(catalogDir, "feeds"), { recursive: true });
  mkdirSync(join(catalogDir, "transitland-atlas", "feeds", "nested"), { recursive: true });

  writeFileSync(
    join(catalogDir, "feeds", "us-ca.json"),
    JSON.stringify({
      sources: [
        { name: "NeedsKey", "transitland-atlas-id": "atlas-auth-1" },
        { name: "NoAuthNeeded", "transitland-atlas-id": "atlas-open" },
        { name: "AlreadyInCatalog", "transitland-atlas-id": "atlas-auth-1", "api-key": "inline" },
        { name: "CustomUrl", "transitland-atlas-id": "atlas-auth-1", "url-override": "https://x" },
      ],
    }),
    "utf-8",
  );
  writeFileSync(
    join(catalogDir, "feeds", "ca-qc.json"),
    JSON.stringify({
      sources: [{ name: "QuebecAgency", "transitland-atlas-id": "atlas-auth-2", skip: true }],
    }),
    "utf-8",
  );
  writeFileSync(
    join(catalogDir, "transitland-atlas", "feeds", "nested", "agencies.dmfr.json"),
    JSON.stringify({
      feeds: [
        { id: "atlas-auth-1", authorization: { type: "api-key" } },
        { id: "atlas-auth-2", authorization: { type: "token" } },
        { id: "atlas-open" },
      ],
    }),
    "utf-8",
  );
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "openmapx-transitous-api-keys-"));
  writeFileSync(join(tmp, "pnpm-workspace.yaml"), "packages: []\n");
  mkdirSync(join(tmp, "services"), { recursive: true });
  mkdirSync(join(tmp, "services", "motis", "tools", "transitous"), { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("generateTransitousApiKeys", () => {
  it("clones the Transitous catalog and preserves existing filled keys", async () => {
    const outputPath = join(tmp, "services", "motis", "tools", "transitous", "api-keys.json");
    writeFileSync(
      outputPath,
      JSON.stringify(
        {
          "us-ca/NeedsKey": "preserved-secret",
          "legacy/no-longer-needed": "stale-value",
        },
        null,
        2,
      ),
      "utf-8",
    );

    const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
    const runner: CommandRunner = async (command, args, opts) => {
      calls.push({ command, args, cwd: opts.cwd });
      if (command === "git" && args[0] === "clone") {
        const targetDir = args.at(-1);
        if (typeof targetDir === "string") {
          writeTransitousCatalog(targetDir);
        }
      }
    };

    const result = await generateTransitousApiKeys({ rootDir: tmp, runner });

    expect(result.requiredCount).toBe(2);
    expect(result.preservedCount).toBe(1);
    expect(result.droppedCount).toBe(1);
    expect(result.outputPath).toBe(outputPath);
    expect(JSON.parse(readFileSync(outputPath, "utf-8")) as Record<string, string>).toStrictEqual({
      "ca-qc/QuebecAgency": "",
      "us-ca/NeedsKey": "preserved-secret",
    });
    expect(calls).toEqual([
      {
        command: "git",
        args: [
          "clone",
          "--depth",
          "1",
          "--recurse-submodules",
          "--shallow-submodules",
          DEFAULT_TRANSITOUS_REPO_URL,
          join(tmp, "infra", "docker", "data", ".transitous-catalog"),
        ],
        cwd: join(tmp, "infra", "docker", "data"),
      },
    ]);
  });

  it("uses an existing cached catalog and continues when git pull fails", async () => {
    const catalogDir = join(tmp, "infra", "docker", "data", ".transitous-catalog");
    mkdirSync(join(catalogDir, ".git"), { recursive: true });
    writeTransitousCatalog(catalogDir);

    const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
    const runner: CommandRunner = async (command, args, opts) => {
      calls.push({ command, args, cwd: opts.cwd });
      if (command === "git" && args[2] === "pull") {
        throw new Error("network unavailable");
      }
    };

    const result = await generateTransitousApiKeys({ rootDir: tmp, runner });

    expect(result.requiredCount).toBe(2);
    expect(result.preservedCount).toBe(0);
    expect(result.droppedCount).toBe(0);
    const outputPath = join(tmp, "services", "motis", "tools", "transitous", "api-keys.json");
    expect(JSON.parse(readFileSync(outputPath, "utf-8")) as Record<string, string>).toStrictEqual({
      "ca-qc/QuebecAgency": "",
      "us-ca/NeedsKey": "",
    });
    expect(calls).toEqual([
      {
        command: "git",
        args: ["-C", catalogDir, "reset", "--hard", "HEAD"],
        cwd: catalogDir,
      },
      {
        command: "git",
        args: ["-C", catalogDir, "pull", "--ff-only"],
        cwd: join(tmp, "infra", "docker", "data"),
      },
      {
        command: "git",
        args: ["-C", catalogDir, "submodule", "update", "--init", "--checkout", "--depth", "1"],
        cwd: join(tmp, "infra", "docker", "data"),
      },
    ]);
  });
});
