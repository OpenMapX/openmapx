import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { services } from "@openmapx/core/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { releaseProvenance } from "../../core/src/services/__fixtures__/release-provenance";
import {
  clearReleaseSelection,
  ensureReleaseOverlay,
  type ReleaseDockerRunner,
  type ReleaseManifest,
  selectRelease,
  writeReleaseOverlay,
} from "../src/lib/release";

const digest = (letter: string) => `sha256:${letter.repeat(64)}`;
const containerId = "a".repeat(64);
const runningImage = digest("b");
const roots: string[] = [];

function manifest(release: string, dmDigest = "c"): ReleaseManifest {
  return {
    schemaVersion: 1,
    release,
    images: Object.fromEntries(
      services.RELEASE_IMAGE_NAMES.map((name) => [
        name,
        `ghcr.io/openmapx/${name}@${digest(name === "data-manager" ? dmDigest : "d")}`,
      ]),
    ) as ReleaseManifest["images"],
    privacyReleaseValidation: {
      version: 1,
      sourceBuildFingerprint: "e".repeat(64),
      validatedAt: "2026-11-06T00:00:00.000Z",
      checks: {
        translationsConsistent: true,
        openApiConsistent: true,
        policyConsistent: true,
      },
    },
    ...releaseProvenance(),
  };
}

function fixture() {
  const infraDir = mkdtempSync(join(tmpdir(), "openmapx-release-coordinator-"));
  roots.push(infraDir);
  const before = manifest("before");
  writeReleaseOverlay(before, { infraDir });
  const paths = services.releaseStatePaths(infraDir);
  services.ensureReleaseStateDirectory(paths.store);
  const overlay = readFileSync(paths.overlay, "utf8");
  const evidence = () =>
    readdirSync(paths.evidence)
      .sort()
      .map((name) => [name, readFileSync(join(paths.evidence, name), "utf8")]);
  const originalEvidence = evidence();
  return { infraDir, before, paths, overlay, evidence, originalEvidence };
}

function dockerFixture(
  candidate: ReleaseManifest,
  options: {
    ids?: string[];
    reference?: string;
    imageId?: string;
    cachedImageId?: string;
    listFailure?: boolean;
    malformedInspect?: boolean;
    onInspect?: () => void;
  } = {},
): ReleaseDockerRunner {
  return vi.fn(async (args) => {
    const ok = (stdout = "") => ({ stdout, stderr: "", exitCode: 0 });
    if (args[0] === "container" && args[1] === "ls") {
      expect(args).toEqual([
        "container",
        "ls",
        "--all",
        "--no-trunc",
        "--filter",
        `label=com.docker.compose.project=${services.STACK_PROJECT}`,
        "--filter",
        "label=com.docker.compose.service=data-manager",
        "--format",
        "{{.ID}}",
      ]);
      return options.listFailure
        ? { exitCode: 1, stdout: "", stderr: "Docker unavailable" }
        : ok((options.ids ?? [containerId]).join("\n"));
    }
    if (args[0] === "container" && args[1] === "inspect") {
      expect(args.at(-1)).toBe(containerId);
      expect(args[2]).toBe("--format");
      expect(args[3]).toContain(".Config.Image");
      expect(args[3]).not.toContain(".Config.Env");
      options.onInspect?.();
      return ok(
        options.malformedInspect
          ? "invalid JSON"
          : JSON.stringify({
              Id: containerId,
              Image: options.imageId ?? runningImage,
              ConfigImage: options.reference ?? manifest("before").images["data-manager"],
            }),
      );
    }
    if (args.join(" ") === `pull ghcr.io/openmapx/release-manifest:main`)
      return ok(`Digest: ${digest("1")}`);
    if (
      args.join(" ") ===
      `image inspect --format {{.Id}} ghcr.io/openmapx/release-manifest@${digest("1")}`
    )
      return ok(digest("2"));
    if (args.join(" ") === `image inspect --format {{.Id}} ${candidate.images["data-manager"]}`)
      return ok(options.cachedImageId ?? runningImage);
    if (args.join(" ") === `create ${digest("2")} true`) return ok("f".repeat(64));
    if (args[0] === "cp" && args[1] === `${"f".repeat(64)}:/release-manifest.json`) {
      const destination = args[2];
      if (!destination) throw Error("Manifest destination is missing");
      writeFileSync(destination, JSON.stringify(candidate), { mode: 0o600 });
      return ok();
    }
    if (args.join(" ") === `pull ${candidate.images["privacy-backup"]}`) return ok();
    if (args.join(" ") === `rm -f ${"f".repeat(64)}`) return ok();
    throw Error(`Unexpected Docker command: ${JSON.stringify(args)}`);
  });
}

