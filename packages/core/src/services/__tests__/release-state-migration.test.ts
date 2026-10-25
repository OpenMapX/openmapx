import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { load } from "js-yaml";
import { afterEach, describe, expect, it } from "vitest";
import { retireLegacyConfigurationWriter } from "../configuration-ownership";
import { CURRENT_CONFIGURATION } from "../deployment";
import {
  canonicalReleaseManifest,
  parseReleaseManifest,
  type ReleaseManifest,
  renderReleaseCompose,
} from "../release-manifest";
import {
  ensureReleaseStateDirectories,
  legacyReleaseStatePaths,
  readReleaseOverlay,
  releaseStateFileProblem,
  releaseStatePaths,
} from "../release-state";
import {
  migrateLegacyReleaseState,
  releaseSelectionHold,
  supersedeLegacyReleaseOverlay,
} from "../release-state-migration";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function infra(): string {
  const root = mkdtempSync(join(tmpdir(), "openmapx-release-migration-"));
  roots.push(root);
  const infraDir = join(root, "infra", "docker");
  mkdirSync(infraDir, { recursive: true });
  return infraDir;
}

function manifestFor(release: string, digit: string): ReleaseManifest {
  return parseReleaseManifest(
    JSON.stringify({
      schemaVersion: 1,
      release,
      images: Object.fromEntries(
        [
          "api",
          "web",
          "data-manager",
          "ops-agent",
          "privacy-backup",
          "transitous-runner",
          "transitous-tools",
        ].map((name) => [name, `ghcr.io/openmapx/${name}@sha256:${digit.repeat(64)}`]),
      ),
      privacyReleaseValidation: {
        version: 1,
        sourceBuildFingerprint: digit.repeat(64),
        validatedAt: "2026-10-20T12:00:00.000Z",
        checks: { translationsConsistent: true, openApiConsistent: true, policyConsistent: true },
      },
    }),
  );
}

const digestOf = (contents: string) => createHash("sha256").update(contents).digest("hex");
const SELECTED = `287020e6c${"0".repeat(31)}`;
const RELEASES = [SELECTED, "a1", "a2", "a3", "a4", "a5", "a6"];

/**
 * The state an agent of the previous release leaves: `.ops-agent-releases` at
 * 0700 with seven 0600 manifests and its pointers, an overlay selecting one
 * of them, and its evidence beside the overlay.
 */
function productionState(infraDir: string) {
  const legacy = legacyReleaseStatePaths(infraDir);
  mkdirSync(legacy.store, { mode: 0o700 });
  const manifests = new Map<string, string>();
  RELEASES.forEach((release, index) => {
    const canonical = canonicalReleaseManifest(manifestFor(release, String(index + 1)));
    manifests.set(release, canonical);
    writeFileSync(join(legacy.store, `${release}.json`), canonical, { mode: 0o600 });
  });
  const selected = manifests.get(SELECTED) as string;
  const pointer = (releaseId: string) =>
    JSON.stringify({ releaseId, digest: digestOf(manifests.get(releaseId) as string) });
  writeFileSync(join(legacy.store, "current.json"), pointer(SELECTED), { mode: 0o600 });
  writeFileSync(join(legacy.store, "latest.json"), pointer("a6"), { mode: 0o600 });
  writeFileSync(
    join(legacy.store, "selections.json"),
    JSON.stringify({
      a6: {
        configuration: "c".repeat(64),
        ociDigest: `sha256:${"d".repeat(64)}`,
        digest: digestOf(manifests.get("a6") as string),
      },
    }),
    { mode: 0o600 },
  );
  writeLegacyOverlay(infraDir, manifestFor(SELECTED, "1"));
  expect(digestOf(selected)).toMatch(/^[a-f0-9]{64}$/);
  return { legacy, manifests };
}

