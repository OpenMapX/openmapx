import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  releaseGbfsCatalogPin,
  releaseTransitousPin,
  transitousStatePaths,
} from "@openmapx/transitous-core/pins";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createUnavailableRuntime, dispatchOpsOperation } from "./runtime";
import { createTransitousLockRuntime } from "./transitous-lock-runtime";

const roots: string[] = [];
const REF = `main@${"a".repeat(40)}`;
const OTHER_REF = `main@${"b".repeat(40)}`;

/** A checkout under umask 002 with the agent's state directory. */
function root(): string {
  const directory = mkdtempSync(join(tmpdir(), "openmapx-lock-runtime-"));
  roots.push(directory);
  mkdirSync(join(directory, "infra", "docker", "state", "ops-agent"), {
    recursive: true,
    mode: 0o700,
  });
  chmodSync(join(directory, "infra", "docker"), 0o775);
  return directory;
}

function context() {
  return {
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

const infraDir = (rootDir: string) => join(rootDir, "infra", "docker");
const state = (rootDir: string) => transitousStatePaths(infraDir(rootDir));

/** The release pin as the operation reports it. */
function releaseRecord() {
  const { ref, submodules, lockedAt, lockedBy, comment } = releaseTransitousPin();
  return { ref, submodules, lockedAt, lockedBy, ...(comment ? { comment } : {}) };
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

describe("agent-owned Transitous catalog lock", () => {
  it("reports the release's pin and no proposal, whatever the checkout holds", async () => {
    const rootDir = root();
    // Planted in the group-writable checkout: never read.
    const planted = JSON.stringify({ ref: OTHER_REF, submodules: {}, lockedAt: "", lockedBy: "x" });
    writeFileSync(join(infraDir(rootDir), "transitous.lock.json"), planted);
    writeFileSync(join(infraDir(rootDir), "transitous.lock.proposed.json"), planted);
    await expect(
      dispatchOpsOperation(runtimeFor(rootDir), { kind: "transitousLock.inspect" }, context()),
    ).resolves.toEqual({ active: releaseRecord(), proposed: null });
  });

  it("writes a proposal into its state without activating anything", async () => {
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
    expect(JSON.parse(readFileSync(state(rootDir).proposed, "utf-8"))).toMatchObject({
      ref: REF,
      lockedBy: "auto-bump",
    });
    expect(existsSync(join(infraDir(rootDir), "transitous.lock.proposed.json"))).toBe(false);
    await expect(
      dispatchOpsOperation(runtimeFor(rootDir), { kind: "transitousLock.inspect" }, context()),
    ).resolves.toMatchObject({ active: releaseRecord(), proposed: { ref: REF } });
  });

  it("activates a proposal only when the approved ref matches exactly", async () => {
    const rootDir = root();
    const runtime = runtimeFor(rootDir);
    await dispatchOpsOperation(
      runtime,
      { kind: "transitousLock.propose", ref: REF, submodules: {}, lockedBy: "auto-bump" },
      context(),
    );
    await expect(
      dispatchOpsOperation(
        runtime,
        { kind: "transitousLock.approve", ref: OTHER_REF, approvedBy: "admin" },
        context(),
      ),
    ).rejects.toThrow(/does not match/i);
    expect(existsSync(state(rootDir).approved)).toBe(false);

    const approved = await dispatchOpsOperation(
      runtime,
      { kind: "transitousLock.approve", ref: REF, approvedBy: "admin" },
      context(),
    );
    expect(approved).toEqual({ ref: REF, lockedAt: "2026-08-25T00:00:00.000Z" });
    expect(JSON.parse(readFileSync(state(rootDir).approved, "utf-8"))).toMatchObject({
      ref: REF,
      lockedBy: "admin",
      releasePin: releaseTransitousPin().ref,
    });
    expect(existsSync(state(rootDir).proposed)).toBe(false);
    await expect(
      dispatchOpsOperation(runtime, { kind: "transitousLock.inspect" }, context()),
    ).resolves.toMatchObject({ active: { ref: REF, lockedBy: "admin" }, proposed: null });
    // The tracked pin is untouched.
    expect(existsSync(join(infraDir(rootDir), "transitous.lock.json"))).toBe(false);
  });

  it("refuses to approve when there is no proposal", async () => {
    const rootDir = root();
    await expect(
      dispatchOpsOperation(
        runtimeFor(rootDir),
        { kind: "transitousLock.approve", ref: REF, approvedBy: "admin" },
        context(),
      ),
    ).rejects.toThrow(/no transitous lock proposal/i);
  });

  it("refuses a proposal another account could have written", async () => {
    const rootDir = root();
    const runtime = runtimeFor(rootDir);
    await dispatchOpsOperation(
      runtime,
      { kind: "transitousLock.propose", ref: REF, submodules: {}, lockedBy: "auto-bump" },
      context(),
    );
    chmodSync(state(rootDir).proposed, 0o666);
    await expect(
      dispatchOpsOperation(runtime, { kind: "transitousLock.inspect" }, context()),
    ).rejects.toThrow(/no group or other write/);
  });
});

describe("app-api's read-only view of the Transitous pins", () => {
  it("reports the release's pin and the pin in effect, never a proposal", async () => {
    const rootDir = root();
    const runtime = runtimeFor(rootDir);
    await expect(
      dispatchOpsOperation(runtime, { kind: "transitousPin.inspect" }, context()),
    ).resolves.toEqual({ release: releaseRecord(), active: releaseRecord() });
    await dispatchOpsOperation(
      runtime,
      { kind: "transitousLock.propose", ref: REF, submodules: {}, lockedBy: "auto-bump" },
      context(),
    );
    await expect(
      dispatchOpsOperation(runtime, { kind: "transitousPin.inspect" }, context()),
    ).resolves.toEqual({ release: releaseRecord(), active: releaseRecord() });
    await dispatchOpsOperation(
      runtime,
      { kind: "transitousLock.approve", ref: REF, approvedBy: "admin" },
      context(),
    );
    await expect(
      dispatchOpsOperation(runtime, { kind: "transitousPin.inspect" }, context()),
    ).resolves.toMatchObject({
      release: releaseRecord(),
      active: { ref: REF, lockedBy: "admin" },
    });
  });
});

describe("the release's GBFS registry pin", () => {
  it("is answered from the release, whatever the checkout holds", async () => {
    const rootDir = root();
    writeFileSync(
      join(infraDir(rootDir), "gbfs-catalog.lock.json"),
      JSON.stringify({ commit: "f".repeat(40), url: "https://example.test/systems.csv" }),
    );
    const release = releaseGbfsCatalogPin();
    await expect(
      dispatchOpsOperation(runtimeFor(rootDir), { kind: "gbfsCatalogLock.inspect" }, context()),
    ).resolves.toEqual({
      commit: release.commit,
      url: release.url,
      sha256: release.sha256,
      lockedAt: release.lockedAt,
      lockedBy: release.lockedBy,
    });
  });
});
