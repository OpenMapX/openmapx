import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { services } from "@openmapx/core/server";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerComposeCommands } from "../src/commands/compose";
import {
  clearReleaseSelection,
  ensureReleaseOverlay,
  type ReleaseDockerRunner,
  releaseStatusLines,
  resolveReleaseManifest,
  selectRelease,
  touchesReleasePinnedServices,
  writeReleaseOverlay,
} from "../src/lib/release";

const digest = (c: string) => `sha256:${c.repeat(64)}`;
const manifestJson = JSON.stringify({
  schemaVersion: 1,
  release: "deadbeef",
  images: {
    api: `ghcr.io/openmapx/api@${digest("a")}`,
    web: `ghcr.io/openmapx/web@${digest("b")}`,
    "data-manager": `ghcr.io/openmapx/data-manager@${digest("c")}`,
    "ops-agent": `ghcr.io/openmapx/ops-agent@${digest("d")}`,
    "privacy-backup": `ghcr.io/openmapx/privacy-backup@${digest("9")}`,
    "transitous-runner": `ghcr.io/openmapx/transitous-runner@${digest("e")}`,
    "transitous-tools": `ghcr.io/openmapx/transitous-tools@${digest("f")}`,
  },
  privacyReleaseValidation: {
    version: 1,
    sourceBuildFingerprint: "2".repeat(64),
    validatedAt: "2026-09-05T12:00:00.000Z",
    checks: {
      translationsConsistent: true,
      openApiConsistent: true,
      policyConsistent: true,
    },
  },
});

