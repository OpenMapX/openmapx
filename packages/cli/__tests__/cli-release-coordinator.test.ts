import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { services } from "@openmapx/core/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { releaseProvenance } from "../../core/src/services/__fixtures__/release-provenance";
import {
  assertReleaseClearable,
  type ReleaseDockerRunner,
  type ReleaseManifest,
  releaseForStart,
  selectRelease,
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
    ...releaseProvenance(),
  };
}

/** An installation whose applied generation pins `before`, or nothing. */
async function fixture(pinned = true) {
  const infraDir = mkdtempSync(join(tmpdir(), "openmapx-release-coordinator-"));
  roots.push(infraDir);
  const before = manifest("before");
  await services.commitConfigurationGeneration({
    infraDir,
    services: [],
    input: {
      domain: "maps.example.test",
      selectedRoots: [],
      serviceConfigs: [],
      integrationConfigs: [],
      serviceSecrets: [],
    },
    release: pinned ? before : null,
  });
  return { infraDir, before };
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
  it("refuses a candidate that changes the running Data Manager and caches nothing", async () => {
    const f = await fixture();
    const next = manifest("after", "0");
    await expect(
      selectRelease({
        infraDir: f.infraDir,
        resolve: async () => next,
        docker: dockerFixture(next),
      }),
    ).rejects.toThrow(/coordinator|Data Manager/i);
    expect(services.readAppliedRelease(f.infraDir)?.manifest.release).toBe("before");
    expect(services.cachedReleases(f.infraDir, "ghcr.io/openmapx")).toEqual([]);
  });

  it.each([
    { ids: [containerId, "c".repeat(64)] },
    { ids: ["malformed-id"] },
    { listFailure: true },
    { malformedInspect: true },
    { cachedImageId: digest("0") },
  ])("refuses an ambiguous or unreadable coordinator (%j)", async (observation) => {
    const f = await fixture();
    const next = manifest("after");
    await expect(
      selectRelease({
        infraDir: f.infraDir,
        resolve: async () => next,
        docker: dockerFixture(next, observation),
      }),
    ).rejects.toThrow();
  });

  it.each([{ ids: [] }, { ids: [containerId] }])(
    "permits bootstrap or the exact running pin and reports the change (%j)",
    async ({ ids }) => {
      const f = await fixture();
      const next = manifest("after");
      const lines: string[] = [];
      await expect(
        selectRelease({
          infraDir: f.infraDir,
          resolve: async () => next,
          docker: dockerFixture(next, { ids }),
          report: (line) => lines.push(line),
        }),
      ).resolves.toMatchObject({ release: "after" });
      expect(lines).toContain("Previous release: before");
      expect(lines).toContain(`data-manager: reused (${digest("c")} → ${digest("c")})`);
      expect(services.cachedReleases(f.infraDir, "ghcr.io/openmapx")[0]?.manifest.release).toBe(
        "after",
      );
      // Selection renders nothing by itself; the command commits the generation.
      expect(services.readAppliedRelease(f.infraDir)?.manifest.release).toBe("before");
    },
  );
});

describe("the release a start renders", () => {
  it("keeps the applied pins without asking the registry", async () => {
    const f = await fixture();
    const docker = dockerFixture(manifest("after"));
    await expect(releaseForStart({ infraDir: f.infraDir, docker })).resolves.toEqual({
      manifest: f.before,
      resolved: false,
    });
    expect(docker).not.toHaveBeenCalled();
  });

  it("resolves and caches a release at bootstrap", async () => {
    const f = await fixture(false);
    const next = manifest("after");
    await expect(
      releaseForStart({ infraDir: f.infraDir, docker: dockerFixture(next, { ids: [] }) }),
    ).resolves.toEqual({ manifest: next, resolved: true });
    expect(services.cachedReleases(f.infraDir, "ghcr.io/openmapx")).toHaveLength(1);
  });

  it("refuses to start release images without pins when the registry cannot be reached", async () => {
    const f = await fixture(false);
    const docker: ReleaseDockerRunner = async () => ({
      stdout: "",
      stderr: "no network",
      exitCode: 1,
    });
    await expect(releaseForStart({ infraDir: f.infraDir, docker })).rejects.toThrow(
      /pins no release.*OPENMAPX_RELEASE=local/s,
    );
  });

  it("renders no pins under OPENMAPX_RELEASE=local", async () => {
    vi.stubEnv("OPENMAPX_RELEASE", "local");
    const f = await fixture(false);
    const docker = dockerFixture(manifest("after"));
    await expect(releaseForStart({ infraDir: f.infraDir, docker })).resolves.toEqual({
      manifest: null,
      resolved: false,
    });
    expect(docker).not.toHaveBeenCalled();
  });
});

describe("clearing the pins", () => {
  it("refuses while the running Data Manager uses the pinned image", async () => {
    const f = await fixture();
    await expect(
      assertReleaseClearable({ infraDir: f.infraDir, docker: dockerFixture(f.before) }),
    ).rejects.toThrow(/System → Updates/);
  });

  it("names the pinned release when the coordinator runs something else or nothing", async () => {
    const f = await fixture();
    await expect(
      assertReleaseClearable({
        infraDir: f.infraDir,
        docker: dockerFixture(f.before, {
          reference: manifest("other", "0").images["data-manager"],
        }),
      }),
    ).resolves.toBe("before");
    await expect(
      assertReleaseClearable({
        infraDir: f.infraDir,
        docker: dockerFixture(f.before, { ids: [] }),
      }),
    ).resolves.toBe("before");
    const unpinned = await fixture(false);
    await expect(assertReleaseClearable({ infraDir: unpinned.infraDir })).resolves.toBeNull();
  });
});
