import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type DockerRunner,
  ensureTrafficExtract,
  isTrafficExtractStale,
} from "../jobs/traffic/ensure-extract.js";

describe("ensureTrafficExtract", () => {
  const originalContainerEnv = process.env.VALHALLA_CONTAINER;
  // The build chowns traffic.tar to the data-manager process's own uid/gid.
  const CHOWN_ID = `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`;
  // Post-build sanity probe: reads index.bin's byte size to reject an empty extract.
  const PROBE_CALL = [
    "exec",
    "docker-valhalla-1",
    "sh",
    "-c",
    "tar xOf /custom_files/traffic.tar index.bin 2>/dev/null | wc -c",
  ];

  beforeEach(() => {
    if (originalContainerEnv === undefined) delete process.env.VALHALLA_CONTAINER;
    else process.env.VALHALLA_CONTAINER = originalContainerEnv;
  });

  it("builds the extract and restarts the container when the tar is absent", async () => {
    const calls: string[][] = [];
    const runDocker: DockerRunner = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[0] === "exec" && args[2] === "test") {
        return { exitCode: 1, stdout: "" };
      }
      return { exitCode: 0, stdout: "" };
    });

    const result = await ensureTrafficExtract({ runDocker, container: "docker-valhalla-1" });

    expect(result).toEqual({ built: true });
    expect(calls).toEqual([
      ["exec", "docker-valhalla-1", "test", "-f", "/custom_files/traffic.tar"],
      [
        "exec",
        "docker-valhalla-1",
        "valhalla_build_extract",
        "-c",
        "/custom_files/valhalla.json",
        "-t",
        "-O",
      ],
      PROBE_CALL,
      ["exec", "docker-valhalla-1", "chown", CHOWN_ID, "/custom_files/traffic.tar"],
      ["restart", "docker-valhalla-1"],
    ]);
  });

  it("no-ops when the tar is already present", async () => {
    const calls: string[][] = [];
    const runDocker: DockerRunner = vi.fn(async (args: string[]) => {
      calls.push(args);
      return { exitCode: 0, stdout: "" };
    });

    const result = await ensureTrafficExtract({ runDocker, container: "docker-valhalla-1" });

    expect(result).toEqual({ built: false });
    expect(calls).toEqual([
      ["exec", "docker-valhalla-1", "test", "-f", "/custom_files/traffic.tar"],
    ]);
  });

  it("skips the presence check and always rebuilds when force is set", async () => {
    const calls: string[][] = [];
    const runDocker: DockerRunner = vi.fn(async (args: string[]) => {
      calls.push(args);
      return { exitCode: 0, stdout: "" };
    });

    const result = await ensureTrafficExtract({
      runDocker,
      container: "docker-valhalla-1",
      force: true,
    });

    expect(result).toEqual({ built: true });
    expect(calls).toEqual([
      [
        "exec",
        "docker-valhalla-1",
        "valhalla_build_extract",
        "-c",
        "/custom_files/valhalla.json",
        "-t",
        "-O",
      ],
      PROBE_CALL,
      ["exec", "docker-valhalla-1", "chown", CHOWN_ID, "/custom_files/traffic.tar"],
      ["restart", "docker-valhalla-1"],
    ]);
  });

  it("refuses to chown or restart when the built extract has an empty index.bin", async () => {
    const calls: string[][] = [];
    const runDocker: DockerRunner = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[0] === "exec" && args[2] === "test") return { exitCode: 1, stdout: "" };
      // The post-build probe reports a zero-byte index.bin (degenerate extract).
      if (args[2] === "sh") return { exitCode: 0, stdout: "0\n" };
      return { exitCode: 0, stdout: "" };
    });

    await expect(
      ensureTrafficExtract({ runDocker, container: "docker-valhalla-1" }),
    ).rejects.toThrow(/empty index\.bin/);
    // Neither chown nor restart runs once the extract is judged degenerate.
    expect(calls.some((c) => c[2] === "chown" || c[0] === "restart")).toBe(false);
  });

  it("does not restart when the post-build chown fails", async () => {
    const calls: string[][] = [];
    const runDocker: DockerRunner = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[0] === "exec" && args[2] === "test") return { exitCode: 1, stdout: "" };
      if (args[2] === "chown") return { exitCode: 1, stdout: "" };
      return { exitCode: 0, stdout: "" };
    });

    await expect(
      ensureTrafficExtract({ runDocker, container: "docker-valhalla-1" }),
    ).rejects.toThrow(/chown traffic\.tar exited 1/);
    expect(calls.some((c) => c[0] === "restart")).toBe(false);
  });

  it("does not restart or report success when the build exec fails", async () => {
    const calls: string[][] = [];
    const runDocker: DockerRunner = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[0] === "exec" && args[2] === "test") return { exitCode: 1, stdout: "" };
      // The build itself fails with a non-zero exit code.
      if (args[2] === "valhalla_build_extract") return { exitCode: 2, stdout: "" };
      return { exitCode: 0, stdout: "" };
    });

    await expect(
      ensureTrafficExtract({ runDocker, container: "docker-valhalla-1" }),
    ).rejects.toThrow(/valhalla_build_extract exited 2/);

    // No `docker restart` was issued after the failed build.
    expect(calls.some((c) => c[0] === "restart")).toBe(false);
    expect(calls).toEqual([
      ["exec", "docker-valhalla-1", "test", "-f", "/custom_files/traffic.tar"],
      [
        "exec",
        "docker-valhalla-1",
        "valhalla_build_extract",
        "-c",
        "/custom_files/valhalla.json",
        "-t",
        "-O",
      ],
    ]);
  });

  it("propagates a rejecting runner from the build exec without restarting", async () => {
    const calls: string[][] = [];
    const runDocker: DockerRunner = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[0] === "exec" && args[2] === "test") return { exitCode: 1, stdout: "" };
      if (args[2] === "valhalla_build_extract") throw new Error("docker daemon unreachable");
      return { exitCode: 0, stdout: "" };
    });

    await expect(
      ensureTrafficExtract({ runDocker, container: "docker-valhalla-1" }),
    ).rejects.toThrow(/docker daemon unreachable/);
    expect(calls.some((c) => c[0] === "restart")).toBe(false);
  });

  it("falls back to VALHALLA_CONTAINER env var, then the docker-compose default", async () => {
    process.env.VALHALLA_CONTAINER = "my-valhalla";
    const calls: string[][] = [];
    const runDocker: DockerRunner = vi.fn(async (args: string[]) => {
      calls.push(args);
      return { exitCode: 0, stdout: "" };
    });

    await ensureTrafficExtract({ runDocker });

    expect(calls[0]?.[1]).toBe("my-valhalla");

    delete process.env.VALHALLA_CONTAINER;
    calls.length = 0;
    await ensureTrafficExtract({ runDocker });
    expect(calls[0]?.[1]).toBe("docker-valhalla-1");
  });

  it("uses a custom config path when provided", async () => {
    const calls: string[][] = [];
    const runDocker: DockerRunner = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args[0] === "exec" && args[2] === "test") return { exitCode: 1, stdout: "" };
      return { exitCode: 0, stdout: "" };
    });

    await ensureTrafficExtract({
      runDocker,
      container: "docker-valhalla-1",
      configPath: "/custom_files/valhalla-override.json",
    });

    expect(calls[1]).toEqual([
      "exec",
      "docker-valhalla-1",
      "valhalla_build_extract",
      "-c",
      "/custom_files/valhalla-override.json",
      "-t",
      "-O",
    ]);
  });
});

