import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ensureReleaseOverlay,
  type ReleaseDockerRunner,
  touchesReleasePinnedServices,
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
    "transitous-runner": `ghcr.io/openmapx/transitous-runner@${digest("e")}`,
    "transitous-tools": `ghcr.io/openmapx/transitous-tools@${digest("f")}`,
    docs: `ghcr.io/openmapx/docs@${digest("1")}`,
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
    const result = await ensureReleaseOverlay({ docker: fakeDocker(), path });
    expect(result).toEqual({ status: "resolved", path, release: "deadbeef" });
    expect(readFileSync(path, "utf-8")).toContain(`image: ghcr.io/openmapx/api@${digest("a")}`);
    expect(readFileSync(path, "utf-8")).toContain(
      `image: ghcr.io/openmapx/ops-agent@${digest("d")}`,
    );
    expect(readFileSync(path, "utf-8")).toContain(
      `image: ghcr.io/openmapx/transitous-runner@${digest("e")}`,
    );
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
