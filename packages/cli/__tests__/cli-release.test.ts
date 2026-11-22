import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { services } from "@openmapx/core/server";
import { Command } from "commander";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { releaseProvenance } from "../../core/src/services/__fixtures__/release-provenance";
import { registerComposeCommands } from "../src/commands/compose";
import {
  type ReleaseDockerRunner,
  releaseForStart,
  releaseStatusLines,
  resolveReleaseManifest,
  touchesReleasePinnedServices,
} from "../src/lib/release";

// Direct command-entry tests have no Docker daemon; other tests supply their
// explicit registry/container runner. Never probe the developer's real daemon.
vi.mock("execa", async (original) => ({
  ...(await original<typeof import("execa")>()),
  execa: vi.fn(async () => {
    throw Error("Docker unavailable in the command fixture");
  }),
}));

const digest = (c: string) => `sha256:${c.repeat(64)}`;
const manifestJson = JSON.stringify({
  schemaVersion: 1,
  release: "deadbeef",
  images: {
    api: `ghcr.io/openmapx/api@${digest("a")}`,
    web: `ghcr.io/openmapx/web@${digest("b")}`,
    "data-manager": `ghcr.io/openmapx/data-manager@${digest("c")}`,
    "ops-agent": `ghcr.io/openmapx/ops-agent@${digest("d")}`,
    "transitous-runner": `ghcr.io/openmapx/transitous-runner@${digest("e")}`,
  },
  ...releaseProvenance(),
});