describe("isTrafficExtractStale", () => {
  it("is stale when the traffic.tar is missing outright", async () => {
    const runDocker: DockerRunner = vi.fn(async (args: string[]) => {
      if (args.includes("/custom_files/traffic.tar")) return { exitCode: 1, stdout: "" };
      return { exitCode: 0, stdout: "1000" };
    });

    await expect(
      isTrafficExtractStale({ runDocker, container: "docker-valhalla-1" }),
    ).resolves.toBe(true);
  });

  it("is stale when the tile directory is newer than the traffic.tar", async () => {
    const runDocker: DockerRunner = vi.fn(async (args: string[]) => {
      if (args.includes("/custom_files/valhalla_tiles")) return { exitCode: 0, stdout: "2000" };
      if (args.includes("/custom_files/traffic.tar")) return { exitCode: 0, stdout: "1000" };
      return { exitCode: 1, stdout: "" };
    });

    await expect(
      isTrafficExtractStale({ runDocker, container: "docker-valhalla-1" }),
    ).resolves.toBe(true);
  });

  it("is not stale when the traffic.tar is newer than the tile directory", async () => {
    const runDocker: DockerRunner = vi.fn(async (args: string[]) => {
      if (args.includes("/custom_files/valhalla_tiles")) return { exitCode: 0, stdout: "1000" };
      if (args.includes("/custom_files/traffic.tar")) return { exitCode: 0, stdout: "2000" };
      return { exitCode: 1, stdout: "" };
    });

    await expect(
      isTrafficExtractStale({ runDocker, container: "docker-valhalla-1" }),
    ).resolves.toBe(false);
  });

  it("does not force a rebuild when the tile directory mtime is unreadable", async () => {
    const runDocker: DockerRunner = vi.fn(async (args: string[]) => {
      if (args.includes("/custom_files/valhalla_tiles")) return { exitCode: 1, stdout: "" };
      if (args.includes("/custom_files/traffic.tar")) return { exitCode: 0, stdout: "2000" };
      return { exitCode: 1, stdout: "" };
    });

    await expect(
      isTrafficExtractStale({ runDocker, container: "docker-valhalla-1" }),
    ).resolves.toBe(false);
  });
});
