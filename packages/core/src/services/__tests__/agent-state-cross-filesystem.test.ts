import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// The data directory as a filesystem of its own: renaming out of it fails.
const crossDevice = vi.hoisted(() => ({ prefix: "" }));

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    renameSync: (from: string, to: string) => {
      if (crossDevice.prefix && String(from).startsWith(crossDevice.prefix)) {
        throw Object.assign(new Error("EXDEV: cross-device link not permitted, rename"), {
          code: "EXDEV",
        });
      }
      return fs.renameSync(from, to);
    },
  };
});

const { agentStatePaths, legacyAgentStatePaths, prepareAgentStateDirectories } = await import(
  "../agent-state"
);

const roots: string[] = [];
afterEach(() => {
  crossDevice.prefix = "";
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function checkout() {
  const root = mkdtempSync(join(tmpdir(), "openmapx-agent-state-xfs-"));
  roots.push(root);
  const infraDir = join(root, "infra", "docker");
  crossDevice.prefix = join(infraDir, "data");
  return { infraDir, legacy: legacyAgentStatePaths(infraDir), current: agentStatePaths(infraDir) };
}

describe("agent state on a data directory of its own filesystem", () => {
  it("starts from empty owner-only directories and copies nothing", () => {
    const { infraDir, legacy, current } = checkout();
    // What the earlier release left, as on a host whose data directory is
    // its own dataset: a claimed directory and a snapshot still queued.
    mkdirSync(join(legacy.trustedConfig, ".claimed"), { recursive: true, mode: 0o700 });
    writeFileSync(join(legacy.trustedConfig, `cfg1_${"a".repeat(43)}.json`), "queued");
    mkdirSync(legacy.privacyExtraction, { recursive: true, mode: 0o700 });
    writeFileSync(join(legacy.privacyExtraction, "planted"), "data-manager");
    mkdirSync(current.directory, { recursive: true, mode: 0o700 });

    prepareAgentStateDirectories(infraDir);

    for (const directory of [current.trustedConfig, current.privacyExtraction]) {
      expect(lstatSync(directory).isDirectory()).toBe(true);
      expect(statSync(directory).mode & 0o777).toBe(0o700);
      expect(readdirSync(directory)).toEqual([]);
    }
    // The old directories stay for the containers still mounting them.
    expect(readdirSync(legacy.trustedConfig).sort()).toEqual([
      ".claimed",
      `cfg1_${"a".repeat(43)}.json`,
    ]);
    expect(readFileSync(join(legacy.privacyExtraction, "planted"), "utf8")).toBe("data-manager");

    // Later commits find the new directories and change nothing.
    writeFileSync(join(current.trustedConfig, "kept"), "");
    prepareAgentStateDirectories(infraDir);
    expect(readdirSync(current.trustedConfig)).toEqual(["kept"]);
  });

  it("still fails when something else is in the way", () => {
    const { infraDir, legacy } = checkout();
    crossDevice.prefix = "";
    mkdirSync(legacy.trustedConfig, { recursive: true });
    // A file where the new state directory must go.
    mkdirSync(join(infraDir, "state"), { recursive: true });
    writeFileSync(join(infraDir, "state", "ops-agent"), "");
    expect(() => prepareAgentStateDirectories(infraDir)).toThrow();
  });
});