function fakeDocker(manifest = manifestJson): ReleaseDockerRunner {
  return vi.fn(async (args: string[]) => {
    if (
      args.join(" ") ===
      `container ls --all --no-trunc --filter label=com.docker.compose.project=${services.STACK_PROJECT} --filter label=com.docker.compose.service=data-manager --format {{.ID}}`
    )
      return { stdout: "", stderr: "", exitCode: 0 };
    if (args[0] === "pull" && args.length === 2)
      return { stdout: `Digest: sha256:${"1".repeat(64)}`, stderr: "", exitCode: 0 };
    if (
      args.length === 5 &&
      args.slice(0, 4).join(" ") === "image inspect --format {{.Id}}" &&
      args[4]?.endsWith(`@sha256:${"1".repeat(64)}`)
    )
      return { stdout: `sha256:${"2".repeat(64)}`, stderr: "", exitCode: 0 };
    if (args.join(" ") === `create sha256:${"2".repeat(64)} true`)
      return { stdout: "f".repeat(64), stderr: "", exitCode: 0 };
    if (
      args.length === 3 &&
      args[0] === "cp" &&
      args[1] === `${"f".repeat(64)}:/release-manifest.json`
    ) {
      const { writeFileSync } = await import("node:fs");
      const [, , destination] = args;
      assert.isDefined(destination);
      writeFileSync(destination, manifest);
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    if (args[0] === "rm" && args[1] === "-f" && args[2] === "f".repeat(64))
      return { stdout: "", stderr: "", exitCode: 0 };
    throw Error(`Unexpected Docker command: ${JSON.stringify(args)}`);
  });
}

let temp: string | null = null;
afterEach(() => {
  if (temp) rmSync(temp, { recursive: true, force: true });
  temp = null;
  vi.unstubAllEnvs();
});

/** A temporary `infra/docker` whose applied generation pins `release`, or nothing. */
async function pinnedInfra(release: services.ReleaseManifest | null) {
  temp = mkdtempSync(join(tmpdir(), "omx-release-"));
  await services.commitConfigurationGeneration({
    infraDir: temp,
    services: [],
    input: {
      domain: "maps.example.test",
      selectedRoots: [],
      serviceConfigs: [],
      integrationConfigs: [],
      serviceSecrets: [],
    },
    release,
  });
  return temp;
}

describe("touchesReleasePinnedServices", () => {
  it("detects every release-pinned runtime service", () => {
    expect(touchesReleasePinnedServices(["motis", "api"])).toBe(true);
    expect(touchesReleasePinnedServices(["ops-agent"])).toBe(true);
    expect(touchesReleasePinnedServices(["transitous-runner"])).toBe(true);
    expect(touchesReleasePinnedServices(["motis", "valhalla"])).toBe(false);
  });
});

describe("local release visibility", () => {
  it("reports the applied configuration's pins without the registry", async () => {
    const manifest = services.parseReleaseManifest(manifestJson);
    const infraDir = await pinnedInfra(manifest);
    const lines = releaseStatusLines(infraDir).join("\n");
    expect(lines).toContain(
      `Pinned release: deadbeef (manifest ${services.releaseManifestDigest(manifest)})`,
    );
    expect(lines).toContain(`api: ${manifest.images.api}`);
    expect(lines).not.toContain("docs:");
  });

  it("distinguishes disabled resolution from pins that still apply", async () => {
    vi.stubEnv("OPENMAPX_RELEASE", "local");
    expect(releaseStatusLines(await pinnedInfra(null)).join("\n")).toContain(
      "Release pinning disabled",
    );
    const pinned = releaseStatusLines(
      await pinnedInfra(services.parseReleaseManifest(manifestJson)),
    ).join("\n");
    expect(pinned).toContain("the applied pins still apply");
    expect(pinned).toContain("Pinned release: deadbeef");
  });

  it("asks for a selection when nothing is pinned", async () => {
    expect(releaseStatusLines(await pinnedInfra(null)).join("\n")).toContain(
      "pins no release. Run `pnpm openmapx compose release`",
    );
  });
});

describe("the compose release command", () => {
  it("exposes read-only status", () => {
    const program = new Command();
    registerComposeCommands(program);
    const release = program.commands
      .find((command) => command.name() === "compose")
      ?.commands.find((command) => command.name() === "release");
    expect(release?.options.map((option) => option.long)).toEqual(
      expect.arrayContaining(["--status", "--check", "--clear"]),
    );
  });

  it("rejects --clear together with --status before taking action", async () => {
    const program = new Command().exitOverride().configureOutput({ writeErr: () => {} });
    registerComposeCommands(program);
    await expect(
      program.parseAsync(["compose", "release", "--clear", "--status"], { from: "user" }),
    ).rejects.toThrow(/cannot be used with/);
  });
});

it("pulls a fork's manifest image and accepts its image prefix", async () => {
  temp = mkdtempSync(join(tmpdir(), "omx-release-fork-"));
  const forkManifest = manifestJson.replaceAll("ghcr.io/openmapx", "registry.example.org/fork");
  const docker = fakeDocker(forkManifest);
  vi.stubEnv("OPENMAPX_RELEASE_MANIFEST_REPOSITORY", "registry.example.org/fork/release-manifest");
  const manifest = await resolveReleaseManifest(docker, temp);
  expect(manifest.images.api).toMatch(/^registry\.example\.org\/fork\/api@/);
  expect(docker).toHaveBeenCalledWith(["pull", "registry.example.org/fork/release-manifest:main"]);
});

it("extracts the manifest from the frozen local image ID after a mutable pointer moves", async () => {
  const calls: string[][] = [];
  const docker: ReleaseDockerRunner = async (args) => {
    calls.push(args);
    if (args[0] === "pull")
      return { stdout: `Digest: sha256:${"1".repeat(64)}`, stderr: "", exitCode: 0 };
    if (args[0] === "image") return { stdout: `sha256:${"2".repeat(64)}`, stderr: "", exitCode: 0 };
    if (args[0] === "create") {
      expect(args[1]).toBe(`sha256:${"2".repeat(64)}`);
      return { stdout: "f".repeat(64), stderr: "", exitCode: 0 };
    }
    if (args[0] === "cp") {
      const [, , destination] = args;
      assert.isDefined(destination);
      writeFileSync(destination, manifestJson);
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  };
  expect((await resolveReleaseManifest(docker)).release).toBe("deadbeef");
  expect(calls).toContainEqual([
    "image",
    "inspect",
    "--format",
    "{{.Id}}",
    `ghcr.io/openmapx/release-manifest@sha256:${"1".repeat(64)}`,
  ]);
});

it("uses the applied UI selector on each invocation without changing process environment", async () => {
  const { services } = await import("@openmapx/core/server");
  temp = mkdtempSync(join(tmpdir(), "omx-applied-release-"));
  const infraDir = join(temp, "infra", "docker");
  mkdirSync(infraDir, { recursive: true });
  const input = {
    domain: "maps.example.test",
    selectedRoots: [],
    serviceConfigs: [],
    integrationConfigs: [],
    serviceSecrets: [],
  };
  vi.stubEnv("OPENMAPX_ROOT_DIR", temp);
  vi.stubEnv("OPENMAPX_RELEASE", "local");
  try {
    await services.commitConfigurationGeneration({
      infraDir,
      services: [],
      input: {
        ...input,
        platform: { version: 1, releaseSelector: { source: "database", value: "local" } },
      },
    });
    const docker = fakeDocker();
    await expect(releaseForStart({ docker })).resolves.toEqual({ manifest: null, resolved: false });
    expect(docker).not.toHaveBeenCalled();
    await services.commitConfigurationGeneration({
      infraDir,
      services: [],
      input: {
        ...input,
        platform: { version: 1, releaseSelector: { source: "database", value: "main" } },
      },
    });
    await resolveReleaseManifest(docker);
    expect(docker).toHaveBeenCalledWith(["pull", "ghcr.io/openmapx/release-manifest:main"]);
    expect(process.env.OPENMAPX_RELEASE).toBe("local");
  } finally {
    vi.unstubAllEnvs();
  }
});
