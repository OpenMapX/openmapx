import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { monitorPosixProcessGroup } from "../posix-process-group";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("POSIX process-group containment", () => {
  it("settles an ordinary detached child only after its process group is gone", async () => {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const group = monitorPosixProcessGroup(child, { killGraceMs: 50, pollIntervalMs: 10 });

    await expect(group.closed).resolves.toMatchObject({
      code: 0,
      signal: null,
      residualDescendants: false,
      spawnFailed: false,
    });
  });

  it("kills a TERM-ignoring grandchild before a late side effect and only then settles", async () => {
    const root = mkdtempSync(join(tmpdir(), "openmapx-process-group-"));
    roots.push(root);
    const marker = join(root, "late-side-effect");
    const grandchildScript = [
      'const { writeFileSync } = require("node:fs")',
      'process.on("SIGTERM", () => {})',
      `setTimeout(() => writeFileSync(${JSON.stringify(marker)}, "late"), 500)`,
      "setInterval(() => {}, 1000)",
    ].join(";");
    const parentScript = [
      'const { spawn } = require("node:child_process")',
      `spawn(process.execPath, ["-e", ${JSON.stringify(grandchildScript)}], { stdio: "ignore" })`,
      "setTimeout(() => process.exit(0), 50)",
    ].join(";");
    const child = spawn(process.execPath, ["-e", parentScript], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const group = monitorPosixProcessGroup(child, { killGraceMs: 50, pollIntervalMs: 10 });

    await expect(group.closed).resolves.toMatchObject({
      code: 0,
      signal: null,
      residualDescendants: true,
      spawnFailed: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 550));
    expect(existsSync(marker)).toBe(false);
  });
});
