import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDockerRuntime, runContainedLogProcess, runContainedProcess } from "./docker-runtime";
import { dispatchOpsOperation } from "./runtime";

const context = () => ({
  signal: new AbortController().signal,
  emitLog: () => undefined,
  claim: {
    fingerprint: "f".repeat(64),
    operation: { kind: "docker.status" } as const,
    source: "registry" as const,
    capability: { revisionId: "registry-v1", values: {} },
  },
});

describe("fixed Docker runtime adapters", () => {
  it("maps lifecycle effects to fixed Compose argv without accepting caller argv or paths", async () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const runtime = createDockerRuntime({
      composeFile: "/trusted/docker-compose.generated.yml",
      releaseComposeFile: "/trusted/docker-compose.release.yml",
      releaseComposeExists: () => true,
      execFile: async (file, args) => {
        calls.push({ file, args });
        return { stdout: "ok\n", stderr: "" };
      },
    });

    await dispatchOpsOperation(
      runtime,
      { kind: "service.recreate", serviceId: "motis" },
      context(),
    );
    await dispatchOpsOperation(
      runtime,
      { kind: "service.recreateIsolated", serviceId: "motis" },
      context(),
    );
    expect(calls).toEqual([
      {
        file: "docker",
        args: [
          "compose",
          "-f",
          "/trusted/docker-compose.generated.yml",
          "-f",
          "/trusted/docker-compose.release.yml",
          "up",
          "-d",
          "--force-recreate",
          "motis",
        ],
      },
      {
        file: "docker",
        args: [
          "compose",
          "-f",
          "/trusted/docker-compose.generated.yml",
          "-f",
          "/trusted/docker-compose.release.yml",
          "up",
          "-d",
          "--force-recreate",
          "--no-deps",
          "motis",
        ],
      },
    ]);
  });

  it("uses fixed container identities for MOTIS effects", async () => {
    const calls: string[][] = [];
    const runtime = createDockerRuntime({
      composeFile: "/trusted/compose.yml",
      releaseComposeFile: "/trusted/release.yml",
      releaseComposeExists: () => false,
      execFile: async (_file, args) => {
        calls.push([...args]);
        return { stdout: "", stderr: "" };
      },
    });
    await dispatchOpsOperation(runtime, { kind: "motis.staging.restart" }, context());
    await dispatchOpsOperation(runtime, { kind: "motis.primary.stop" }, context());
    expect(calls).toEqual([
      ["restart", "motis-staging"],
      ["stop", "motis"],
    ]);
  });

  it("owns the container and path for data-manager capacity and feed-proxy effects", async () => {
    const calls: string[][] = [];
    const runtime = createDockerRuntime({
      composeFile: "/trusted/compose.yml",
      releaseComposeFile: "/trusted/release.yml",
      releaseComposeExists: () => false,
      execFile: async (_file, args) => {
        calls.push([...args]);
        return {
          stdout:
            "Filesystem 1024-blocks Used Available Capacity Mounted on\n" +
            "/dev/vdb 100000 20000 80000 20% /var/lib/postgresql",
          stderr: "",
        };
      },
    });

    await expect(
      dispatchOpsOperation(runtime, { kind: "postgis.capacity.inspect" }, context()),
    ).resolves.toEqual({ availableBytes: 81_920_000 });
    await expect(
      dispatchOpsOperation(
        runtime,
        { kind: "feedProxy.validateAndReload", candidateId: "feedproxy-1" },
        context(),
      ),
    ).resolves.toEqual({ candidateId: "feedproxy-1", reloaded: true });

    // The caller supplied neither a container nor a path, and the proxy is
    // validated before it is reloaded.
    expect(calls).toEqual([
      ["exec", "postgis", "df", "-Pk", "/var/lib/postgresql"],
      ["exec", "motis-feed-proxy", "nginx", "-t"],
      ["exec", "motis-feed-proxy", "nginx", "-s", "reload"],
    ]);
  });

  describe("Valhalla traffic effects", () => {
    const CHOWN_ID = `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`;
    const runtimeWith = (execFile: (file: string, args: readonly string[]) => Promise<unknown>) =>
      createDockerRuntime({
        composeFile: "/trusted/compose.yml",
        releaseComposeFile: "/trusted/release.yml",
        releaseComposeExists: () => false,
        execFile: execFile as never,
      });

    it("builds, validates, hands over ownership, and only then restarts", async () => {
      const calls: string[][] = [];
      const runtime = runtimeWith(async (_file, args) => {
        calls.push([...args]);
        // A non-empty index.bin proves the extract has tiles.
        return { stdout: args.some((arg) => arg.includes("wc -c")) ? "1600\n" : "", stderr: "" };
      });

      await expect(
        dispatchOpsOperation(runtime, { kind: "valhalla.traffic.rebuild" }, context()),
      ).resolves.toEqual({ changed: true });

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
        [
          "exec",
          "docker-valhalla-1",
          "sh",
          "-c",
          "tar xOf /custom_files/traffic.tar index.bin 2>/dev/null | wc -c",
        ],
        ["exec", "docker-valhalla-1", "chown", CHOWN_ID, "/custom_files/traffic.tar"],
        ["restart", "docker-valhalla-1"],
      ]);
    });

    it("refuses to chown or restart when the built extract has an empty index", async () => {
      const calls: string[][] = [];
      const runtime = runtimeWith(async (_file, args) => {
        calls.push([...args]);
        return { stdout: args.some((arg) => arg.includes("wc -c")) ? "0\n" : "", stderr: "" };
      });

      await expect(
        dispatchOpsOperation(runtime, { kind: "valhalla.traffic.rebuild" }, context()),
      ).rejects.toThrow(/empty index/);
      expect(calls.some((call) => call.includes("chown") || call[0] === "restart")).toBe(false);
    });

    it("does not restart or report success when the build itself fails", async () => {
      const calls: string[][] = [];
      const runtime = runtimeWith(async (_file, args) => {
        calls.push([...args]);
        if (args.includes("valhalla_build_extract")) throw new Error("build failed");
        return { stdout: "", stderr: "" };
      });

      await expect(
        dispatchOpsOperation(runtime, { kind: "valhalla.traffic.rebuild" }, context()),
      ).rejects.toThrow(/valhalla_build_extract failed/);
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
      ]);
    });

    it("does not restart when the ownership handover fails", async () => {
      const calls: string[][] = [];
      const runtime = runtimeWith(async (_file, args) => {
        calls.push([...args]);
        if (args.includes("chown")) throw new Error("chown failed");
        return { stdout: args.some((arg) => arg.includes("wc -c")) ? "1600\n" : "", stderr: "" };
      });

      await expect(
        dispatchOpsOperation(runtime, { kind: "valhalla.traffic.rebuild" }, context()),
      ).rejects.toThrow(/chown failed/);
      expect(calls.some((call) => call[0] === "restart")).toBe(false);
    });

    it("reports readiness from the tile and extract timestamps", async () => {
      const inspect = async (tile: string | null, tar: string | null) => {
        const runtime = runtimeWith(async (_file, args) => {
          const path = args.at(-1);
          const value = path === "/custom_files/valhalla_tiles" ? tile : tar;
          if (value === null) throw new Error("stat failed");
          return { stdout: `${value}\n`, stderr: "" };
        });
        return dispatchOpsOperation(runtime, { kind: "valhalla.traffic.inspect" }, context());
      };

      // No extract at all.
      await expect(inspect("200", null)).resolves.toEqual({ state: "not_ready" });
      // Tiles newer than the extract.
      await expect(inspect("300", "200")).resolves.toEqual({ state: "not_ready" });
      // Extract newer than the tiles.
      await expect(inspect("100", "200")).resolves.toEqual({ state: "ready" });
      // Unreadable tile directory with an extract present is inconclusive, not
      // a rebuild trigger.
      await expect(inspect(null, "200")).resolves.toEqual({ state: "unknown" });
    });

    it("produces way_edges.txt on the shared mount and hands it to the data owner", async () => {
      const calls: string[][] = [];
      const runtime = runtimeWith(async (_file, args) => {
        calls.push([...args]);
        return { stdout: "", stderr: "" };
      });

      await expect(
        dispatchOpsOperation(runtime, { kind: "valhalla.traffic.refreshWaysToEdges" }, context()),
      ).resolves.toEqual({ changed: true });

      expect(calls).toEqual([
        [
          "exec",
          "docker-valhalla-1",
          "valhalla_ways_to_edges",
          "-c",
          "/custom_files/valhalla.json",
        ],
        [
          "exec",
          "docker-valhalla-1",
          "chown",
          CHOWN_ID,
          "/custom_files/valhalla_tiles/way_edges.txt",
        ],
      ]);
    });
  });

  it("fails closed for complex typed effects that later migration slices must wire", async () => {
    const runtime = createDockerRuntime({
      composeFile: "/trusted/compose.yml",
      releaseComposeFile: "/trusted/release.yml",
      releaseComposeExists: () => false,
      execFile: async () => ({ stdout: "", stderr: "" }),
    });
    await expect(
      dispatchOpsOperation(runtime, { kind: "stack.render", revisionId: "revision_1" }, context()),
    ).rejects.toMatchObject({
      name: "OpsNotWiredError",
    });
    await expect(
      dispatchOpsOperation(runtime, { kind: "stack.stop" }, context()),
    ).rejects.toMatchObject({ name: "OpsNotWiredError" });
    await expect(
      dispatchOpsOperation(runtime, { kind: "service.update", serviceId: "app-api" }, context()),
    ).rejects.toMatchObject({ name: "OpsNotWiredError" });
  });

  it("inspects only the fixed Dawarich services and provisioning marker", async () => {
    const calls: string[][] = [];
    const runtime = createDockerRuntime({
      composeFile: "/trusted/compose.yml",
      releaseComposeFile: "/trusted/release.yml",
      releaseComposeExists: () => false,
      execFile: async (_file, args) => {
        calls.push([...args]);
        if (args.includes("ps")) {
          return {
            stdout: JSON.stringify([
              { Service: "dawarich-app", State: "running" },
              { Service: "dawarich-sidekiq", State: "running" },
              { Service: "dawarich-postgis", State: "running" },
              { Service: "dawarich-redis", State: "running" },
            ]),
            stderr: "",
          };
        }
        return {
          stdout: args.includes("dawarich-app")
            ? "0123456789abcdef0123456789abcdef\n"
            : "fedcba9876543210fedcba9876543210\n",
          stderr: "",
        };
      },
    });

    await expect(
      dispatchOpsOperation(runtime, { kind: "dawarich.provisioning.inspect" }, context()),
    ).resolves.toEqual({
      services: [
        { serviceId: "dawarich-app", state: "running" },
        { serviceId: "dawarich-sidekiq", state: "running" },
        { serviceId: "dawarich-postgis", state: "running" },
        { serviceId: "dawarich-redis", state: "running" },
      ],
      appliedGenerations: {
        app: "0123456789abcdef0123456789abcdef",
        worker: "fedcba9876543210fedcba9876543210",
      },
    });
    expect(calls).toEqual([
      ["compose", "-f", "/trusted/compose.yml", "ps", "--format", "json"],
      [
        "compose",
        "-f",
        "/trusted/compose.yml",
        "exec",
        "-T",
        "dawarich-app",
        "printenv",
        "OPENMAPX_PROVISIONING_GENERATION",
      ],
      [
        "compose",
        "-f",
        "/trusted/compose.yml",
        "exec",
        "-T",
        "dawarich-sidekiq",
        "printenv",
        "OPENMAPX_PROVISIONING_GENERATION",
      ],
    ]);
  });

  it("follows one fixed service with a bounded duration and typed event emitter", async () => {
    const emitted: Array<{ stream: "stdout" | "stderr"; message: string }> = [];
    const followLogs = vi.fn(async (_file, args, options) => {
      expect(args).toEqual([
        "compose",
        "-f",
        "/trusted/compose.yml",
        "logs",
        "-f",
        "--no-color",
        "--tail=20",
        "redis",
      ]);
      expect(options.timeout).toBe(3_000);
      options.onLine("stdout", "ready");
      options.onLine("stderr", "bounded warning");
      return { lines: 2, truncated: false };
    });
    const runtime = createDockerRuntime({
      composeFile: "/trusted/compose.yml",
      releaseComposeFile: "/trusted/release.yml",
      releaseComposeExists: () => false,
      execFile: async () => ({ stdout: "", stderr: "" }),
      followLogs,
    });

    await expect(
      dispatchOpsOperation(
        runtime,
        {
          kind: "service.logs.follow",
          serviceId: "redis",
          tail: 20,
          maxDurationSeconds: 3,
        },
        {
          ...context(),
          emitLog: (stream, message) => emitted.push({ stream, message }),
        },
      ),
    ).resolves.toEqual({ lines: 2, truncated: false });
    expect(emitted).toEqual([
      { stream: "stdout", message: "ready" },
      { stream: "stderr", message: "bounded warning" },
    ]);
  });

  it("bounds snapshot log lines in UTF-8 bytes and reports truncation", async () => {
    const runtime = createDockerRuntime({
      composeFile: "/trusted/compose.yml",
      releaseComposeFile: "/trusted/release.yml",
      releaseComposeExists: () => false,
      execFile: async () => ({ stdout: `${"😀".repeat(1_500)}\nsecond\nthird\n`, stderr: "" }),
    });
    const result = await dispatchOpsOperation(
      runtime,
      { kind: "service.logs", serviceId: "redis", tail: 2 },
      context(),
    );
    expect(result.truncated).toBe(true);
    expect(result.lines).toHaveLength(2);
    expect(Buffer.byteLength(result.lines[0] ?? "", "utf8")).toBeLessThanOrEqual(4_096);
  });

  it("decodes split UTF-8 follow chunks and contains callback failures", async () => {
    const messages: string[] = [];
    await expect(
      runContainedLogProcess(
        process.execPath,
        [
          "-e",
          "process.stdout.write(Buffer.from([0xf0,0x9f])); setTimeout(()=>process.stdout.end(Buffer.from([0x98,0x80,0x0a])),10)",
        ],
        {
          signal: new AbortController().signal,
          timeout: 1_000,
          maxBuffer: 1_024,
          onLine: (_stream, message) => messages.push(message),
        },
      ),
    ).resolves.toEqual({ lines: 1, truncated: false });
    expect(messages).toEqual(["😀"]);

    await expect(
      runContainedLogProcess(process.execPath, ["-e", "console.log('line')"], {
        signal: new AbortController().signal,
        timeout: 1_000,
        maxBuffer: 1_024,
        onLine: () => {
          throw new Error("sink secret");
        },
      }),
    ).rejects.toThrow("Contained log process failed");
  });

  it("caps newline-flood event work and reports self-limit truncation", async () => {
    let emitted = 0;
    await expect(
      runContainedLogProcess(
        process.execPath,
        ["-e", "process.stdout.write('x\\n'.repeat(600000)); setInterval(()=>{},1000)"],
        {
          signal: new AbortController().signal,
          timeout: 200,
          maxBuffer: 1024 * 1024,
          onLine: () => {
            emitted += 1;
          },
        },
      ),
    ).resolves.toEqual({ lines: 2_000, truncated: true });
    expect(emitted).toBe(2_000);
  });

  it.each([
    ["nonzero", "process.stdout.write('x'.repeat(5000)+'\\n'); process.exit(7)"],
    ["signal", "process.stdout.write('x'.repeat(5000)+'\\n'); process.kill(process.pid,'SIGTERM')"],
  ])("does not hide a real child %s after content truncation", async (_label, script) => {
    await expect(
      runContainedLogProcess(process.execPath, ["-e", script], {
        signal: new AbortController().signal,
        timeout: 5_000,
        maxBuffer: 1024 * 1024,
        onLine: () => undefined,
      }),
    ).rejects.toThrow("Contained log process failed");
  });

  it("terminates a signal-ignoring child and bounds captured output", async () => {
    const controller = new AbortController();
    const root = mkdtempSync(join(tmpdir(), "openmapx-contained-child-"));
    const ready = join(root, "ready");
    const startedAt = Date.now();
    const hung = runContainedProcess(
      process.execPath,
      [
        "-e",
        "require('node:fs').writeFileSync(process.argv[1],'ready'); process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)",
        ready,
      ],
      { signal: controller.signal, timeout: 5_000, maxBuffer: 1_024, killGraceMs: 20 },
    );
    for (let attempt = 0; attempt < 100 && !existsSync(ready); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(existsSync(ready)).toBe(true);
    controller.abort();
    await expect(hung).rejects.toThrow("Contained process failed");
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    rmSync(root, { recursive: true, force: true });

    await expect(
      runContainedProcess(process.execPath, ["-e", "process.stdout.write('x'.repeat(2048))"], {
        signal: new AbortController().signal,
        timeout: 5_000,
        maxBuffer: 1_024,
        killGraceMs: 20,
      }),
    ).rejects.toThrow("Contained process failed");
  });

  it.each(["action", "follow"] as const)(
    "contains a residual TERM-ignoring descendant for %s authority",
    async (kind) => {
      const root = mkdtempSync(join(tmpdir(), "openmapx-contained-group-"));
      const marker = join(root, "late-side-effect");
      const grandchildScript = [
        'const { writeFileSync } = require("node:fs")',
        'process.on("SIGTERM", () => {})',
        `setTimeout(() => writeFileSync(${JSON.stringify(marker)}, "late"), 2_400)`,
        "setInterval(() => {}, 1000)",
      ].join(";");
      const parentScript = [
        'const { spawn } = require("node:child_process")',
        `spawn(process.execPath, ["-e", ${JSON.stringify(grandchildScript)}], { stdio: "ignore" })`,
        "setTimeout(() => process.exit(0), 50)",
      ].join(";");

      const operation =
        kind === "action"
          ? runContainedProcess(process.execPath, ["-e", parentScript], {
              signal: new AbortController().signal,
              timeout: 5_000,
              maxBuffer: 1_024,
              killGraceMs: 20,
            })
          : runContainedLogProcess(process.execPath, ["-e", parentScript], {
              signal: new AbortController().signal,
              timeout: 5_000,
              maxBuffer: 1_024,
              onLine: () => undefined,
            });

      await expect(operation).rejects.toThrow(/Contained .*process failed/);
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      expect(existsSync(marker)).toBe(false);
      rmSync(root, { recursive: true, force: true });
    },
    12_000,
  );
});
