import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const race = vi.hoisted(() => ({
  beforeRename: undefined as undefined | ((from: string) => void),
}));

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    renameSync: (from: string, to: string) => {
      race.beforeRename?.(String(from));
      race.beforeRename = undefined;
      return fs.renameSync(from, to);
    },
  };
});

const { agentStatePaths, legacyAgentStatePaths, prepareAgentStateDirectories } = await import(
  "../agent-state"
);

const roots: string[] = [];
afterEach(() => {
  race.beforeRename = undefined;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("agent state directory migration", () => {
  it("never mounts what a symlink swapped in during the move names", () => {
    const root = mkdtempSync(join(tmpdir(), "openmapx-agent-state-race-"));
    roots.push(root);
    const infraDir = join(root, "infra", "docker");
    const outside = join(root, "host-directory");
    mkdirSync(outside);
    const legacy = legacyAgentStatePaths(infraDir);
    mkdirSync(legacy.trustedConfig, { recursive: true, mode: 0o700 });
    // data-manager replaces the queue with a symlink after the check and
    // before the rename moves it.
    race.beforeRename = (from) => {
      if (from !== legacy.trustedConfig) return;
      rmSync(from, { recursive: true });
      symlinkSync(outside, from);
    };

    prepareAgentStateDirectories(infraDir);

    const current = agentStatePaths(infraDir);
    expect(lstatSync(current.trustedConfig).isSymbolicLink()).toBe(false);
    expect(lstatSync(current.trustedConfig).isDirectory()).toBe(true);
    expect(statSync(current.trustedConfig).mode & 0o777).toBe(0o700);
    expect(statSync(current.trustedConfig).ino).not.toBe(statSync(outside).ino);
    // The symlink is kept aside, unfollowed, and the outside directory untouched.
    const aside = readdirSync(current.directory).filter((name) =>
      name.startsWith("trusted-config.rejected-"),
    );
    expect(aside).toHaveLength(1);
    expect(lstatSync(join(current.directory, aside[0] as string)).isSymbolicLink()).toBe(true);
    expect(readdirSync(outside)).toEqual([]);
  });
});