beforeEach(() => vi.stubEnv("OPENMAPX_RELEASE", "main"));
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("coordinator-safe release selection", () => {
  it("preserves the live pin and privacy evidence when the candidate changes Data Manager", async () => {
    const f = fixture();
    const next = manifest("after", "0");
    await expect(
      selectRelease({
        infraDir: f.infraDir,
        resolve: async () => next,
        docker: dockerFixture(next),
      }),
    ).rejects.toThrow(/coordinator|Data Manager/i);
    expect(readFileSync(f.paths.overlay, "utf8")).toBe(f.overlay);
    expect(f.evidence()).toEqual(f.originalEvidence);
  });

  it.each([
    { ids: [containerId, "c".repeat(64)] },
    { ids: ["malformed-id"] },
    { listFailure: true },
    { malformedInspect: true },
    { cachedImageId: digest("0") },
  ])("refuses an ambiguous or unreadable coordinator (%j)", async (observation) => {
    const f = fixture();
    const next = manifest("after");
    await expect(
      selectRelease({
        infraDir: f.infraDir,
        resolve: async () => next,
        docker: dockerFixture(next, observation),
      }),
    ).rejects.toThrow();
    expect(readFileSync(f.paths.overlay, "utf8")).toBe(f.overlay);
  });

  it.each([{ ids: [] }, { ids: [containerId] }])(
    "permits bootstrap or the exact running pin (%j)",
    async ({ ids }) => {
      const f = fixture();
      const next = manifest("after");
      await expect(
        selectRelease({
          infraDir: f.infraDir,
          resolve: async () => next,
          docker: dockerFixture(next, { ids }),
        }),
      ).resolves.toMatchObject({ release: "after" });
    },
  );

  it("can restore the immutable pin of the actual container after an unsafe reselection", async () => {
    const f = fixture();
    writeReleaseOverlay(manifest("mismatched", "0"), { infraDir: f.infraDir });
    await selectRelease({
      infraDir: f.infraDir,
      resolve: async () => f.before,
      docker: dockerFixture(f.before),
    });
    expect(readFileSync(f.paths.overlay, "utf8")).toBe(f.overlay);
  });
});

describe("automatic selection and clearing", () => {
  it.each([{ reference: manifest("after", "0").images["data-manager"] }, { listFailure: true }])(
    "reports coordinator refusal as held without publishing automatic pins (%j)",
    async (observation) => {
      const f = fixture();
      unlinkSync(f.paths.overlay);
      const result = await ensureReleaseOverlay({
        infraDir: f.infraDir,
        docker: dockerFixture(f.before, observation),
      });
      expect(result.status).toBe("held");
      expect(existsSync(f.paths.overlay)).toBe(false);
      expect(f.evidence()).toEqual(f.originalEvidence);
    },
  );

  it("does not publish automatic pins while another process owns the release store", async () => {
    const f = fixture();
    unlinkSync(f.paths.overlay);
    const lock = await services.acquireReleaseStoreLock(f.paths.store, {}, { failIfBusy: true });
    try {
      const result = await ensureReleaseOverlay({
        infraDir: f.infraDir,
        docker: dockerFixture(f.before, { ids: [] }),
      });
      expect(result.status).toBe("held");
      expect(existsSync(f.paths.overlay)).toBe(false);
    } finally {
      lock.release();
    }
  });

  it("uses the lifecycle's actual held release lock without reacquiring it", async () => {
    const f = fixture();
    unlinkSync(f.paths.overlay);
    const releaseStoreLock = await services.acquireReleaseStoreLock(
      f.paths.store,
      {},
      { failIfBusy: true },
    );
    try {
      const result = await ensureReleaseOverlay({
        infraDir: f.infraDir,
        releaseStoreLock,
        docker: dockerFixture(f.before, { ids: [] }),
      });
      expect(result.status).toBe("resolved");
      expect(readFileSync(f.paths.overlay, "utf8")).toBe(f.overlay);
    } finally {
      releaseStoreLock.release();
    }
  });

  it("keeps the overlay needed by an existing pinned coordinator", async () => {
    const f = fixture();
    await expect(
      clearReleaseSelection({ infraDir: f.infraDir, docker: dockerFixture(f.before) }),
    ).rejects.toThrow(/coordinator|Data Manager/i);
    expect(readFileSync(f.paths.overlay, "utf8")).toBe(f.overlay);
  });

  it.each(["malformed", "mismatched"])(
    "can clear an already %s overlay for recovery",
    async (kind) => {
      const f = fixture();
      if (kind === "malformed") writeFileSync(f.paths.overlay, "services: [", { mode: 0o600 });
      const docker = dockerFixture(f.before, {
        reference: manifest("other", "0").images["data-manager"],
      });
      await expect(clearReleaseSelection({ infraDir: f.infraDir, docker })).resolves.toMatchObject({
        cleared: true,
      });
      expect(existsSync(f.paths.overlay)).toBe(false);
    },
  );

  it("does not clear a different selection published after the guarded observation", async () => {
    const f = fixture();
    const newer = manifest("concurrent", "0");
    const docker = dockerFixture(f.before, {
      reference: newer.images["data-manager"],
      onInspect: () => writeReleaseOverlay(newer, { infraDir: f.infraDir }),
    });
    await expect(clearReleaseSelection({ infraDir: f.infraDir, docker })).rejects.toThrow(
      /changed/i,
    );
    expect(
      services.parseReleaseComposeSelection(readFileSync(f.paths.overlay, "utf8")).release,
    ).toBe("concurrent");
  });

  it("does not replace malformed-overlay recovery with deletion of a newly valid selection", async () => {
    const f = fixture();
    writeFileSync(f.paths.overlay, "services: [", { mode: 0o600 });
    const pending = clearReleaseSelection({
      infraDir: f.infraDir,
      docker: dockerFixture(f.before),
    });
    writeReleaseOverlay(manifest("concurrent"), { infraDir: f.infraDir });
    await expect(pending).rejects.toThrow(/changed/i);
    expect(
      services.parseReleaseComposeSelection(readFileSync(f.paths.overlay, "utf8")).release,
    ).toBe("concurrent");
  });

  it("does not clear a newly selected release after observing an absent overlay", async () => {
    const f = fixture();
    unlinkSync(f.paths.overlay);
    const pending = clearReleaseSelection({
      infraDir: f.infraDir,
      docker: dockerFixture(f.before),
    });
    writeReleaseOverlay(manifest("concurrent"), { infraDir: f.infraDir });
    await expect(pending).rejects.toThrow(/changed/i);
    expect(
      services.parseReleaseComposeSelection(readFileSync(f.paths.overlay, "utf8")).release,
    ).toBe("concurrent");
  });
});