function fakeDocker(manifest = manifestJson): ReleaseDockerRunner {
  return vi.fn(async (args: string[]) => {
    if (args[0] === "pull")
      return { stdout: `Digest: sha256:${"1".repeat(64)}`, stderr: "", exitCode: 0 };
    if (args[0] === "image") return { stdout: `sha256:${"2".repeat(64)}`, stderr: "", exitCode: 0 };
    if (args[0] === "create") return { stdout: "f".repeat(64), stderr: "", exitCode: 0 };
    if (args[0] === "cp") {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(args[2], manifest);
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  });
}

let temp: string | null = null;
afterEach(() => {
  if (temp) rmSync(temp, { recursive: true, force: true });
  temp = null;
});

/** A temporary `infra/docker` with its release state directory, and the overlay path in it. */
function releaseInfra(prefix = "omx-release-") {
  temp = mkdtempSync(join(tmpdir(), prefix));
  const infraDir = temp;
  const path = services.releaseStatePaths(infraDir).overlay;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  return { infraDir, path };
}

describe("ensureReleaseOverlay", () => {
  it("writes the overlay from the resolved manifest when it is missing", async () => {
    const { infraDir, path } = releaseInfra();
    const docker = fakeDocker();
    const result = await ensureReleaseOverlay({ docker, infraDir });
    expect(result).toEqual({ status: "resolved", path, release: "deadbeef" });
    expect(readFileSync(path, "utf-8")).toContain(`image: ghcr.io/openmapx/api@${digest("a")}`);
    expect(readFileSync(path, "utf-8")).toContain(
      `image: ghcr.io/openmapx/ops-agent@${digest("d")}`,
    );
    expect(readFileSync(path, "utf-8")).toContain(
      `image: ghcr.io/openmapx/transitous-runner@${digest("e")}`,
    );
    expect(readFileSync(path, "utf-8")).toContain(
      `OPS_PRIVACY_BACKUP_COLLECTOR_IMAGE: ghcr.io/openmapx/privacy-backup@${digest("9")}`,
    );
    expect(docker).toHaveBeenCalledWith(["pull", `ghcr.io/openmapx/privacy-backup@${digest("9")}`]);
  });

  it("never overwrites an existing overlay", async () => {
    const { infraDir, path } = releaseInfra();
    writeReleaseOverlay(JSON.parse(manifestJson), { infraDir });
    const docker = fakeDocker();
    expect(await ensureReleaseOverlay({ docker, infraDir })).toEqual({ status: "present", path });
    expect(docker).not.toHaveBeenCalled();
    expect(readFileSync(path, "utf-8")).toContain("deadbeef");
  });

  it("reports an unpinned stack when the registry is unreachable", async () => {
    const { infraDir, path } = releaseInfra();
    const docker: ReleaseDockerRunner = async () => ({
      stdout: "",
      stderr: "no network",
      exitCode: 1,
    });
    const result = await ensureReleaseOverlay({ docker, infraDir });
    expect(result.status).toBe("unpinned");
    expect(existsSync(path)).toBe(false);
  });

  it("does not write an overlay when release validation evidence is missing", async () => {
    const { infraDir, path } = releaseInfra();
    const invalid = JSON.stringify({
      ...JSON.parse(manifestJson),
      privacyReleaseValidation: undefined,
    });
    const result = await ensureReleaseOverlay({ docker: fakeDocker(invalid), infraDir });
    expect(result).toMatchObject({ status: "unpinned", reason: expect.stringMatching(/privacy/) });
    expect(existsSync(path)).toBe(false);
  });

  it("does not activate the release when the pinned collector cannot be pulled", async () => {
    const { infraDir, path } = releaseInfra();
    const base = fakeDocker();
    const docker: ReleaseDockerRunner = async (args) =>
      args[0] === "pull" && args[1]?.includes("privacy-backup@")
        ? { stdout: "", stderr: "collector unavailable", exitCode: 1 }
        : base(args);
    const result = await ensureReleaseOverlay({ docker, infraDir });
    expect(result).toMatchObject({
      status: "unpinned",
      reason: expect.stringMatching(/privacy-backup/),
    });
    expect(existsSync(path)).toBe(false);
  });
});

describe("ensureReleaseOverlay with a disabled channel", () => {
  it("reports disabled without touching docker or writing a file", async () => {
    const { infraDir, path } = releaseInfra();
    const docker = fakeDocker();
    process.env.OPENMAPX_RELEASE = "local";
    try {
      expect(await ensureReleaseOverlay({ docker, infraDir })).toEqual({ status: "disabled" });
    } finally {
      delete process.env.OPENMAPX_RELEASE;
    }
    expect(docker).not.toHaveBeenCalled();
    expect(existsSync(path)).toBe(false);
  });

  it("pulls a fork's manifest image and accepts its image prefix", async () => {
    const { infraDir, path } = releaseInfra();
    const forkManifest = manifestJson.replaceAll("ghcr.io/openmapx", "registry.example.org/fork");
    const docker = fakeDocker(forkManifest);
    process.env.OPENMAPX_RELEASE_MANIFEST_REPOSITORY = "registry.example.org/fork/release-manifest";
    try {
      const result = await ensureReleaseOverlay({ docker, infraDir });
      expect(result.status).toBe("resolved");
    } finally {
      delete process.env.OPENMAPX_RELEASE_MANIFEST_REPOSITORY;
    }
    expect(docker).toHaveBeenCalledWith([
      "pull",
      "registry.example.org/fork/release-manifest:main",
    ]);
    expect(readFileSync(path, "utf-8")).toContain("registry.example.org/fork/api@");
  });
});

describe("touchesReleasePinnedServices", () => {
  it("detects every release-pinned runtime service", () => {
    expect(touchesReleasePinnedServices(["motis", "app-api"])).toBe(true);
    expect(touchesReleasePinnedServices(["ops-agent"])).toBe(true);
    expect(touchesReleasePinnedServices(["transitous-runner"])).toBe(true);
    expect(touchesReleasePinnedServices(["motis", "valhalla"])).toBe(false);
  });
});

describe("local release visibility", () => {
  it("reports selected pins locally and compares digests before selecting a new release", async () => {
    const { infraDir, path } = releaseInfra();
    const previous = JSON.parse(manifestJson);
    writeReleaseOverlay(previous, { infraDir });
    const before = readFileSync(path, "utf8");
    expect(releaseStatusLines(path).join("\n")).toContain("Selected release: deadbeef");
    expect(readFileSync(path, "utf8")).toBe(before);
    const next = JSON.parse(manifestJson);
    next.release = "next";
    next.images.api = `ghcr.io/openmapx/api@${digest("0")}`;
    next.images.web = next.images.web.replace("ghcr.io/openmapx", "mirror.example/openmapx");
    const lines: string[] = [];
    await selectRelease({
      infraDir,
      resolve: async () => next,
      report: (line) => {
        expect(readFileSync(path, "utf8")).toBe(before);
        lines.push(line);
      },
    });
    expect(lines.join("\n")).toContain("Previous release: deadbeef");
    expect(lines.join("\n")).toContain("Candidate release: next");
    expect(lines.join("\n")).toContain("api: changed");
    expect(lines.join("\n")).toContain("web: reused");
    expect(lines.join("\n")).not.toContain("docs:");
    expect(releaseStatusLines(path).join("\n")).toContain("Selected release: next");
  });

  it("distinguishes disabled resolution from an existing active overlay", () => {
    const { infraDir, path } = releaseInfra();
    vi.stubEnv("OPENMAPX_RELEASE", "local");
    try {
      expect(releaseStatusLines(path).join("\n")).toContain("Release pinning disabled");
      writeReleaseOverlay(JSON.parse(manifestJson), { infraDir });
      expect(releaseStatusLines(path).join("\n")).toContain("existing overlay still applies");
      expect(releaseStatusLines(path).join("\n")).toContain("Selected release: deadbeef");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("leaves selected pins intact when resolution fails", async () => {
    const { infraDir, path } = releaseInfra();
    writeReleaseOverlay(JSON.parse(manifestJson), { infraDir });
    const before = readFileSync(path, "utf8");
    await expect(
      selectRelease({
        infraDir,
        resolve: async () => {
          throw new Error("offline");
        },
      }),
    ).rejects.toThrow("offline");
    expect(readFileSync(path, "utf8")).toBe(before);
  });
});

it("exposes read-only release status on the compose command", () => {
  const program = new Command();
  registerComposeCommands(program);
  const release = program.commands
    .find((command) => command.name() === "compose")
    ?.commands.find((command) => command.name() === "release");
  expect(release?.options.some((option) => option.long === "--status")).toBe(true);
});

it("compares legacy pins and rejects malformed local overlays before resolution", async () => {
  const { infraDir, path } = releaseInfra();
  const manifest = JSON.parse(manifestJson);
  writeFileSync(path, `services:\n  app-api:\n    image: ${manifest.images.api}\n`, {
    mode: 0o600,
  });
  const lines: string[] = [];
  await selectRelease({
    infraDir,
    resolve: async () => manifest,
    report: (line) => lines.push(line),
  });
  expect(lines.join("\n")).toContain("Previous release: unknown (legacy or modified overlay)");
  expect(lines.join("\n")).toContain("api: reused");
  writeFileSync(path, "services: [");
  const resolve = vi.fn(async () => manifest);
  await expect(selectRelease({ infraDir, resolve })).rejects.toThrow();
  expect(resolve).not.toHaveBeenCalled();
  expect(readFileSync(path, "utf8")).toBe("services: [");
  expect(() => releaseStatusLines(path)).toThrow();
});

it("does not report a candidate as selected when atomic overlay publication fails", async () => {
  const { infraDir, path } = releaseInfra();
  const previous = JSON.parse(manifestJson);
  writeReleaseOverlay(previous, { infraDir });
  const before = readFileSync(path, "utf8");
  chmodSync(services.releaseStatePaths(infraDir).evidence, 0o755);
  const next = { ...previous, release: "next" };
  const lines: string[] = [];
  await expect(
    selectRelease({ infraDir, resolve: async () => next, report: (line) => lines.push(line) }),
  ).rejects.toThrow(/unsafe/i);
  expect(lines.join("\n")).toContain("Candidate release: next");
  expect(lines.join("\n")).not.toContain("Selected release: next");
  expect(readFileSync(path, "utf8")).toBe(before);
});

describe("clearReleaseSelection", () => {
  function fixture() {
    const { infraDir, path } = releaseInfra("omx-release-clear-");
    const store = services.releaseStatePaths(infraDir).store;
    mkdirSync(store, { mode: 0o700 });
    writeReleaseOverlay(JSON.parse(manifestJson), { infraDir });
    writeFileSync(join(store, "current.json"), "running-state");
    return { infraDir, path, store };
  }

  it("clears only the local overlay idempotently and retains running release evidence", async () => {
    const { infraDir, path, store } = fixture();
    const evidence = services.releaseStatePaths(infraDir).evidence;
    const files = readdirSync(evidence).map((name) => [
      name,
      readFileSync(join(evidence, name), "utf8"),
    ]);
    vi.stubEnv("OPENMAPX_RELEASE", "local");
    try {
      expect(await clearReleaseSelection({ infraDir })).toEqual({ path, cleared: true });
      expect(await clearReleaseSelection({ infraDir })).toEqual({ path, cleared: false });
      expect(process.env.OPENMAPX_RELEASE).toBe("local");
    } finally {
      vi.unstubAllEnvs();
    }
    expect(existsSync(path)).toBe(false);
    expect(readFileSync(join(store, "current.json"), "utf8")).toBe("running-state");
    expect(
      readdirSync(evidence).map((name) => [name, readFileSync(join(evidence, name), "utf8")]),
    ).toEqual(files);
    expect(readdirSync(store)).toEqual(["current.json"]);
  });

  it("refuses an active transaction even if the overlay is absent", async () => {
    const { infraDir, path, store } = fixture();
    writeFileSync(join(store, "transaction.json"), "pending transaction");
    const before = readFileSync(path, "utf8");
    await expect(clearReleaseSelection({ infraDir })).rejects.toThrow(/transaction/);
    expect(readFileSync(path, "utf8")).toBe(before);
    rmSync(path);
    await expect(clearReleaseSelection({ infraDir })).rejects.toThrow(/transaction/);
  });

  it("refuses a held or abandoned lock without changing it", async () => {
    const { infraDir, path, store } = fixture();
    const lock = join(store, ".release-store.lock");
    mkdirSync(lock);
    writeFileSync(join(lock, "owner.json"), '{"acquiredAtMs":0}');
    await expect(clearReleaseSelection({ infraDir })).rejects.toThrow(/busy/);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(join(lock, "owner.json"), "utf8")).toBe('{"acquiredAtMs":0}');
  });

  it.each(["overlay", "store"])("refuses a symlinked %s", async (target) => {
    const { infraDir, path, store } = fixture();
    const link = target === "overlay" ? path : store;
    rmSync(link, { recursive: true });
    const outside = join(dirname(path), "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "sentinel"), "retain");
    symlinkSync(outside, link);
    await expect(clearReleaseSelection({ infraDir })).rejects.toThrow(/unsafe/i);
    expect(readFileSync(join(outside, "sentinel"), "utf8")).toBe("retain");
  });

  it("removes only the agent state's overlay, never an earlier release's in infra/docker", async () => {
    const { infraDir, path } = fixture();
    const legacy = join(infraDir, "docker-compose.release.yml");
    writeFileSync(legacy, "legacy overlay\n", { mode: 0o600 });
    expect(await clearReleaseSelection({ infraDir })).toEqual({ path, cleared: true });
    expect(readFileSync(legacy, "utf8")).toBe("legacy overlay\n");
  });

  it("refuses an overlay that is group-writable or someone else's", async () => {
    const { infraDir, path } = fixture();
    chmodSync(path, 0o620);
    await expect(clearReleaseSelection({ infraDir })).rejects.toThrow(/group or others/);
    chmodSync(path, 0o600);
    // Tests cannot chown: inject the uid the state must belong to instead.
    const foreign = (process.geteuid?.() ?? 0) + 1;
    await expect(clearReleaseSelection({ infraDir, uid: foreign })).rejects.toThrow(/unsafe/i);
    expect(existsSync(path)).toBe(true);
  });

  it("rejects --clear together with --status before taking action", async () => {
    const program = new Command().exitOverride().configureOutput({ writeErr: () => {} });
    registerComposeCommands(program);
    await expect(
      program.parseAsync(["compose", "release", "--clear", "--status"], { from: "user" }),
    ).rejects.toThrow(/cannot be used with/);
  });
});

it("clears through the command without registry access even with a malformed channel", async () => {
  temp = mkdtempSync(join(tmpdir(), "omx-release-clear-command-"));
  const directory = join(temp, "infra", "docker");
  mkdirSync(directory, { recursive: true });
  const path = services.releaseStatePaths(directory).overlay;
  writeReleaseOverlay(JSON.parse(manifestJson), { infraDir: directory });
  vi.stubEnv("OPENMAPX_ROOT_DIR", temp);
  vi.stubEnv("OPENMAPX_RELEASE", "invalid");
  vi.stubEnv("PATH", "");
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const exit = vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("unexpected CLI failure");
  });
  try {
    const program = new Command();
    registerComposeCommands(program);
    await program.parseAsync(["compose", "release", "--clear"], { from: "user" });
    expect(existsSync(path)).toBe(false);
    expect(output.mock.calls.flat().join("\n")).toContain("next start/update");
    expect(process.env.OPENMAPX_RELEASE).toBe("invalid");
  } finally {
    output.mockRestore();
    errors.mockRestore();
    exit.mockRestore();
    vi.unstubAllEnvs();
  }
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
    if (args[0] === "cp") writeFileSync(args[2], manifestJson);
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

it.each(["group-writable", "foreign"] as const)(
  "refuses a %s overlay for status, selection and start instead of reading it",
  async (kind) => {
    const { infraDir, path } = releaseInfra();
    writeReleaseOverlay(JSON.parse(manifestJson), { infraDir });
    const before = readFileSync(path, "utf8");
    if (kind === "group-writable") chmodSync(path, 0o620);
    const uid = kind === "foreign" ? (process.geteuid?.() ?? 0) + 1 : undefined;
    const docker = fakeDocker();
    expect(() => releaseStatusLines(path, { uid })).toThrow();
    await expect(ensureReleaseOverlay({ infraDir, docker, uid })).rejects.toThrow();
    const resolve = vi.fn(async () => JSON.parse(manifestJson));
    await expect(selectRelease({ infraDir, uid, resolve })).rejects.toThrow();
    expect(resolve).not.toHaveBeenCalled();
    expect(docker).not.toHaveBeenCalled();
    expect(readFileSync(path, "utf8")).toBe(before);
  },
);

it("writes evidence the overlay references from the configuration pointer", () => {
  const { infraDir, path } = releaseInfra();
  writeReleaseOverlay(JSON.parse(manifestJson), { infraDir });
  const reference = /file: (\S+)/.exec(readFileSync(path, "utf8"))?.[1] ?? "";
  expect(reference).toMatch(
    /^\.\.\/\.\.\/releases\/evidence\/privacy-release-validation-[a-f0-9]{64}\.json$/,
  );
  expect(existsSync(join(infraDir, services.CURRENT_CONFIGURATION, reference))).toBe(true);
});

it("rejects a malformed existing overlay without replacing it or reaching the registry", async () => {
  const { infraDir, path } = releaseInfra("omx-invalid-overlay-");
  writeFileSync(path, "services: {}\n", { mode: 0o600 });
  const docker = fakeDocker();
  await expect(ensureReleaseOverlay({ infraDir, docker })).rejects.toThrow(/malformed/);
  expect(readFileSync(path, "utf8")).toBe("services: {}\n");
  expect(docker).not.toHaveBeenCalled();
});