/** The previous layout's overlay of `manifest` and its evidence, as its writer rendered them. */
function writeLegacyOverlay(infraDir: string, manifest: ReleaseManifest) {
  const legacy = legacyReleaseStatePaths(infraDir);
  const evidence = `${JSON.stringify(manifest.privacyReleaseValidation)}\n`;
  const name = `privacy-release-validation-${digestOf(evidence)}.json`;
  const overlay = renderReleaseCompose(manifest, infraDir).replace(
    /file: \S+/,
    `file: ../.release-evidence/${name}`,
  );
  writeFileSync(legacy.overlay, overlay, { mode: 0o600 });
  mkdirSync(legacy.evidence, { recursive: true, mode: 0o700 });
  writeFileSync(join(legacy.evidence, name), evidence, { mode: 0o444 });
  return { overlay, evidence: join(legacy.evidence, name) };
}

/** Every legacy path with its bytes and mode, to prove nothing there changed. */
function snapshot(infraDir: string): Record<string, string> {
  const legacy = legacyReleaseStatePaths(infraDir);
  const entries: Record<string, string> = {};
  for (const directory of [legacy.store, legacy.evidence]) {
    entries[directory] = `dir ${lstatSync(directory).mode}`;
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      // Opened once, without following a link, and read through the descriptor.
      let descriptor: number;
      try {
        descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ELOOP") throw error;
        entries[path] = "symlink";
        continue;
      }
      try {
        const stats = fstatSync(descriptor);
        entries[path] =
          `${stats.mode} ${stats.nlink} ${stats.isFile() ? readFileSync(descriptor, "utf8") : "dir"}`;
      } finally {
        closeSync(descriptor);
      }
    }
  }
  entries[legacy.overlay] = readFileSync(legacy.overlay, "utf8");
  return entries;
}

