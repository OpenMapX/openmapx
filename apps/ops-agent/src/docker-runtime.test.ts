import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

    it("runs graph maintenance behind a durable fence while Valhalla is stopped", async () => {
      const dataRoot = mkdtempSync(join(tmpdir(), "valhalla-maintenance-"));
      const calls: string[][] = [];
      const generation = "a".repeat(64);
      try {
        const runtime = createDockerRuntime({
          composeFile: "/trusted/compose.yml",
          releaseComposeFile: "/trusted/release.yml",
          releaseComposeExists: () => false,
          trafficDataRoot: dataRoot,
          execFile: async (_file, args) => {
            calls.push([...args]);
            if (args[0] === "inspect" && args.includes("{{.State.Running}}")) {
              return { stdout: "false\n", stderr: "" };
            }
            if (args[0] === "inspect" && args.includes("{{.Image}}")) {
              return { stdout: `sha256:${"c".repeat(64)}\n`, stderr: "" };
            }
            if (args[0] === "inspect" && args.includes("{{.State.Health.Status}}")) {
              return { stdout: "healthy\n", stderr: "" };
            }
            if (args[0] === "run") {
              return { stdout: `OPENMAPX_GRAPH_GENERATION=${generation}\n`, stderr: "" };
            }
            return { stdout: "", stderr: "" };
          },
        });

        await expect(
          dispatchOpsOperation(
            runtime,
            {
              kind: "valhalla.traffic.maintain",
              plan: "apply-predicted-and-rebuild",
              preparedGeneration: "11111111-1111-4111-8111-111111111111",
            },
            context(),
          ),
        ).resolves.toEqual({
          changed: true,
          graphGeneration: generation,
          extractGeneration: generation,
          waysToEdgesGeneration: generation,
        });

        expect(calls.map((call) => call[0])).toEqual([
          "stop",
          "inspect",
          "inspect",
          "run",
          "start",
          "inspect",
        ]);
        expect(calls[3]).toEqual(
          expect.arrayContaining([
            "--volumes-from",
            "docker-valhalla-1",
            `sha256:${"c".repeat(64)}`,
          ]),
        );
        expect(calls[3]?.join(" ")).toContain(
          "valhalla_add_predicted_traffic -c /custom_files/valhalla.json /custom_files/predicted-csv/11111111-1111-4111-8111-111111111111",
        );
        expect(calls[3]?.join(" ")).toContain("valhalla_build_extract");
        expect(calls[3]?.join(" ")).toContain("valhalla_ways_to_edges");
        expect(existsSync(join(dataRoot, "valhalla", "osm-pbf", ".traffic-maintenance.json"))).toBe(
          false,
        );
        expect(
          JSON.parse(
            readFileSync(join(dataRoot, "valhalla", "osm-pbf", "traffic-generations.json"), "utf8"),
          ),
        ).toMatchObject({
          schemaVersion: 1,
          graphGeneration: generation,
          extractGeneration: generation,
          waysToEdgesGeneration: generation,
        });
      } finally {
        rmSync(dataRoot, { recursive: true, force: true });
      }
    });

    it("leaves serving stopped and the durable fence present when maintenance fails", async () => {
      const dataRoot = mkdtempSync(join(tmpdir(), "valhalla-maintenance-fail-"));
      const calls: string[][] = [];
      try {
        const runtime = createDockerRuntime({
          composeFile: "/trusted/compose.yml",
          releaseComposeFile: "/trusted/release.yml",
          releaseComposeExists: () => false,
          trafficDataRoot: dataRoot,
          execFile: async (_file, args) => {
            calls.push([...args]);
            if (args[0] === "inspect" && args.includes("{{.State.Running}}")) {
              return { stdout: "false\n", stderr: "" };
            }
            if (args[0] === "inspect" && args.includes("{{.Image}}")) {
              return { stdout: `sha256:${"d".repeat(64)}\n`, stderr: "" };
            }
            if (args[0] === "run") throw new Error("build failed");
            return { stdout: "", stderr: "" };
          },
        });

        await expect(
          dispatchOpsOperation(
            runtime,
            { kind: "valhalla.traffic.maintain", plan: "rebuild-extract" },
            context(),
          ),
        ).rejects.toThrow();

        expect(calls.some((call) => call[0] === "start")).toBe(false);
        expect(calls.some((call) => call[0] === "rm" && call[1] === "-f")).toBe(true);
        expect(calls.at(-1)).toEqual([
          "inspect",
          "--format",
          "{{.State.Running}}",
          "docker-valhalla-1",
        ]);
        expect(existsSync(join(dataRoot, "valhalla", "osm-pbf", ".traffic-maintenance.json"))).toBe(
          true,
        );
      } finally {
        rmSync(dataRoot, { recursive: true, force: true });
      }
    });

    it("fails closed when compensation cannot prove the maintenance worker stopped", async () => {
      const dataRoot = mkdtempSync(join(tmpdir(), "valhalla-maintenance-worker-fail-"));
      const maintenanceContainer = `openmapx-valhalla-maint-${"f".repeat(16)}`;
      try {
        const runtime = createDockerRuntime({
          composeFile: "/trusted/compose.yml",
          releaseComposeFile: "/trusted/release.yml",
          releaseComposeExists: () => false,
          trafficDataRoot: dataRoot,
          execFile: async (_file, args) => {
            if (args[0] === "inspect" && args.includes("{{.State.Running}}")) {
              return { stdout: "false\n", stderr: "" };
            }
            if (args[0] === "inspect" && args.includes("{{.Image}}")) {
              return { stdout: `sha256:${"d".repeat(64)}\n`, stderr: "" };
            }
            if (args[0] === "run") throw new Error("build failed");
            if (args[0] === "rm") throw new Error("docker daemon unavailable");
            if (args[0] === "ps") {
              return { stdout: `${maintenanceContainer}\n`, stderr: "" };
            }
            return { stdout: "", stderr: "" };
          },
        });

        await expect(
          dispatchOpsOperation(
            runtime,
            { kind: "valhalla.traffic.maintain", plan: "rebuild-extract" },
            context(),
          ),
        ).rejects.toThrow("maintenance worker could not be terminated");
        expect(existsSync(join(dataRoot, "valhalla", "osm-pbf", ".traffic-maintenance.json"))).toBe(
          true,
        );
      } finally {
        rmSync(dataRoot, { recursive: true, force: true });
      }
    });

    it("fences Valhalla serving when traffic cannot be cleared", async () => {
      const calls: string[][] = [];
      const runtime = runtimeWith(async (_file, args) => {
        calls.push([...args]);
        return { stdout: args[0] === "inspect" ? "false\n" : "", stderr: "" };
      });
      await expect(
        dispatchOpsOperation(runtime, { kind: "valhalla.traffic.disable" }, context()),
      ).resolves.toEqual({ changed: true });
      expect(calls).toEqual([
        ["stop", "--time", "1", "docker-valhalla-1"],
        ["inspect", "--format", "{{.State.Running}}", "docker-valhalla-1"],
      ]);
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

    it("requires a coherent maintenance generation manifest before reporting ready", async () => {
      const dataRoot = mkdtempSync(join(tmpdir(), "valhalla-generation-inspect-"));
      const sharedDir = join(dataRoot, "valhalla", "osm-pbf");
      mkdirSync(sharedDir, { recursive: true });
      const runtime = createDockerRuntime({
        composeFile: "/trusted/compose.yml",
        releaseComposeFile: "/trusted/release.yml",
        releaseComposeExists: () => false,
        trafficDataRoot: dataRoot,
        execFile: async (_file, args) => ({
          stdout:
            args[0] === "exec"
              ? args.at(-1) === "/custom_files/traffic.tar"
                ? "200\n"
                : "100\n"
              : "",
          stderr: "",
        }),
      });

      await expect(
        dispatchOpsOperation(runtime, { kind: "valhalla.traffic.inspect" }, context()),
      ).resolves.toEqual({ state: "not_ready" });

      const generation = "b".repeat(64);
      writeFileSync(
        join(sharedDir, "traffic-generations.json"),
        JSON.stringify({
          schemaVersion: 1,
          graphGeneration: generation,
          extractGeneration: generation,
          waysToEdgesGeneration: generation,
          completedAt: new Date().toISOString(),
        }),
      );
      await expect(
        dispatchOpsOperation(runtime, { kind: "valhalla.traffic.inspect" }, context()),
      ).resolves.toEqual({ state: "ready" });

      rmSync(dataRoot, { recursive: true, force: true });
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
