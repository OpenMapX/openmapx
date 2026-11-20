import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentStatePaths, prepareAgentStateDirectories } from "../agent-state";
import { serviceSelectionPath, writeServiceSelectionFile } from "../deployment";

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

  it("create missing directories owner-only", () => {
    const infraDir = infra();

    prepareAgentStateDirectories(infraDir);

    const current = agentStatePaths(infraDir);
    for (const directory of [current.directory, current.traefikDynamic]) {
      expect(lstatSync(directory).isDirectory()).toBe(true);
      expect(statSync(directory).mode & 0o777).toBe(0o700);
    }
  });

  it("fail when a file is where the state directory must go", () => {
    const infraDir = infra();
    mkdirSync(join(infraDir, "state"), { recursive: true });
    writeFileSync(join(infraDir, "state", "ops-agent"), "");
    expect(() => prepareAgentStateDirectories(infraDir)).toThrow();
  });
});

describe("service selection file", () => {
  it("is replaced without following a symlink at the old temporary name or its own", () => {
    const infraDir = infra();
    const sentinel = join(infraDir, "..", "sentinel");
    writeFileSync(sentinel, "untouched");
    const path = serviceSelectionPath(infraDir);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    symlinkSync(sentinel, `${path}.${process.pid}.tmp`);
    symlinkSync(sentinel, path);

    writeServiceSelectionFile(infraDir, ["postgis"]);

    expect(readFileSync(sentinel, "utf8")).toBe("untouched");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ selected: ["postgis"] });
    const written = lstatSync(path);
    expect(written.isFile()).toBe(true);
    expect(written.mode & 0o777).toBe(0o600);
  });
});
