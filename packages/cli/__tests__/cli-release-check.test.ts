import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { services } from "@openmapx/core/server";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { releaseProvenance } from "../../core/src/services/__fixtures__/release-provenance";
import { registerComposeCommands } from "../src/commands/compose";
import * as release from "../src/lib/release";

let commandDocker: release.ReleaseDockerRunner | undefined;
vi.mock("execa", async (original) => ({
  ...(await original<typeof import("execa")>()),
  execa: vi.fn(async (name: string, args: string[]) => {
    if (name !== "docker" || !commandDocker) throw Error("Unexpected external process");
    return commandDocker(args);
  }),
}));
const roots: string[] = [];
function manifest(id: string): services.ReleaseManifest {
  return {
    schemaVersion: 1,
    release: id,
    images: Object.fromEntries(
      services.RELEASE_IMAGE_NAMES.map((name) => [
        name,
        `ghcr.io/openmapx/${name}@sha256:${(id === "running" ? "a" : "b").repeat(64)}`,
      ]),
    ) as services.ReleaseManifest["images"],
    ...releaseProvenance(),
  };
}
async function fixture(onCopy?: (path: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "openmapx-cli-check-"));
  roots.push(root);
  writeFileSync(join(root, "pnpm-workspace.yaml"), "packages: []\n");
  const infraDir = join(root, "infra", "docker");
  mkdirSync(infraDir, { recursive: true });
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
    release: manifest("running"),
  });
  const before = services.currentConfigurationGeneration(infraDir);
  const candidate = manifest("candidate");
  const docker: release.ReleaseDockerRunner = vi.fn(async (args) => {
    const ok = (stdout = "") => ({ stdout, exitCode: 0, stderr: "" });
    if (args.join(" ") === "pull ghcr.io/openmapx/release-manifest:main")
      return ok(`Digest: sha256:${"d".repeat(64)}`);
    if (
      args.join(" ") ===
      `image inspect --format {{.Id}} ghcr.io/openmapx/release-manifest@sha256:${"d".repeat(64)}`
    )
      return ok(`sha256:${"e".repeat(64)}`);
    if (args.join(" ") === `create sha256:${"e".repeat(64)} true`) return ok("f".repeat(64));
    if (args[0] === "cp" && args[1] === `${"f".repeat(64)}:/release-manifest.json` && args[2]) {
      writeFileSync(args[2], JSON.stringify(candidate), { mode: 0o600 });
      onCopy?.(args[2]);
      return ok();
    }
    if (args.join(" ") === `rm -f ${"f".repeat(64)}`) return ok();
    throw Error(`Unexpected Docker command in metadata-only check: ${JSON.stringify(args)}`);
  });
  return { root, infraDir, before, candidate, docker };
}
beforeEach(() => vi.stubEnv("OPENMAPX_RELEASE", "main"));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  commandDocker = undefined;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** The pins stay those of the applied generation, which a check never replaces. */
function expectPinsUnchanged(f: Awaited<ReturnType<typeof fixture>>) {
  expect(services.currentConfigurationGeneration(f.infraDir)).toBe(f.before);
  expect(services.readAppliedRelease(f.infraDir)?.manifest.release).toBe("running");
}

describe("CLI checked candidates without selection", () => {
  it("caches exact metadata by digest while preserving the applied pins", async () => {
    const f = await fixture();
    const result = await release.checkRelease({ infraDir: f.infraDir, docker: f.docker });
    const digest = services.releaseManifestDigest(f.candidate);
    expect(result).toMatchObject({
      manifest: f.candidate,
      ociDigest: `sha256:${"d".repeat(64)}`,
      releaseId: "candidate",
      manifestDigest: digest,
      configuredSelector: "main",
    });
    expect(
      readFileSync(join(services.releaseCacheDirectory(f.infraDir), `${digest}.json`), "utf8"),
    ).toBe(services.canonicalReleaseManifest(f.candidate));
    expectPinsUnchanged(f);
  });

  it.each(["oversized", "symlink"])(
    "rejects %s copied metadata without caching it",
    async (kind) => {
      const f = await fixture((path) => {
        if (kind === "oversized") writeFileSync(path, "x".repeat(32 * 1024 + 1));
        else {
          rmSync(path);
          symlinkSync(join(f.root, "pnpm-workspace.yaml"), path);
        }
      });
      await expect(
        release.checkRelease({ infraDir: f.infraDir, docker: f.docker }),
      ).rejects.toThrow();
      expect(services.cachedReleases(f.infraDir, "ghcr.io/openmapx")).toEqual([]);
      expectPinsUnchanged(f);
      expect(f.docker).toHaveBeenLastCalledWith(["rm", "-f", "f".repeat(64)]);
    },
  );

  it("refuses a disabled channel before any registry call", async () => {
    const f = await fixture();
    vi.stubEnv("OPENMAPX_RELEASE", "local");
    await expect(release.checkRelease({ infraDir: f.infraDir, docker: f.docker })).rejects.toThrow(
      /disabled/,
    );
    expect(f.docker).not.toHaveBeenCalled();
  });

  it("reports a checked candidate from the command without pinning it", async () => {
    const f = await fixture();
    commandDocker = f.docker;
    vi.stubEnv("OPENMAPX_ROOT_DIR", f.root);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw Error(`exit:${code}`);
    });
    const program = new Command();
    registerComposeCommands(program);
    await program.parseAsync(["compose", "release", "--check"], { from: "user" });
    expect(log.mock.calls.flat().join("\n")).toContain("Checked release: candidate");
    expect(log.mock.calls.flat().join("\n")).not.toContain("Pinned release candidate");
    expectPinsUnchanged(f);
  });

  it.each(["--status", "--clear"])(
    "rejects mixing --check with %s before taking action",
    async (other) => {
      const program = new Command().exitOverride().configureOutput({ writeErr() {} });
      registerComposeCommands(program);
      await expect(
        program.parseAsync(["compose", "release", "--check", other], { from: "user" }),
      ).rejects.toThrow(/cannot be used with/i);
    },
  );
});
