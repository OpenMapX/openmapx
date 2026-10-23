import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testExecution } from "./__fixtures__/execution";
import { createUnavailableRuntime, dispatchOpsOperation } from "./runtime";
import { createTransitousLockRuntime } from "./transitous-lock-runtime";

const roots: string[] = [];
const REF = `main@${"a".repeat(40)}`;
const OTHER_REF = `main@${"b".repeat(40)}`;

function root(): string {
  const directory = mkdtempSync(join(tmpdir(), "openmapx-lock-runtime-"));
  roots.push(directory);
  mkdirSync(join(directory, "infra", "docker"), { recursive: true });
  return directory;
}

function context() {
  return {
    execution: testExecution(),
    signal: new AbortController().signal,
    emitLog: vi.fn(),
    claim: {
      fingerprint: "f".repeat(64),
      operation: {} as never,
      source: "registry" as const,
      capability: { revisionId: "registry-v1", values: {} },
    },
  };
}

function runtimeFor(rootDir: string) {
  return createTransitousLockRuntime(createUnavailableRuntime(), {
    rootDir,
    now: () => new Date("2026-08-25T00:00:00.000Z"),
  });
}

function lockPath(rootDir: string): string {
  return join(rootDir, "infra", "docker", "transitous.lock.json");
}

function proposedPath(rootDir: string): string {
  return join(rootDir, "infra", "docker", "transitous.lock.proposed.json");
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

describe("agent-owned Transitous catalog lock", () => {
  it("reports both slots as absent on a fresh checkout", async () => {
    const rootDir = root();
    await expect(
      dispatchOpsOperation(runtimeFor(rootDir), { kind: "transitousLock.inspect" }, context()),
    ).resolves.toEqual({ active: null, proposed: null });
  });

  it("writes a proposal without activating anything", async () => {
    const rootDir = root();
    const result = await dispatchOpsOperation(
      runtimeFor(rootDir),
      {
        kind: "transitousLock.propose",
        ref: REF,
        submodules: { "transitland-atlas": "c".repeat(40) },
        lockedBy: "auto-bump",
      },
      context(),
    );

    expect(result).toEqual({ ref: REF, proposed: true });
    // A proposal must never become the active pin on its own.
    expect(existsSync(lockPath(rootDir))).toBe(false);
    expect(JSON.parse(readFileSync(proposedPath(rootDir), "utf-8"))).toMatchObject({
      ref: REF,
      lockedBy: "auto-bump",
    });
  });

  it("keeps approval closed until durable paired-pin publication is installed", async () => {
    const rootDir = root();
    const runtime = runtimeFor(rootDir);
    await dispatchOpsOperation(
      runtime,
      { kind: "transitousLock.propose", ref: REF, submodules: {}, lockedBy: "auto-bump" },
      context(),
    );
    for (const ref of [REF, OTHER_REF])
      await expect(
        dispatchOpsOperation(
          runtime,
          { kind: "transitousLock.approve", ref, approvedBy: "admin" },
          context(),
        ),
      ).rejects.toThrow(/paired-pin/);
    expect(existsSync(lockPath(rootDir))).toBe(false);
    expect(existsSync(proposedPath(rootDir))).toBe(true);
  });

  it("reads back an existing active lock", async () => {
    const rootDir = root();
    writeFileSync(
      lockPath(rootDir),
      JSON.stringify({
        ref: REF,
        submodules: { "transitland-atlas": "d".repeat(40) },
        lockedAt: "2026-01-01T00:00:00.000Z",
        lockedBy: "operator",
        comment: "pinned",
      }),
    );
    const result = (await dispatchOpsOperation(
      runtimeFor(rootDir),
      { kind: "transitousLock.inspect" },
      context(),
    )) as { active: { ref: string; comment?: string } | null };
    expect(result.active).toMatchObject({ ref: REF, lockedBy: "operator", comment: "pinned" });
  });

  it("rejects an oversized lock rather than loading it", async () => {
    const rootDir = root();
    writeFileSync(lockPath(rootDir), `{"ref":"${"x".repeat(300_000)}"}`);
    await expect(
      dispatchOpsOperation(runtimeFor(rootDir), { kind: "transitousLock.inspect" }, context()),
    ).rejects.toThrow(/too large/i);
  });
});