describe("legacy release state migration", () => {
  it("carries the production store over and renders the overlay again in the new place", async () => {
    const infraDir = infra();
    const { manifests } = productionState(infraDir);
    const before = snapshot(infraDir);

    const result = await migrateLegacyReleaseState(infraDir);

    expect(result).toEqual({
      outcome: "migrated",
      releases: [...RELEASES].sort(),
      pointers: ["current.json", "latest.json", "selections.json"],
      overlay: "regenerated",
      problems: [],
    });
    const paths = releaseStatePaths(infraDir);
    for (const [release, canonical] of manifests) {
      expect(readFileSync(join(paths.store, `${release}.json`), "utf8")).toBe(canonical);
      expect(lstatSync(join(paths.store, `${release}.json`)).nlink).toBe(1);
    }
    expect(JSON.parse(readFileSync(join(paths.store, "current.json"), "utf8")).releaseId).toBe(
      SELECTED,
    );
    for (const directory of [paths.directory, paths.store, paths.evidence]) {
      expect(lstatSync(directory).mode & 0o777).toBe(0o700);
    }
    // Rendered from the migrated manifest, never copied: its evidence lives
    // under releases/evidence and resolves from the configuration pointer.
    const overlay = readReleaseOverlay(infraDir) as string;
    expect(overlay).toBe(renderReleaseCompose(manifestFor(SELECTED, "1"), infraDir));
    const reference = (
      load(overlay) as { configs: { "privacy-release-validation": { file: string } } }
    ).configs["privacy-release-validation"].file;
    expect(reference).toMatch(/^\.\.\/\.\.\/releases\/evidence\/privacy-release-validation-/);
    const evidence = join(infraDir, CURRENT_CONFIGURATION, reference);
    expect(relative(paths.evidence, evidence)).not.toMatch(/^\.\./);
    expect(JSON.parse(readFileSync(evidence, "utf8"))).toEqual(
      manifestFor(SELECTED, "1").privacyReleaseValidation,
    );
    expect(readdirSync(paths.evidence)).toHaveLength(1);

    expect(snapshot(infraDir)).toEqual(before);
    expect(await migrateLegacyReleaseState(infraDir)).toBeNull();
    expect(snapshot(infraDir)).toEqual(before);
  });

  it("drops and reports every entry that is not plainly the agent's own", async () => {
    const infraDir = infra();
    const { legacy, manifests } = productionState(infraDir);
    const outside = join(infraDir, "outside.json");
    writeFileSync(outside, manifests.get("a1") as string, { mode: 0o600 });
    chmodSync(join(legacy.store, "a2.json"), 0o620);
    rmSync(join(legacy.store, "a3.json"));
    symlinkSync(outside, join(legacy.store, "a3.json"));
    rmSync(join(legacy.store, "a4.json"));
    linkSync(outside, join(legacy.store, "a4.json"));
    // Valid JSON of the right release, but not the bytes the store keeps.
    writeFileSync(
      join(legacy.store, "a5.json"),
      JSON.stringify(JSON.parse(manifests.get("a5") as string), null, 2),
      { mode: 0o600 },
    );
    // A manifest stored under another release's name.
    writeFileSync(join(legacy.store, "a6.json"), manifests.get("a1") as string, { mode: 0o600 });
    writeFileSync(join(legacy.store, "notes.txt"), "operator notes", { mode: 0o600 });
    writeFileSync(join(legacy.store, "a1.json.tmp-1-x"), "partial", { mode: 0o600 });
    const before = snapshot(infraDir);

    const result = await migrateLegacyReleaseState(infraDir);

    expect(result?.outcome).toBe("migrated");
    expect(result?.releases.sort()).toEqual([SELECTED, "a1"].sort());
    // latest.json and the receipt name a6, which did not come over.
    expect(result?.pointers).toEqual(["current.json"]);
    expect(result?.overlay).toBe("regenerated");
    const problems = result?.problems.join("\n") ?? "";
    for (const expected of [
      /a2\.json is writable by its group or others/,
      /a3\.json is not a regular file/,
      /a4\.json has more than one link/,
      /a5\.json is not the canonical manifest of release a5/,
      /a6\.json is not the canonical manifest of release a6/,
      /notes\.txt is not a release store entry/,
      /a1\.json\.tmp-1-x is not a release store entry/,
      /latest\.json names release a6/,
      /selections\.json names release a6/,
    ]) {
      expect(problems).toMatch(expected);
    }
    expect(readdirSync(releaseStatePaths(infraDir).store).sort()).toEqual(
      ["a1.json", `${SELECTED}.json`, "current.json"].sort(),
    );
    expect(snapshot(infraDir)).toEqual(before);
    expect(await migrateLegacyReleaseState(infraDir)).toBeNull();
  });

  it("checks pointers against the digests of the manifests they name", async () => {
    const infraDir = infra();
    const { legacy } = productionState(infraDir);
    writeFileSync(
      join(legacy.store, "current.json"),
      JSON.stringify({ releaseId: SELECTED, digest: "0".repeat(64) }),
      { mode: 0o600 },
    );
    const result = await migrateLegacyReleaseState(infraDir);
    expect(result?.pointers).toEqual(["latest.json", "selections.json"]);
    expect(result?.problems.join("\n")).toMatch(/current\.json names release 287020e6c/);
  });

  it("does not carry over an overlay whose release did not come over", async () => {
    const infraDir = infra();
    const { legacy } = productionState(infraDir);
    chmodSync(join(legacy.store, `${SELECTED}.json`), 0o660);
    const result = await migrateLegacyReleaseState(infraDir);
    expect(result?.overlay).toBe("skipped");
    expect(result?.problems.join("\n")).toMatch(
      /docker-compose\.release\.yml was not carried over/,
    );
    expect(readReleaseOverlay(infraDir)).toBeNull();
  });

  it("carries over an overlay the host CLI selected without storing its manifest", async () => {
    const infraDir = infra();
    const { legacy } = productionState(infraDir);
    // `pnpm openmapx compose release` writes the overlay and evidence only.
    const hostSelected = manifestFor("287020e6c-host-1", "9");
    const written = writeLegacyOverlay(infraDir, hostSelected);
    const result = await migrateLegacyReleaseState(infraDir);
    expect(result?.overlay).toBe("carried");
    expect(result?.problems).toEqual([]);
    expect(readReleaseOverlay(infraDir)).toBe(renderReleaseCompose(hostSelected, infraDir));
    const evidence = join(
      releaseStatePaths(infraDir).evidence,
      relative(legacy.evidence, written.evidence),
    );
    expect(readFileSync(evidence, "utf8")).toBe(readFileSync(written.evidence, "utf8"));
    expect(lstatSync(evidence).mode & 0o777).toBe(0o444);
    expect(readFileSync(legacy.overlay, "utf8")).toBe(written.overlay);
  });

  it.each(["edited", "evidence-replaced", "evidence-writable", "manifest-left-behind"] as const)(
    "refuses to carry over an overlay of a release the store lacks: %s",
    async (kind) => {
      const infraDir = infra();
      const { legacy } = productionState(infraDir);
      const hostSelected = manifestFor("287020e6c-host-1", "9");
      const written = writeLegacyOverlay(infraDir, hostSelected);
      if (kind === "edited") {
        // Pins as its metadata says, and one setting more.
        writeFileSync(
          legacy.overlay,
          written.overlay.replace(
            "  app-api:\n    image: ",
            "  app-api:\n    privileged: true\n    image: ",
          ),
          { mode: 0o600 },
        );
      }
      if (kind === "evidence-replaced") {
        // Well-formed evidence, but not what the file's name is the digest of.
        chmodSync(written.evidence, 0o644);
        writeFileSync(
          written.evidence,
          `${JSON.stringify({ ...hostSelected.privacyReleaseValidation, validatedAt: "2026-10-21T12:00:00.000Z" })}\n`,
        );
        chmodSync(written.evidence, 0o444);
      }
      if (kind === "evidence-writable") chmodSync(written.evidence, 0o666);
      if (kind === "manifest-left-behind") {
        writeFileSync(
          join(legacy.store, `${hostSelected.release}.json`),
          canonicalReleaseManifest(hostSelected),
          { mode: 0o600 },
        );
        chmodSync(join(legacy.store, `${hostSelected.release}.json`), 0o660);
      }
      const result = await migrateLegacyReleaseState(infraDir);
      expect(result?.overlay).toBe("skipped");
      expect(result?.problems.join("\n")).toMatch(
        /docker-compose\.release\.yml was not carried over/,
      );
      expect(readReleaseOverlay(infraDir)).toBeNull();
    },
  );

  it.each(["group-writable", "symlinked", "digest-mismatching"] as const)(
    "does not render a %s legacy overlay again",
    async (kind) => {
      const infraDir = infra();
      const { legacy } = productionState(infraDir);
      if (kind === "group-writable") chmodSync(legacy.overlay, 0o620);
      if (kind === "symlinked") {
        const target = join(infraDir, "elsewhere.yml");
        writeFileSync(target, readFileSync(legacy.overlay, "utf8"), { mode: 0o600 });
        rmSync(legacy.overlay);
        symlinkSync(target, legacy.overlay);
      }
      if (kind === "digest-mismatching") {
        writeFileSync(
          legacy.overlay,
          readFileSync(legacy.overlay, "utf8").replace(
            /"digest":"[a-f0-9]{64}"/,
            `"digest":"${"0".repeat(64)}"`,
          ),
          { mode: 0o600 },
        );
      }
      const result = await migrateLegacyReleaseState(infraDir);
      expect(result?.overlay).toBe("skipped");
      expect(result?.releases).toHaveLength(RELEASES.length);
      expect(readReleaseOverlay(infraDir)).toBeNull();
    },
  );

  it("keeps an overlay the new location already has", async () => {
    const infraDir = infra();
    productionState(infraDir);
    const { overlay } = ensureReleaseStateDirectories(infraDir);
    writeFileSync(overlay, "selected meanwhile\n", { mode: 0o600 });
    expect((await migrateLegacyReleaseState(infraDir))?.overlay).toBe("kept");
    expect(readFileSync(overlay, "utf8")).toBe("selected meanwhile\n");
  });

  it("refuses to migrate while the previous agent's update is unfinished", async () => {
    const infraDir = infra();
    const { legacy } = productionState(infraDir);
    writeFileSync(join(legacy.store, "transaction.json"), '{"phase":"overlay_written"}', {
      mode: 0o600,
    });
    const before = snapshot(infraDir);
    const refused = await migrateLegacyReleaseState(infraDir);
    expect(refused).toMatchObject({ outcome: "refused", releases: [], overlay: "skipped" });
    expect(refused?.problems.join("\n")).toMatch(/transaction\.json: a release update/);
    expect(readdirSync(releaseStatePaths(infraDir).store)).toEqual([]);
    expect(readReleaseOverlay(infraDir)).toBeNull();
    expect(snapshot(infraDir)).toEqual(before);

    // Once that agent has recovered it, the next start migrates.
    rmSync(join(legacy.store, "transaction.json"));
    expect((await migrateLegacyReleaseState(infraDir))?.outcome).toBe("migrated");
  });

  it("finishes a migration that stopped midway", async () => {
    const infraDir = infra();
    const { legacy, manifests } = productionState(infraDir);
    const paths = ensureReleaseStateDirectories(infraDir);
    // A run that copied one manifest before it was interrupted.
    writeFileSync(join(paths.store, "a1.json"), manifests.get("a1") as string, { mode: 0o600 });
    writeFileSync(
      join(paths.directory, "legacy-migration.json"),
      JSON.stringify({ version: 1, state: "started" }),
      { mode: 0o600 },
    );
    const result = await migrateLegacyReleaseState(infraDir);
    expect(result).toMatchObject({ outcome: "migrated", overlay: "regenerated", problems: [] });
    expect(readdirSync(paths.store).filter((name) => name !== "current.json")).toHaveLength(
      RELEASES.length + 2,
    );
    expect(readdirSync(legacy.store)).toHaveLength(RELEASES.length + 3);
    expect(await migrateLegacyReleaseState(infraDir)).toBeNull();
  });

  it("leaves a store that already holds releases alone", async () => {
    const infraDir = infra();
    const { manifests } = productionState(infraDir);
    const paths = ensureReleaseStateDirectories(infraDir);
    writeFileSync(join(paths.store, "a1.json"), manifests.get("a1") as string, { mode: 0o600 });
    expect(await migrateLegacyReleaseState(infraDir)).toBeNull();
    expect(readdirSync(paths.store)).toEqual(["a1.json"]);
  });

  it("does nothing without an earlier release's store or overlay", async () => {
    const infraDir = infra();
    expect(await migrateLegacyReleaseState(infraDir)).toBeNull();
    expect(releaseSelectionHold(infraDir)).toBeNull();
  });

  it("carries the host's overlay over where no agent ever kept a store", async () => {
    const infraDir = infra();
    const hostSelected = manifestFor("287020e6c-host-1", "9");
    writeLegacyOverlay(infraDir, hostSelected);
    const result = await migrateLegacyReleaseState(infraDir);
    expect(result).toMatchObject({ outcome: "migrated", overlay: "carried", problems: [] });
    expect(readReleaseOverlay(infraDir)).toBe(renderReleaseCompose(hostSelected, infraDir));
    expect(releaseSelectionHold(infraDir)).toBeNull();
    expect(await migrateLegacyReleaseState(infraDir)).toBeNull();
  });

  it("does not wait for the old store's lock once no earlier agent can run", async () => {
    const infraDir = infra();
    const { legacy } = productionState(infraDir);
    mkdirSync(join(legacy.store, ".release-store.lock"), { mode: 0o700 });
    writeFileSync(
      join(legacy.store, ".release-store.lock", "owner.json"),
      JSON.stringify({ pid: 1, nonce: "held", acquiredAtMs: Date.now() }),
      { mode: 0o600 },
    );
    ensureReleaseStateDirectories(infraDir);
    retireLegacyConfigurationWriter(infraDir);
    expect((await migrateLegacyReleaseState(infraDir))?.outcome).toBe("migrated");
  });

  it("refuses an old store that is not the agent's own, and copies nothing", async () => {
    const infraDir = infra();
    const { legacy } = productionState(infraDir);
    chmodSync(legacy.store, 0o770);
    const result = await migrateLegacyReleaseState(infraDir);
    expect(result).toMatchObject({ outcome: "refused", releases: [] });
    expect(readdirSync(releaseStatePaths(infraDir).store)).toEqual([]);
    chmodSync(legacy.store, 0o700);
  });

  it("refuses release state directories of another user, never repairing them", async () => {
    const infraDir = infra();
    productionState(infraDir);
    const before = snapshot(infraDir);
    // Tests cannot chown: the uid the state must belong to is injected instead.
    const foreign = (process.geteuid?.() ?? 0) + 1;
    await expect(migrateLegacyReleaseState(infraDir, { uid: foreign })).rejects.toThrow(
      /Unsafe release state directory/,
    );
    // The first directory it created is refused before anything is copied.
    expect(readdirSync(releaseStatePaths(infraDir).directory)).toEqual([]);
    expect(snapshot(infraDir)).toEqual(before);
  });

  it("never changes the mode of an existing release state directory", async () => {
    const infraDir = infra();
    productionState(infraDir);
    const paths = releaseStatePaths(infraDir);
    mkdirSync(paths.store, { recursive: true, mode: 0o700 });
    chmodSync(paths.directory, 0o750);
    await expect(migrateLegacyReleaseState(infraDir)).rejects.toThrow(
      /Unsafe release state directory/,
    );
    expect(lstatSync(paths.directory).mode & 0o777).toBe(0o750);
  });
});

