import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
    privacyReleaseValidation: {
      version: 1,
      sourceBuildFingerprint: "c".repeat(64),
      validatedAt: "2026-11-06T00:00:00.000Z",
      checks: { translationsConsistent: true, openApiConsistent: true, policyConsistent: true },
    },
    ...releaseProvenance(),
  };
}
function fixture(onCopy?: (path: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "openmapx-cli-check-"));
  roots.push(root);
  writeFileSync(join(root, "pnpm-workspace.yaml"), "packages: []\n");
  const infraDir = join(root, "infra", "docker");
  const paths = services.ensureReleaseStateDirectories(infraDir);
  services.writeReleaseComposeArtifacts(manifest("running"), infraDir);
  const before = readFileSync(paths.overlay, "utf8");
  writeFileSync(join(paths.store, "current.json"), "running-state", { mode: 0o600 });
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
  return { root, infraDir, paths, before, candidate, docker };
}
beforeEach(() => vi.stubEnv("OPENMAPX_RELEASE", "main"));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  commandDocker = undefined;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("CLI checked candidates without selection", () => {
  it("caches exact metadata while preserving selected pins and recorded running state", async () => {
    const f = fixture();
    const result = await release.checkRelease({ infraDir: f.infraDir, docker: f.docker });
    const raw = readFileSync(join(f.paths.store, "candidate.json"), "utf8");
    expect(result).toMatchObject({
      manifest: f.candidate,
      ociDigest: `sha256:${"d".repeat(64)}`,
      manifestDigest: createHash("sha256").update(raw).digest("hex"),
      configuredSelector: "main",
    });
    expect(readFileSync(f.paths.overlay, "utf8")).toBe(f.before);
    expect(readFileSync(join(f.paths.store, "current.json"), "utf8")).toBe("running-state");
  });

  it("normalizes unset and explicit default selectors identically", () => {
    const f = fixture();
    vi.stubEnv("OPENMAPX_RELEASE", undefined);
    const implicit = services.releaseConfigurationIdentity(
      services.readAppliedReleaseSelection(f.infraDir),
    );
    vi.stubEnv("OPENMAPX_RELEASE", "main");
    expect(
      services.releaseConfigurationIdentity(services.readAppliedReleaseSelection(f.infraDir)),
    ).toBe(implicit);
  });

  it.each(["oversized", "symlink"])(
    "rejects %s copied metadata without publication",
    async (kind) => {
      const f = fixture((path) => {
        if (kind === "oversized")
          writeFileSync(path, "x".repeat(services.RELEASE_STORE_LIMITS.manifestBytes + 1));
        else {
          rmSync(path);
          symlinkSync(join(f.paths.store, "current.json"), path);
        }
      });
      await expect(
        release.checkRelease({ infraDir: f.infraDir, docker: f.docker }),
      ).rejects.toThrow();
      expect(existsSync(join(f.paths.store, "candidate.json"))).toBe(false);
      expect(readFileSync(f.paths.overlay, "utf8")).toBe(f.before);
      expect(f.docker).toHaveBeenLastCalledWith(["rm", "-f", "f".repeat(64)]);
    },
  );

  it("refuses an active transaction before contacting the registry", async () => {
    const f = fixture();
    writeFileSync(join(f.paths.store, "transaction.json"), "{}", { mode: 0o600 });
    await expect(release.checkRelease({ infraDir: f.infraDir, docker: f.docker })).rejects.toThrow(
      /transaction/i,
    );
    expect(f.docker).not.toHaveBeenCalled();
    expect(existsSync(join(f.paths.store, "candidate.json"))).toBe(false);
  });

  it("refuses a configured selector that changes during resolution", async () => {
    const f = fixture(() => vi.stubEnv("OPENMAPX_RELEASE", "preview"));
    await expect(release.checkRelease({ infraDir: f.infraDir, docker: f.docker })).rejects.toThrow(
      /configuration|selection.*changed/i,
    );
    expect(existsSync(join(f.paths.store, "candidate.json"))).toBe(false);
    expect(readFileSync(f.paths.overlay, "utf8")).toBe(f.before);
  });

  it("refuses a different store owner before any write or registry call", async () => {
    const f = fixture();
    await expect(
      release.checkRelease({
        infraDir: f.infraDir,
        docker: f.docker,
        uid: (process.geteuid?.() ?? 0) + 1,
      }),
    ).rejects.toThrow(/owned|uid|unsafe/i);
    expect(f.docker).not.toHaveBeenCalled();
  });

  it("reports a checked candidate from the command without reporting it selected", async () => {
    const f = fixture();
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
    expect(log.mock.calls.flat().join("\n")).not.toContain("Atomic release selection candidate");
    expect(readFileSync(f.paths.overlay, "utf8")).toBe(f.before);
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
