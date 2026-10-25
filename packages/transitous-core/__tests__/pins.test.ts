import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  decodeGbfsCatalogLock,
  decodeTransitousLock,
  MOBILITYDATA_GBFS_CATALOG_COMMIT,
} from "../src/index.js";
import {
  activeTransitousPin,
  approveTransitousProposal,
  readTransitousApproval,
  readTransitousProposal,
  releaseGbfsCatalogPin,
  releaseTransitousPin,
  retireStaleTransitousApproval,
  transitousStatePaths,
  writeTransitousProposal,
} from "../src/pins.js";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const tracked = (name: string) =>
  JSON.parse(readFileSync(join(ROOT, "infra", "docker", name), "utf8")) as unknown;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** `infra/docker` of a checkout under umask 002, with the agent's state directory. */
function infra(): string {
  const root = mkdtempSync(join(tmpdir(), "openmapx-transitous-pins-"));
  roots.push(root);
  const infraDir = join(root, "infra", "docker");
  mkdirSync(join(infraDir, "state", "ops-agent"), { recursive: true, mode: 0o700 });
  chmodSync(infraDir, 0o775);
  return infraDir;
}

const CANDIDATE = {
  ref: `main@${"c".repeat(40)}`,
  submodules: { "transitland-atlas": "d".repeat(40) },
  lockedAt: "2026-10-25T00:00:00.000Z",
  lockedBy: "auto-bump",
};

describe("the release's catalog pins", () => {
  it("are the repository's tracked pins, run from source", () => {
    expect(releaseTransitousPin()).toEqual(decodeTransitousLock(tracked("transitous.lock.json")));
    expect(releaseGbfsCatalogPin()).toEqual(
      decodeGbfsCatalogLock(tracked("gbfs-catalog.lock.json")),
    );
    expect(releaseGbfsCatalogPin().commit).toBe(MOBILITYDATA_GBFS_CATALOG_COMMIT);
  });
});

describe("the Transitous pin in effect", () => {
  it("is the release's until a proposal is approved over it", () => {
    const infraDir = infra();
    // A pin planted in the group-writable checkout is never read.
    writeFileSync(join(infraDir, "transitous.lock.json"), JSON.stringify(CANDIDATE));
    writeFileSync(join(infraDir, "transitous.lock.proposed.json"), JSON.stringify(CANDIDATE));
    expect(activeTransitousPin(infraDir)).toEqual(releaseTransitousPin());
    expect(readTransitousProposal(infraDir)).toBeNull();

    writeTransitousProposal(infraDir, CANDIDATE);
    const paths = transitousStatePaths(infraDir);
    expect(statSync(paths.directory).mode & 0o777).toBe(0o700);
    expect(statSync(paths.proposed).mode & 0o777).toBe(0o600);
    expect(readTransitousProposal(infraDir)).toEqual(CANDIDATE);
    // Proposing activates nothing.
    expect(activeTransitousPin(infraDir)).toEqual(releaseTransitousPin());

    expect(() =>
      approveTransitousProposal(infraDir, { ref: `main@${"e".repeat(40)}`, approvedBy: "admin" }),
    ).toThrow(/does not match/);
    const approval = approveTransitousProposal(infraDir, {
      ref: CANDIDATE.ref,
      approvedBy: "admin",
      now: () => new Date("2026-10-25T12:00:00.000Z"),
    });
    expect(approval).toMatchObject({
      ref: CANDIDATE.ref,
      lockedBy: "admin",
      lockedAt: "2026-10-25T12:00:00.000Z",
      releasePin: releaseTransitousPin().ref,
    });
    expect(readTransitousProposal(infraDir)).toBeNull();
    expect(activeTransitousPin(infraDir)).toMatchObject({ ref: CANDIDATE.ref, lockedBy: "admin" });
    expect(activeTransitousPin(infraDir)).not.toHaveProperty("releasePin");
    expect(() =>
      approveTransitousProposal(infraDir, { ref: CANDIDATE.ref, approvedBy: "admin" }),
    ).toThrow(/No Transitous lock proposal/);
    expect(retireStaleTransitousApproval(infraDir)).toBeNull();
  });

  it("is the release's again once a release ships a different pin, and the approval retires", () => {
    const infraDir = infra();
    writeTransitousProposal(infraDir, CANDIDATE);
    approveTransitousProposal(infraDir, { ref: CANDIDATE.ref, approvedBy: "auto-bump" });
    // As approved under an earlier release, whose pin was another one.
    const paths = transitousStatePaths(infraDir);
    const approved = JSON.parse(readFileSync(paths.approved, "utf8"));
    writeFileSync(
      `${paths.approved}.next`,
      JSON.stringify({ ...approved, releasePin: `main@${"0".repeat(40)}` }),
      { mode: 0o600 },
    );
    renameSync(`${paths.approved}.next`, paths.approved);

    expect(activeTransitousPin(infraDir)).toEqual(releaseTransitousPin());
    const retired = retireStaleTransitousApproval(infraDir);
    expect(retired?.approval).toMatchObject({
      ref: CANDIDATE.ref,
      releasePin: `main@${"0".repeat(40)}`,
    });
    expect(retired?.release).toEqual(releaseTransitousPin());
    expect(existsSync(paths.approved)).toBe(false);
    expect(retireStaleTransitousApproval(infraDir)).toBeNull();
  });

  it("refuses state another account could have written, and repairs nothing", () => {
    const infraDir = infra();
    writeTransitousProposal(infraDir, CANDIDATE);
    const paths = transitousStatePaths(infraDir);
    chmodSync(paths.proposed, 0o664);
    expect(() => readTransitousProposal(infraDir)).toThrow(/no group or other write/);
    expect(statSync(paths.proposed).mode & 0o777).toBe(0o664);

    chmodSync(paths.proposed, 0o600);
    symlinkSync(paths.proposed, paths.approved);
    expect(() => readTransitousApproval(infraDir)).toThrow(/not a symbolic link/);
    expect(() => activeTransitousPin(infraDir)).toThrow();
    rmSync(paths.approved);

    chmodSync(paths.directory, 0o770);
    expect(() => readTransitousProposal(infraDir)).toThrow(/cannot reach/);
    expect(() => writeTransitousProposal(infraDir, CANDIDATE)).toThrow(/cannot reach/);
    expect(statSync(paths.directory).mode & 0o777).toBe(0o770);
  });
});