describe("holding automatic release selection", () => {
  it("holds it while the earlier selection did not come over, until one is chosen", async () => {
    const infraDir = infra();
    const { legacy } = productionState(infraDir);
    chmodSync(join(legacy.store, `${SELECTED}.json`), 0o660);
    expect((await migrateLegacyReleaseState(infraDir))?.overlay).toBe("skipped");
    const held = releaseSelectionHold(infraDir) ?? "";
    expect(held).toContain(`The release the earlier release selected, ${SELECTED},`);
    expect(held).toContain("its release's manifest did not come over");
    expect(held).toContain("pnpm openmapx compose release");
    // `compose release` (or `--clear`) decides.
    supersedeLegacyReleaseOverlay(infraDir);
    expect(releaseSelectionHold(infraDir)).toBeNull();
  });

  it("holds it while the previous agent's update is unfinished, until it finishes", async () => {
    const infraDir = infra();
    const { legacy } = productionState(infraDir);
    writeFileSync(join(legacy.store, "transaction.json"), '{"phase":"overlay_written"}', {
      mode: 0o600,
    });
    expect((await migrateLegacyReleaseState(infraDir))?.outcome).toBe("refused");
    const held = releaseSelectionHold(infraDir) ?? "";
    expect(held).toContain("the previous agent's release update is unfinished");
    expect(held).toContain("Let the previous agent finish its update");
    expect(held).toContain("pnpm openmapx compose release");
    // That agent finished: the next start carries the overlay over.
    rmSync(join(legacy.store, "transaction.json"));
    expect((await migrateLegacyReleaseState(infraDir))?.overlay).toBe("regenerated");
    expect(releaseSelectionHold(infraDir)).toBeNull();
  });

  it("holds it before the migration has run, and never once the selection came over", async () => {
    const infraDir = infra();
    productionState(infraDir);
    expect(releaseSelectionHold(infraDir)).toContain("the migration has not run yet");
    await migrateLegacyReleaseState(infraDir);
    expect(releaseSelectionHold(infraDir)).toBeNull();
    // An explicit clear afterwards leaves automatic selection to the operator's choice.
    rmSync(releaseStatePaths(infraDir).overlay);
    supersedeLegacyReleaseOverlay(infraDir);
    expect(releaseSelectionHold(infraDir)).toBeNull();
  });
});

describe("release state file checks", () => {
  const file = {
    isFile: () => true,
    isSymbolicLink: () => false,
    nlink: 1,
    uid: 1000,
    mode: 0o100600,
    size: 10,
  };
  it("accepts a private regular file of the state's uid", () => {
    expect(releaseStateFileProblem(file, 100, { uid: 1000 })).toBeNull();
    expect(releaseStateFileProblem({ ...file, mode: 0o100644 }, 100, { uid: 1000 })).toBeNull();
  });
  it.each([
    [{ uid: 1001 }, /owned by uid 1001, not 1000/],
    [{ mode: 0o100620 }, /group or others/],
    [{ mode: 0o100602 }, /group or others/],
    [{ nlink: 2 }, /more than one link/],
    [{ isSymbolicLink: () => true }, /not a regular file/],
    [{ size: 101 }, /larger than 100 bytes/],
  ])("refuses %o", (change, problem) => {
    expect(releaseStateFileProblem({ ...file, ...change }, 100, { uid: 1000 })).toMatch(problem);
  });
});
