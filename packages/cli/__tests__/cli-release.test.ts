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
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerComposeCommands } from "../src/commands/compose";
import {
  clearReleaseSelection,
  ensureReleaseOverlay,
  type ReleaseDockerRunner,
  releaseStatusLines,
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

describe("ensureReleaseOverlay", () => {
  it("writes the overlay from the resolved manifest when it is missing", async () => {
    temp = mkdtempSync(join(tmpdir(), "omx-release-"));
    const path = join(temp, "docker-compose.release.yml");
    const docker = fakeDocker();
    const result = await ensureReleaseOverlay({ docker, path });
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
    temp = mkdtempSync(join(tmpdir(), "omx-release-"));
    const path = join(temp, "docker-compose.release.yml");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(path, "services: {}\n");
    const docker = fakeDocker();
    expect(await ensureReleaseOverlay({ docker, path })).toEqual({ status: "present", path });
    expect(docker).not.toHaveBeenCalled();
    expect(readFileSync(path, "utf-8")).toBe("services: {}\n");
  });

  it("reports an unpinned stack when the registry is unreachable", async () => {
    temp = mkdtempSync(join(tmpdir(), "omx-release-"));
    const path = join(temp, "docker-compose.release.yml");
    const docker: ReleaseDockerRunner = async () => ({
      stdout: "",
      stderr: "no network",
      exitCode: 1,
    });
    const result = await ensureReleaseOverlay({ docker, path });
    expect(result.status).toBe("unpinned");
    expect(existsSync(path)).toBe(false);
  });

  it("does not write an overlay when release validation evidence is missing", async () => {
    temp = mkdtempSync(join(tmpdir(), "omx-release-"));
    const path = join(temp, "docker-compose.release.yml");
    const invalid = JSON.stringify({
      ...JSON.parse(manifestJson),
      privacyReleaseValidation: undefined,
    });
    const result = await ensureReleaseOverlay({ docker: fakeDocker(invalid), path });
    expect(result).toMatchObject({ status: "unpinned", reason: expect.stringMatching(/privacy/) });
    expect(existsSync(path)).toBe(false);
  });

  it("does not activate the release when the pinned collector cannot be pulled", async () => {
    temp = mkdtempSync(join(tmpdir(), "omx-release-"));
    const path = join(temp, "docker-compose.release.yml");
    const base = fakeDocker();
    const docker: ReleaseDockerRunner = async (args) =>
      args[0] === "pull" && args[1]?.includes("privacy-backup@")
        ? { stdout: "", stderr: "collector unavailable", exitCode: 1 }
        : base(args);
    const result = await ensureReleaseOverlay({ docker, path });
    expect(result).toMatchObject({
      status: "unpinned",
      reason: expect.stringMatching(/privacy-backup/),
    });
    expect(existsSync(path)).toBe(false);
  });
});

describe("ensureReleaseOverlay with a disabled channel", () => {
  it("reports disabled without touching docker or writing a file", async () => {
    temp = mkdtempSync(join(tmpdir(), "omx-release-"));
    const path = join(temp, "docker-compose.release.yml");
    const docker = fakeDocker();
    process.env.OPENMAPX_RELEASE_MANIFEST_IMAGE = "";
    try {
      expect(await ensureReleaseOverlay({ docker, path })).toEqual({ status: "disabled" });
    } finally {
      delete process.env.OPENMAPX_RELEASE_MANIFEST_IMAGE;
    }
    expect(docker).not.toHaveBeenCalled();
    expect(existsSync(path)).toBe(false);
  });

  it("pulls a fork's manifest image and accepts its image prefix", async () => {
    temp = mkdtempSync(join(tmpdir(), "omx-release-"));
    const path = join(temp, "docker-compose.release.yml");
    const forkManifest = manifestJson.replaceAll("ghcr.io/openmapx", "registry.example.org/fork");
    const docker = fakeDocker(forkManifest);
    process.env.OPENMAPX_RELEASE_MANIFEST_IMAGE =
      "registry.example.org/fork/release-manifest:latest";
    try {
      const result = await ensureReleaseOverlay({ docker, path });
      expect(result.status).toBe("resolved");
    } finally {
      delete process.env.OPENMAPX_RELEASE_MANIFEST_IMAGE;
    }
    expect(docker).toHaveBeenCalledWith([
      "pull",
      "registry.example.org/fork/release-manifest:latest",
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
    temp = mkdtempSync(join(tmpdir(), "omx-release-"));
    const path = join(temp, "docker-compose.release.yml");
    const previous = JSON.parse(manifestJson);
    writeReleaseOverlay(previous, path);
    const before = readFileSync(path, "utf8");
    expect(releaseStatusLines(path).join("\n")).toContain("Selected release: deadbeef");
    expect(readFileSync(path, "utf8")).toBe(before);
    const next = JSON.parse(manifestJson);
    next.release = "next";
    next.images.api = `ghcr.io/openmapx/api@${digest("0")}`;
    next.images.web = next.images.web.replace("ghcr.io/openmapx", "mirror.example/openmapx");
    const lines: string[] = [];
    await selectRelease({
      path,
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
    temp = mkdtempSync(join(tmpdir(), "omx-release-"));
    const path = join(temp, "docker-compose.release.yml");
    vi.stubEnv("OPENMAPX_RELEASE_MANIFEST_IMAGE", "");
    try {
      expect(releaseStatusLines(path).join("\n")).toContain("Release pinning disabled");
      writeReleaseOverlay(JSON.parse(manifestJson), path);
      expect(releaseStatusLines(path).join("\n")).toContain("existing overlay still applies");
      expect(releaseStatusLines(path).join("\n")).toContain("Selected release: deadbeef");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("leaves selected pins intact when resolution fails", async () => {
    temp = mkdtempSync(join(tmpdir(), "omx-release-"));
    const path = join(temp, "docker-compose.release.yml");
    writeReleaseOverlay(JSON.parse(manifestJson), path);
    const before = readFileSync(path, "utf8");
    await expect(
      selectRelease({
        path,
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
  temp = mkdtempSync(join(tmpdir(), "omx-release-"));
  const path = join(temp, "docker-compose.release.yml");
  const manifest = JSON.parse(manifestJson);
  writeFileSync(path, `services:\n  app-api:\n    image: ${manifest.images.api}\n`);
  const lines: string[] = [];
  await selectRelease({ path, resolve: async () => manifest, report: (line) => lines.push(line) });
  expect(lines.join("\n")).toContain("Previous release: unknown (legacy or modified overlay)");
  expect(lines.join("\n")).toContain("api: reused");
  writeFileSync(path, "services: [");
  const resolve = vi.fn(async () => manifest);
  await expect(selectRelease({ path, resolve })).rejects.toThrow();
  expect(resolve).not.toHaveBeenCalled();
  expect(readFileSync(path, "utf8")).toBe("services: [");
  expect(() => releaseStatusLines(path)).toThrow();
});

it("does not report a candidate as selected when atomic overlay publication fails", async () => {
  temp = mkdtempSync(join(tmpdir(), "omx-release-"));
  const path = join(temp, "docker-compose.release.yml");
  const previous = JSON.parse(manifestJson);
  writeReleaseOverlay(previous, path);
  const before = readFileSync(path, "utf8");
  chmodSync(join(temp, ".release-evidence"), 0o755);
  const next = { ...previous, release: "next" };
  const lines: string[] = [];
  await expect(
    selectRelease({ path, resolve: async () => next, report: (line) => lines.push(line) }),
  ).rejects.toThrow(/unsafe/);
  expect(lines.join("\n")).toContain("Candidate release: next");
  expect(lines.join("\n")).not.toContain("Selected release: next");
  expect(readFileSync(path, "utf8")).toBe(before);
});

describe("clearReleaseSelection", () => {
  function fixture() {
    temp = mkdtempSync(join(tmpdir(), "omx-release-clear-"));
    const path = join(temp, "docker-compose.release.yml");
    const store = join(temp, ".ops-agent-releases");
    mkdirSync(store, { mode: 0o700 });
    writeReleaseOverlay(JSON.parse(manifestJson), path);
    writeFileSync(join(store, "current.json"), "running-state");
    return { path, store };
  }

  it("clears only the local overlay idempotently and retains running release evidence", async () => {
    const { path, store } = fixture();
    const evidence = join(dirname(path), ".release-evidence");
    const files = readdirSync(evidence).map((name) => [
      name,
      readFileSync(join(evidence, name), "utf8"),
    ]);
    vi.stubEnv("OPENMAPX_RELEASE_MANIFEST_IMAGE", "");
    try {
      expect(await clearReleaseSelection({ path })).toEqual({ path, cleared: true });
      expect(await clearReleaseSelection({ path })).toEqual({ path, cleared: false });
      expect(process.env.OPENMAPX_RELEASE_MANIFEST_IMAGE).toBe("");
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
    const { path, store } = fixture();
    writeFileSync(join(store, "transaction.json"), "pending transaction");
    const before = readFileSync(path, "utf8");
    await expect(clearReleaseSelection({ path })).rejects.toThrow(/transaction/);
    expect(readFileSync(path, "utf8")).toBe(before);
    rmSync(path);
    await expect(clearReleaseSelection({ path })).rejects.toThrow(/transaction/);
  });

  it("refuses a held or abandoned lock without changing it", async () => {
    const { path, store } = fixture();
    const lock = join(store, ".release-store.lock");
    mkdirSync(lock);
    writeFileSync(join(lock, "owner.json"), '{"acquiredAtMs":0}');
    await expect(clearReleaseSelection({ path })).rejects.toThrow(/busy/);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(join(lock, "owner.json"), "utf8")).toBe('{"acquiredAtMs":0}');
  });

  it.each(["overlay", "store"])("refuses a symlinked %s", async (target) => {
    const { path, store } = fixture();
    const link = target === "overlay" ? path : store;
    rmSync(link, { recursive: true });
    const outside = join(dirname(path), "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "sentinel"), "retain");
    symlinkSync(outside, link);
    await expect(clearReleaseSelection({ path })).rejects.toThrow(/unsafe/);
    expect(readFileSync(join(outside, "sentinel"), "utf8")).toBe("retain");
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
  const path = join(directory, "docker-compose.release.yml");
  writeFileSync(path, "services: {}\n");
  vi.stubEnv("OPENMAPX_ROOT_DIR", temp);
  vi.stubEnv("OPENMAPX_RELEASE_MANIFEST_IMAGE", "invalid");
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
    expect(process.env.OPENMAPX_RELEASE_MANIFEST_IMAGE).toBe("invalid");
  } finally {
    output.mockRestore();
    errors.mockRestore();
    exit.mockRestore();
    vi.unstubAllEnvs();
  }
});
