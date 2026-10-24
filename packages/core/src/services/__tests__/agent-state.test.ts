import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  agentStatePaths,
  legacyAgentStatePaths,
  prepareAgentStateDirectories,
} from "../agent-state";
import { writeServiceSelectionFile } from "../deployment";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function infra(): string {
  const root = mkdtempSync(join(tmpdir(), "openmapx-agent-state-"));
  roots.push(root);
  const infraDir = join(root, "infra", "docker");
  mkdirSync(infraDir, { recursive: true });
  return infraDir;
}

describe("agent state directories", () => {
  it("keep the agent's state out of the data directory data-manager mounts", () => {
    const infraDir = infra();
    const current = agentStatePaths(infraDir);
    for (const path of Object.values(current)) {
      expect(path.startsWith(`${join(infraDir, "data")}/`)).toBe(false);
      expect(path.startsWith(`${join(infraDir, "state", "ops-agent")}`)).toBe(true);
    }
  });

  it("move an earlier release's mounted directories, keeping each one's identity", () => {
    const infraDir = infra();
    const legacy = legacyAgentStatePaths(infraDir);
    mkdirSync(legacy.trustedConfig, { recursive: true, mode: 0o700 });
    mkdirSync(legacy.privacyExtraction, { recursive: true, mode: 0o700 });
    writeFileSync(join(legacy.trustedConfig, "queued-snapshot"), "sealed");
    const trustedConfig = statSync(legacy.trustedConfig).ino;
    const privacyExtraction = statSync(legacy.privacyExtraction).ino;

    prepareAgentStateDirectories(infraDir);

    const current = agentStatePaths(infraDir);
    // A container still mounting the old path sees the same directory.
    expect(statSync(current.trustedConfig).ino).toBe(trustedConfig);
    expect(statSync(current.privacyExtraction).ino).toBe(privacyExtraction);
    expect(readFileSync(join(current.trustedConfig, "queued-snapshot"), "utf8")).toBe("sealed");
    expect(() => lstatSync(legacy.trustedConfig)).toThrow();
    expect(() => lstatSync(legacy.privacyExtraction)).toThrow();
    expect(statSync(current.directory).mode & 0o777).toBe(0o700);

    // Later generations find them in place and change nothing.
    prepareAgentStateDirectories(infraDir);
    expect(statSync(current.trustedConfig).ino).toBe(trustedConfig);
  });

  it("create missing directories owner-only and never move a planted symlink", () => {
    const infraDir = infra();
    const legacy = legacyAgentStatePaths(infraDir);
    const outside = join(infraDir, "..", "outside");
    mkdirSync(outside);
    mkdirSync(legacy.directory, { recursive: true });
    symlinkSync(outside, legacy.trustedConfig);

    prepareAgentStateDirectories(infraDir);

    const current = agentStatePaths(infraDir);
    expect(lstatSync(current.trustedConfig).isSymbolicLink()).toBe(false);
    expect(statSync(current.trustedConfig).mode & 0o777).toBe(0o700);
    expect(statSync(current.privacyExtraction).mode & 0o777).toBe(0o700);
    expect(lstatSync(legacy.trustedConfig).isSymbolicLink()).toBe(true);
  });

  it("leave both alone when the new directory already exists", () => {
    const infraDir = infra();
    const legacy = legacyAgentStatePaths(infraDir);
    const current = agentStatePaths(infraDir);
    mkdirSync(legacy.trustedConfig, { recursive: true });
    mkdirSync(current.trustedConfig, { recursive: true });
    writeFileSync(join(current.trustedConfig, "current"), "kept");
    prepareAgentStateDirectories(infraDir);
    expect(readdirSync(current.trustedConfig)).toEqual(["current"]);
    expect(lstatSync(legacy.trustedConfig).isDirectory()).toBe(true);
  });
});

describe("service selection file", () => {
  it("is replaced without following a symlink at the old temporary name or its own", () => {
    const infraDir = infra();
    const sentinel = join(infraDir, "..", "sentinel");
    writeFileSync(sentinel, "untouched");
    const path = join(infraDir, "service-selection.json");
    symlinkSync(sentinel, `${path}.${process.pid}.tmp`);
    symlinkSync(sentinel, path);

    writeServiceSelectionFile(infraDir, ["postgis"]);

    expect(readFileSync(sentinel, "utf8")).toBe("untouched");
    expect(lstatSync(path).isFile()).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ selected: ["postgis"] });
    expect(statSync(path).mode & 0o777).toBe(0o644);
  });
});
