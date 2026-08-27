import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpsOperation } from "@openmapx/core/ops";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAdministrativeRuntime,
  createDefaultReleaseEffects,
  inspectBackupAuthority,
  inspectDataTypeAuthority,
  inspectRegionAuthority,
  inspectReleaseAuthority,
  loadConfiguredResourceAuthority,
} from "./administrative-runtime";
import { createUnavailableRuntime, dispatchOpsOperation } from "./runtime";

const temporaryRoots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "openmapx-admin-runtime-"));
  temporaryRoots.push(root);
  mkdirSync(join(root, "infra", "docker", "backups"), { recursive: true });
  return root;
}

function context(kind: string) {
  return {
    signal: new AbortController().signal,
    emitLog: vi.fn(),
    claim: {
      fingerprint: "f".repeat(64),
      operation: { kind } as never,
      source: "registry" as const,
      capability: { revisionId: "registry-v1", values: {} },
    },
  };
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe("administrative backup runtime", () => {
  it("maps typed backup effects to exact fixed CLI argv without a path or general runner", async () => {
    const rootDir = temporaryRoot();
    // Restore revalidates the exact manifest bytes before dispatch, so the
    // backup must really exist and declare the requested services.
    const backup = join(rootDir, "infra", "docker", "backups", "nightly-20260823");
    mkdirSync(backup, { mode: 0o700, recursive: true });
    writeFileSync(
      join(backup, "manifest.json"),
      JSON.stringify({
        name: "nightly-20260823",
        createdAt: "2026-08-23T18:00:00.000Z",
        openmapxVersion: "1.0.0",
        services: [
          { id: "postgis", version: "1.0.0", volumes: [] },
          { id: "redis", version: "1.0.0", volumes: [] },
        ],
      }),
      { mode: 0o600 },
    );
    const calls: string[][] = [];
    const runtime = createUnavailableRuntime();
    createAdministrativeRuntime(runtime, {
      rootDir,
      runFixedCli: async (args, options) => {
        calls.push([...args]);
        options.emitLog("stdout", "bounded progress");
      },
    });

    await dispatchOpsOperation(
      runtime,
      { kind: "backup.create", backupId: "nightly-20260823" },
      context("backup.create"),
    );
    // Restore revalidates the manifest through the descriptor-anchored reader,
    // which needs `/proc/self/fd`. Its authority gate already required Linux.
    if (process.platform === "linux") {
      await dispatchOpsOperation(
        runtime,
        {
          kind: "backup.restore",
          backupId: "nightly-20260823",
          serviceIds: ["postgis", "redis"],
          stopRunning: true,
        },
        context("backup.restore"),
      );
    }
    await dispatchOpsOperation(
      runtime,
      { kind: "backup.delete", backupId: "nightly-20260823" },
      context("backup.delete"),
    );

    expect(calls).toEqual([
      ["backup", "create", "--name", "nightly-20260823"],
      ...(process.platform === "linux"
        ? [
            [
              "backup",
              "restore",
              "nightly-20260823",
              "--services",
              "postgis",
              "redis",
              "--stop-running",
            ],
          ]
        : []),
      ["backup", "delete", "nightly-20260823"],
    ]);
    expect(context("backup.create").emitLog).not.toHaveBeenCalled();
  });

  it.runIf(process.platform === "linux")(
    "loads a bounded newest-first agent-owned inventory and never returns a host path",
    async () => {
      const rootDir = temporaryRoot();
      const valid = join(rootDir, "infra", "docker", "backups", "nightly-20260823");
      mkdirSync(valid, { mode: 0o700 });
      writeFileSync(
        join(valid, "manifest.json"),
        JSON.stringify({
          name: "nightly-20260823",
          createdAt: "2026-08-23T18:00:00.000Z",
          openmapxVersion: "1.0.0",
          services: [
            {
              id: "postgis",
              version: "1.0.0",
              volumes: [{ name: "db", file: "postgis__db.sql.gz", mode: "pg_dump", sizeBytes: 42 }],
            },
          ],
        }),
        { mode: 0o600 },
      );
      const older = join(rootDir, "infra", "docker", "backups", "nightly-20260822");
      mkdirSync(older, { mode: 0o700 });
      writeFileSync(
        join(older, "manifest.json"),
        JSON.stringify({
          name: "nightly-20260822",
          createdAt: "2026-08-22T18:00:00.000Z",
          openmapxVersion: "1.0.0",
          services: [],
        }),
        { mode: 0o600 },
      );
      const corrupt = join(rootDir, "infra", "docker", "backups", "corrupt-entry");
      mkdirSync(corrupt, { mode: 0o700 });

      const runtime = createUnavailableRuntime();
      createAdministrativeRuntime(runtime, {
        rootDir,
        runFixedCli: async () => undefined,
      });
      const result = await dispatchOpsOperation(
        runtime,
        { kind: "backup.list" },
        context("backup.list"),
      );
      expect(result).toEqual({
        backups: [
          expect.objectContaining({
            backupId: "nightly-20260823",
            serviceCount: 1,
            volumeCount: 1,
            totalBytes: 42,
          }),
          expect.objectContaining({
            backupId: "nightly-20260822",
            serviceCount: 0,
            volumeCount: 0,
            totalBytes: 0,
          }),
          expect.objectContaining({
            backupId: "corrupt-entry",
            corrupt: true,
            corruptReason: "missing_manifest",
          }),
        ],
        warningCount: 1,
      });
      expect(JSON.stringify(result)).not.toContain(rootDir);
    },
  );

  it.runIf(process.platform === "linux")(
    "authorizes create only for an absent ID and restore/delete only for a valid present ID",
    async () => {
      const rootDir = temporaryRoot();
      const backup = join(rootDir, "infra", "docker", "backups", "present");
      mkdirSync(backup, { mode: 0o700 });
      writeFileSync(
        join(backup, "manifest.json"),
        JSON.stringify({
          name: "present",
          createdAt: "2026-08-23T18:00:00.000Z",
          openmapxVersion: "1.0.0",
          services: [],
        }),
        { mode: 0o600 },
      );

      await expect(inspectBackupAuthority(rootDir, "backup.create", "fresh")).resolves.toBe(true);
      await expect(inspectBackupAuthority(rootDir, "backup.create", "present")).resolves.toBe(
        false,
      );
      await expect(inspectBackupAuthority(rootDir, "backup.restore", "present")).resolves.toBe(
        true,
      );
      await expect(inspectBackupAuthority(rootDir, "backup.delete", "present")).resolves.toBe(true);
      await expect(inspectBackupAuthority(rootDir, "backup.restore", "fresh")).resolves.toBe(false);
    },
  );
});

describe("administrative data runtime", () => {
  it("validates region and data-type IDs against agent-owned authority", () => {
    expect(inspectRegionAuthority("europe/germany")).toBe(true);
    expect(inspectRegionAuthority("europe/invented")).toBe(false);
    expect(inspectRegionAuthority("../etc")).toBe(false);
    expect(inspectRegionAuthority("--region")).toBe(false);
    const services = [
      {
        manifest: {
          produces: [{ type: "osm-pbf" }],
          consumes: [{ type: "tile-fonts" }],
        },
      },
    ];
    expect(inspectDataTypeAuthority(services, "osm-pbf")).toBe(true);
    expect(inspectDataTypeAuthority(services, "osm")).toBe(true);
    expect(inspectDataTypeAuthority(services, "all")).toBe(true);
    expect(inspectDataTypeAuthority(services, "unknown")).toBe(false);
    expect(inspectDataTypeAuthority(services, "--all")).toBe(false);
  });

  it("loads exact canonical region/country authority with a revision that changes on refresh", () => {
    const first = loadConfiguredResourceAuthority({
      OPENMAPX_ALLOWED_REGIONS: "europe/germany,planet",
      OPENMAPX_ALLOWED_COUNTRIES: "DE,AT",
    });
    expect([...first.regions]).toEqual(["europe/germany", "planet"]);
    expect([...first.countries]).toEqual(["AT", "DE"]);
    expect(first.regions.has("Europe/Germany")).toBe(false);
    expect(first.countries.has("de")).toBe(false);
    const refreshed = loadConfiguredResourceAuthority({
      OPENMAPX_ALLOWED_REGIONS: "europe/france",
      OPENMAPX_ALLOWED_COUNTRIES: "FR",
    });
    expect(refreshed.revisionId).not.toBe(first.revisionId);
    expect(refreshed.regions.has("europe/germany")).toBe(false);
    expect(() =>
      loadConfiguredResourceAuthority({
        OPENMAPX_ALLOWED_REGIONS: "europe/germany,europe/germany",
      }),
    ).toThrow("Resource authority configuration rejected");
  });

  it("maps every typed variant to fixed agent-owned CLI arguments", async () => {
    const rootDir = temporaryRoot();
    const calls: string[][] = [];
    const runtime = createUnavailableRuntime();
    createAdministrativeRuntime(runtime, {
      rootDir,
      runFixedCli: async (args) => {
        calls.push([...args]);
      },
    });
    const operations: OpsOperation[] = [
      { kind: "data.downloadOsm", regionId: "europe/germany" },
      { kind: "data.downloadFonts" },
      {
        kind: "data.update",
        regionId: "europe/germany",
        countryCodes: ["DE", "AT"],
        failFast: true,
      },
      { kind: "data.convertOverpass", regionId: "europe/germany" },
      { kind: "data.link" },
      { kind: "data.clean", dataTypeId: "osm" },
      { kind: "data.generateApiKeys", catalogRevisionId: "transitous-fixed-v1" },
      { kind: "data.overtureSync", regionId: "europe/germany" },
      { kind: "data.overtureConflate", regionId: "europe/germany", restart: true },
      { kind: "data.searchIndexBuild", regionId: "europe/germany" },
    ];
    for (const operation of operations) {
      await dispatchOpsOperation(runtime, operation, context(operation.kind));
    }
    expect(calls).toEqual([
      ["data", "download", "osm", "europe/germany"],
      ["data", "download", "fonts"],
      ["data", "update", "europe/germany", "--countries", "DE,AT", "--fail-fast"],
      ["data", "convert", "overpass", "europe/germany"],
      ["data", "link"],
      ["data", "clean", "osm"],
      ["data", "generate-api-keys"],
      ["data", "overture-sync", "europe/germany"],
      ["data", "overture-conflate", "europe/germany", "--restart"],
      ["data", "search-index", "build", "europe/germany"],
    ]);
    expect(calls.flat()).not.toContain("transitous-fixed-v1");
  });

  it.runIf(process.platform === "linux")(
    "returns bounded data inventory from the agent-owned root without a host path",
    async () => {
      const rootDir = temporaryRoot();
      const dataRoot = join(rootDir, "infra", "docker", "data");
      mkdirSync(join(dataRoot, "osm"), { recursive: true });
      mkdirSync(join(dataRoot, "valhalla"), { recursive: true });
      writeFileSync(join(dataRoot, "osm", "germany-latest.osm.pbf"), "pbf", { mode: 0o600 });
      const runtime = createUnavailableRuntime();
      createAdministrativeRuntime(runtime, {
        rootDir,
        runFixedCli: async () => undefined,
      });

      const result = await dispatchOpsOperation(
        runtime,
        { kind: "data.inspect" },
        context("data.inspect"),
      );
      expect(result.osm).toMatchObject({
        found: true,
        filename: "germany-latest.osm.pbf",
        sizeBytes: 3,
        region: "germany",
      });
      expect(result.builds).toContainEqual(
        expect.objectContaining({ target: "valhalla", built: true }),
      );
      expect(result.motisTransitous).toMatchObject({
        configFound: false,
        capabilityState: "missing",
      });
      expect(JSON.stringify(result)).not.toContain(rootDir);
    },
  );
});

describe("administrative build runtime", () => {
  const buildAuthority = [
    { serviceId: "valhalla", enabled: true, isBuiltIn: true, buildCommand: "valhalla" },
    { serviceId: "nominatim", enabled: true, isBuiltIn: true, buildCommand: "nominatim" },
    { serviceId: "redis", enabled: true, isBuiltIn: true },
    { serviceId: "disabled", enabled: false, isBuiltIn: true, buildCommand: "disabled" },
    { serviceId: "community", enabled: true, isBuiltIn: false, buildCommand: "community" },
  ] as const;

  it("wires selected builds to one fixed independently-authorized CLI effect", async () => {
    const calls: string[][] = [];
    const runtime = createUnavailableRuntime();
    createAdministrativeRuntime(runtime, {
      rootDir: temporaryRoot(),
      loadBuildAuthority: async () => buildAuthority,
      runFixedCli: async (args) => {
        calls.push([...args]);
      },
    });
    await expect(
      dispatchOpsOperation(
        runtime,
        { kind: "service.build", serviceId: "valhalla", regionId: "europe/germany" },
        context("service.build"),
      ),
    ).resolves.toEqual({ completed: true });
    expect(calls).toEqual([["services", "build", "valhalla", "--region", "europe/germany"]]);
  });

  it("derives build-all IDs inside the agent and preserves continue semantics", async () => {
    const calls: string[][] = [];
    const runtime = createUnavailableRuntime();
    createAdministrativeRuntime(runtime, {
      rootDir: temporaryRoot(),
      loadBuildAuthority: async () => buildAuthority,
      runFixedCli: async (args) => {
        calls.push([...args]);
        if (args.includes("valhalla")) throw new Error("injected build failure");
      },
    });
    await expect(
      dispatchOpsOperation(
        runtime,
        { kind: "services.buildAll", regionId: "europe/germany" },
        context("services.buildAll"),
      ),
    ).resolves.toEqual({
      completedServiceIds: ["nominatim"],
      failedServiceIds: ["valhalla"],
    });
    expect(calls).toEqual([
      ["services", "build", "nominatim", "--region", "europe/germany"],
      ["services", "build", "valhalla", "--region", "europe/germany"],
    ]);
  });

  it("fails fast, returns empty for no build handlers, and rejects disabled/custom/nonbuild IDs", async () => {
    const calls: string[][] = [];
    const runtime = createUnavailableRuntime();
    createAdministrativeRuntime(runtime, {
      rootDir: temporaryRoot(),
      loadBuildAuthority: async () => buildAuthority,
      runFixedCli: async (args) => {
        calls.push([...args]);
        throw new Error("injected build failure");
      },
    });
    await expect(
      dispatchOpsOperation(
        runtime,
        { kind: "services.buildAll", failFast: true },
        context("services.buildAll"),
      ),
    ).rejects.toThrow("injected build failure");
    expect(calls).toHaveLength(1);
    for (const serviceId of ["redis", "disabled", "community", "unknown"]) {
      await expect(
        dispatchOpsOperation(
          runtime,
          { kind: "service.build", serviceId },
          context("service.build"),
        ),
      ).rejects.toThrow("Build authority rejected");
    }
    const empty = createUnavailableRuntime();
    createAdministrativeRuntime(empty, {
      rootDir: temporaryRoot(),
      loadBuildAuthority: async () => [],
      runFixedCli: async () => undefined,
    });
    await expect(
      dispatchOpsOperation(empty, { kind: "services.buildAll" }, context("services.buildAll")),
    ).resolves.toEqual({ completedServiceIds: [], failedServiceIds: [] });
  });
});

describe("administrative diagnostics runtime", () => {
  it("runs only the fixed diagnostics command and returns a bounded typed result", async () => {
    const calls: string[][] = [];
    const runtime = createUnavailableRuntime();
    createAdministrativeRuntime(runtime, {
      rootDir: temporaryRoot(),
      runFixedCli: async (args) => {
        calls.push([...args]);
      },
    });
    await expect(
      dispatchOpsOperation(runtime, { kind: "system.diagnostics" }, context("system.diagnostics")),
    ).resolves.toEqual({ ok: true, checks: [] });
    expect(calls).toEqual([["check"]]);
  });
});

describe("administrative release runtime", () => {
  it("stores immutable canonical release IDs with exact-content idempotency and bounded pre-reads", async () => {
    const rootDir = temporaryRoot();
    const release = "immutable-release";
    const makeManifest = (digit: string) => ({
      schemaVersion: 1 as const,
      release,
      images: Object.fromEntries(
        [
          "api",
          "web",
          "data-manager",
          "ops-agent",
          "transitous-runner",
          "transitous-tools",
          "docs",
        ].map((name) => [name, `ghcr.io/openmapx/${name}@sha256:${digit.repeat(64)}`]),
      ),
    });
    let manifestText = JSON.stringify(makeManifest("4"));
    const docker = async (args: readonly string[]) => {
      if (args[0] === "create") return "a".repeat(64);
      if (args[0] === "cp") {
        writeFileSync(args.at(-1) as string, manifestText, { mode: 0o600 });
      }
      return "";
    };
    const context = { signal: new AbortController().signal, emitLog: vi.fn() };
    const first = createDefaultReleaseEffects(rootDir, async () => undefined, {
      runDocker: docker,
    });
    await expect(first.resolve(context)).resolves.toBe(release);
    await expect(first.resolve(context)).resolves.toBe(release);
    manifestText = JSON.stringify(makeManifest("5"));
    await expect(first.resolve(context)).rejects.toThrow("Release authority rejected");
    expect(
      readFileSync(
        join(rootDir, "infra", "docker", ".ops-agent-releases", `${release}.json`),
        "utf8",
      ),
    ).toContain("4".repeat(64));

    manifestText = "x".repeat(32 * 1024 + 1);
    await expect(first.resolve(context)).rejects.toThrow();
  });

  it("uses the durable latest pointer instead of lexical release-ID ordering", async () => {
    const rootDir = temporaryRoot();
    const directory = join(rootDir, "infra", "docker", ".ops-agent-releases");
    mkdirSync(directory, { mode: 0o700 });
    const makeManifest = (release: string, digit: string) => ({
      schemaVersion: 1 as const,
      release,
      images: Object.fromEntries(
        [
          "api",
          "web",
          "data-manager",
          "ops-agent",
          "transitous-runner",
          "transitous-tools",
          "docs",
        ].map((name) => [name, `ghcr.io/openmapx/${name}@sha256:${digit.repeat(64)}`]),
      ),
    });
    const latest = makeManifest("a-new", "1");
    writeFileSync(join(directory, "z-old.json"), JSON.stringify(makeManifest("z-old", "2")), {
      mode: 0o600,
    });
    writeFileSync(join(directory, "a-new.json"), JSON.stringify(latest), { mode: 0o600 });
    const { createHash } = await import("node:crypto");
    writeFileSync(
      join(directory, "latest.json"),
      JSON.stringify({
        releaseId: "a-new",
        digest: createHash("sha256").update(JSON.stringify(latest)).digest("hex"),
      }),
      { mode: 0o600 },
    );
    const effects = createDefaultReleaseEffects(rootDir, async () => undefined);
    await expect(effects.inspect()).resolves.toEqual({ availableReleaseId: "a-new" });
  });

  it("enforces release entry and aggregate bounds before registry reads", async () => {
    const rootDir = temporaryRoot();
    const directory = join(rootDir, "infra", "docker", ".ops-agent-releases");
    mkdirSync(directory, { mode: 0o700 });
    for (let index = 0; index < 65; index += 1) {
      writeFileSync(join(directory, `release-${index}.json`), "{}", { mode: 0o600 });
    }
    const effects = createDefaultReleaseEffects(rootDir, async () => undefined);
    await expect(effects.initialize?.()).rejects.toThrow("Release store limit exceeded");
  });

  it("holds the entry bound when two resolutions race the same near-full store", async () => {
    const rootDir = temporaryRoot();
    const directory = join(rootDir, "infra", "docker", ".ops-agent-releases");
    mkdirSync(directory, { mode: 0o700 });
    const stored = (release: string) =>
      JSON.stringify({
        schemaVersion: 1,
        release,
        images: Object.fromEntries(
          [
            "api",
            "web",
            "data-manager",
            "ops-agent",
            "transitous-runner",
            "transitous-tools",
            "docs",
          ].map((name) => [name, `ghcr.io/openmapx/${name}@sha256:${"3".repeat(64)}`]),
        ),
      });
    for (let index = 0; index < 63; index += 1) {
      writeFileSync(join(directory, `release-${index}.json`), stored(`release-${index}`), {
        mode: 0o600,
      });
    }

    // Both resolutions read the store, then both await Docker. Before the lock
    // each published against its own stale pre-await snapshot of 63.
    const resolveFor = (release: string) => {
      let copied = false;
      return createDefaultReleaseEffects(rootDir, async () => undefined, {
        runDocker: async (args) => {
          const joined = args.join(" ");
          if (joined.startsWith("pull")) return "";
          if (joined.startsWith("create")) return "c".repeat(64);
          if (joined.startsWith("cp")) {
            const destination = args[2] as string;
            writeFileSync(destination, stored(release));
            copied = true;
            // Yield so the sibling resolution interleaves here.
            await new Promise((resolve) => setTimeout(resolve, 5));
            return "";
          }
          if (joined.startsWith("rm")) return "";
          if (!copied) throw new Error("unexpected docker call");
          return "";
        },
      });
    };

    const results = await Promise.allSettled([
      resolveFor("release-a").resolve({ signal: new AbortController().signal, emitLog: vi.fn() }),
      resolveFor("release-b").resolve({ signal: new AbortController().signal, emitLog: vi.fn() }),
    ]);

    const stayed = readdirSync(directory).filter((name) => name.endsWith(".json")).length;
    const fulfilled = results.filter((result) => result.status === "fulfilled").length;
    // 63 stored + latest.json; exactly one new release may land.
    expect(stayed).toBeLessThanOrEqual(64 + 1);
    expect(fulfilled).toBeGreaterThanOrEqual(1);
    for (const result of results) {
      if (result.status === "rejected") {
        expect(String(result.reason)).toMatch(/Release store limit exceeded|Release store is busy/);
      }
    }
  });

  it.each(["prepared", "overlay_written", "services_applied", "state_published"] as const)(
    "recovers a crash at the durable %s release boundary",
    async (crashPhase) => {
      const rootDir = temporaryRoot();
      const directory = join(rootDir, "infra", "docker", ".ops-agent-releases");
      mkdirSync(directory, { mode: 0o700 });
      const releaseId = "release-recovery";
      const manifest = {
        schemaVersion: 1 as const,
        release: releaseId,
        images: Object.fromEntries(
          [
            "api",
            "web",
            "data-manager",
            "ops-agent",
            "transitous-runner",
            "transitous-tools",
            "docs",
          ].map((name) => [name, `ghcr.io/openmapx/${name}@sha256:${"3".repeat(64)}`]),
        ),
      };
      writeFileSync(join(directory, `${releaseId}.json`), JSON.stringify(manifest), {
        mode: 0o600,
      });
      const appliedCalls: string[][] = [];
      const first = createDefaultReleaseEffects(
        rootDir,
        async (args) => {
          appliedCalls.push([...args]);
        },
        {
          afterReleasePhase: (phase) => {
            if (phase === crashPhase) throw new Error("injected crash");
          },
          verifyAppliedRelease: async () => true,
        },
      );
      await expect(
        first.apply(
          releaseId,
          ["app-api"],
          { signal: new AbortController().signal, emitLog: vi.fn() },
          "job-recovery",
        ),
      ).rejects.toThrow("injected crash");
      expect(existsSync(join(directory, "transaction.json"))).toBe(true);

      const recoveredCalls: string[][] = [];
      const recovered = createDefaultReleaseEffects(
        rootDir,
        async (args) => {
          appliedCalls.push([...args]);
          recoveredCalls.push([...args]);
        },
        { verifyAppliedRelease: async () => true },
      );
      await recovered.initialize?.();
      expect(appliedCalls).toEqual([["services", "update", "app-api"]]);
      expect(recoveredCalls).toHaveLength(
        crashPhase === "prepared" || crashPhase === "overlay_written" ? 1 : 0,
      );
      expect(JSON.parse(readFileSync(join(directory, "current.json"), "utf8"))).toEqual({
        releaseId,
        updateJobId: "job-recovery",
        digest: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(existsSync(join(directory, "transaction.json"))).toBe(false);
    },
  );

  it.each(["prepared", "overlay_written", "services_applied", "state_published"] as const)(
    "fails closed at the %s boundary when the runtime no longer matches the release",
    async (crashPhase) => {
      const rootDir = temporaryRoot();
      const directory = join(rootDir, "infra", "docker", ".ops-agent-releases");
      mkdirSync(directory, { mode: 0o700 });
      const releaseId = "release-recovery";
      writeFileSync(
        join(directory, `${releaseId}.json`),
        JSON.stringify({
          schemaVersion: 1,
          release: releaseId,
          images: Object.fromEntries(
            [
              "api",
              "web",
              "data-manager",
              "ops-agent",
              "transitous-runner",
              "transitous-tools",
              "docs",
            ].map((name) => [name, `ghcr.io/openmapx/${name}@sha256:${"3".repeat(64)}`]),
          ),
        }),
        { mode: 0o600 },
      );
      const first = createDefaultReleaseEffects(rootDir, async () => undefined, {
        afterReleasePhase: (phase) => {
          if (phase === crashPhase) throw new Error("injected crash");
        },
        verifyAppliedRelease: async () => true,
      });
      await expect(
        first.apply(
          releaseId,
          ["app-api"],
          { signal: new AbortController().signal, emitLog: vi.fn() },
          "job-recovery",
        ),
      ).rejects.toThrow("injected crash");

      // A reboot, container disappearance, digest drift, or unreachable Docker
      // between the crash and this recovery.
      const recovered = createDefaultReleaseEffects(rootDir, async () => undefined, {
        verifyAppliedRelease: async () => false,
      });
      await expect(recovered.initialize?.()).rejects.toThrow(
        "Release recovery verification failed",
      );
      // The transaction is retained so a later attempt can still reconcile.
      expect(existsSync(join(directory, "transaction.json"))).toBe(true);
    },
  );

  it("rejects a release manifest replaced after the transaction was admitted", async () => {
    const rootDir = temporaryRoot();
    const directory = join(rootDir, "infra", "docker", ".ops-agent-releases");
    mkdirSync(directory, { mode: 0o700 });
    const releaseId = "release-recovery";
    const manifestFor = (tag: string) =>
      JSON.stringify({
        schemaVersion: 1,
        release: releaseId,
        images: Object.fromEntries(
          [
            "api",
            "web",
            "data-manager",
            "ops-agent",
            "transitous-runner",
            "transitous-tools",
            "docs",
          ].map((name) => [name, `ghcr.io/openmapx/${name}@sha256:${tag.repeat(64)}`]),
        ),
      });
    writeFileSync(join(directory, `${releaseId}.json`), manifestFor("3"), { mode: 0o600 });

    const first = createDefaultReleaseEffects(rootDir, async () => undefined, {
      afterReleasePhase: (phase) => {
        if (phase === "overlay_written") throw new Error("injected crash");
      },
      verifyAppliedRelease: async () => true,
    });
    await expect(
      first.apply(releaseId, ["app-api"], {
        signal: new AbortController().signal,
        emitLog: vi.fn(),
      }),
    ).rejects.toThrow("injected crash");

    // Swap the manifest under the same release ID before recovery reopens it.
    writeFileSync(join(directory, `${releaseId}.json`), manifestFor("7"), { mode: 0o600 });

    const recovered = createDefaultReleaseEffects(rootDir, async () => undefined, {
      verifyAppliedRelease: async () => true,
    });
    // Either binding may fire first; both refuse to act on the swapped bytes.
    await expect(recovered.initialize?.()).rejects.toThrow(
      /Release (authority|transaction) rejected/,
    );
  });

  it.each(["rollback_overlay", "rollback_services"] as const)(
    "recovers a crash at the durable %s release boundary",
    async (crashPhase) => {
      const rootDir = temporaryRoot();
      const directory = join(rootDir, "infra", "docker", ".ops-agent-releases");
      mkdirSync(directory, { mode: 0o700 });
      const releaseId = `release-${crashPhase}`;
      writeFileSync(
        join(directory, `${releaseId}.json`),
        JSON.stringify({
          schemaVersion: 1,
          release: releaseId,
          images: Object.fromEntries(
            [
              "api",
              "web",
              "data-manager",
              "ops-agent",
              "transitous-runner",
              "transitous-tools",
              "docs",
            ].map((name) => [name, `ghcr.io/openmapx/${name}@sha256:${"5".repeat(64)}`]),
          ),
        }),
        { mode: 0o600 },
      );
      const overlay = join(rootDir, "infra", "docker", "docker-compose.release.yml");
      writeFileSync(overlay, "previous-overlay\n", { mode: 0o600 });
      let updateAttempts = 0;
      const first = createDefaultReleaseEffects(
        rootDir,
        async () => {
          updateAttempts += 1;
          if (updateAttempts === 1) throw new Error("injected update failure");
        },
        {
          afterReleasePhase: (phase) => {
            if (phase === crashPhase) throw new Error("injected crash");
          },
        },
      );
      await expect(
        first.apply(
          releaseId,
          ["app-api"],
          { signal: new AbortController().signal, emitLog: vi.fn() },
          `job-${crashPhase}`,
        ),
      ).rejects.toThrow("injected crash");
      expect(existsSync(join(directory, "transaction.json"))).toBe(true);

      const recovered = createDefaultReleaseEffects(rootDir, async () => {
        updateAttempts += 1;
      });
      await recovered.initialize?.();
      expect(updateAttempts).toBe(2);
      expect(readFileSync(overlay, "utf8")).toBe("previous-overlay\n");
      expect(existsSync(join(directory, "current.json"))).toBe(false);
      expect(existsSync(join(directory, "transaction.json"))).toBe(false);
    },
  );

  it("inspects old, current, missing, and partial core images from fixed Docker targets", async () => {
    const rootDir = temporaryRoot();
    const releaseDirectory = join(rootDir, "infra", "docker", ".ops-agent-releases");
    mkdirSync(releaseDirectory, { mode: 0o700 });
    mkdirSync(join(rootDir, "infra", "docker"), { recursive: true });
    writeFileSync(
      join(rootDir, "infra", "docker", "docker-compose.generated.yml"),
      "services:{}\n",
    );
    const releaseId = "release-123";
    const manifest = {
      schemaVersion: 1,
      release: releaseId,
      images: Object.fromEntries(
        [
          "api",
          "web",
          "data-manager",
          "ops-agent",
          "transitous-runner",
          "transitous-tools",
          "docs",
        ].map((name, index) => [
          name,
          `ghcr.io/openmapx/${name}@sha256:${String(index + 1).repeat(64)}`,
        ]),
      ),
    };
    writeFileSync(join(releaseDirectory, `${releaseId}.json`), JSON.stringify(manifest), {
      mode: 0o600,
    });
    const calls: string[][] = [];
    const effects = createDefaultReleaseEffects(rootDir, async () => undefined, {
      runDocker: async (args) => {
        calls.push([...args]);
        const joined = args.join(" ");
        if (joined.startsWith("info ")) return "28.0.0\n";
        if (joined.includes("config")) return "";
        if (joined.includes("ps -q app-api")) return "a".repeat(64);
        if (joined.includes("ps -q app-web")) return "b".repeat(64);
        if (joined.includes("ps -q data-manager")) return "";
        if (joined.includes(`container inspect`) && joined.endsWith("a".repeat(64))) {
          return `sha256:${"9".repeat(64)}`;
        }
        if (joined.includes(`container inspect`) && joined.endsWith("b".repeat(64))) {
          return `sha256:${"2".repeat(64)}`;
        }
        if (joined.includes("image inspect") && joined.includes("/api@")) {
          return `sha256:${"1".repeat(64)}`;
        }
        if (joined.includes("image inspect") && joined.includes("/web@")) {
          return `sha256:${"2".repeat(64)}`;
        }
        throw new Error("missing image");
      },
    });

    await expect(
      effects.inspectSystem({ signal: new AbortController().signal, emitLog: vi.fn() }),
    ).resolves.toMatchObject({
      dockerReachable: true,
      services: [
        { serviceId: "app-api", state: "update_available", releaseMember: true },
        { serviceId: "app-web", state: "current", releaseMember: true },
        { serviceId: "data-manager", state: "not_running", releaseMember: true },
      ],
    });
    expect(calls.flat()).not.toContain("attacker-container");
  });

  describe("system inspection fails closed on unusable observations", () => {
    function systemFixture(
      compose: "file" | "directory" | "missing",
      runDocker: (args: readonly string[]) => Promise<string>,
    ) {
      const rootDir = temporaryRoot();
      const releaseDirectory = join(rootDir, "infra", "docker", ".ops-agent-releases");
      mkdirSync(releaseDirectory, { mode: 0o700 });
      mkdirSync(join(rootDir, "infra", "docker"), { recursive: true });
      const composePath = join(rootDir, "infra", "docker", "docker-compose.generated.yml");
      if (compose === "file") writeFileSync(composePath, "services:{}\n");
      if (compose === "directory") mkdirSync(composePath);
      const releaseId = "release-123";
      writeFileSync(
        join(releaseDirectory, `${releaseId}.json`),
        JSON.stringify({
          schemaVersion: 1,
          release: releaseId,
          images: Object.fromEntries(
            [
              "api",
              "web",
              "data-manager",
              "ops-agent",
              "transitous-runner",
              "transitous-tools",
              "docs",
            ].map((name, index) => [
              name,
              `ghcr.io/openmapx/${name}@sha256:${String(index + 1).repeat(64)}`,
            ]),
          ),
        }),
        { mode: 0o600 },
      );
      return createDefaultReleaseEffects(rootDir, async () => undefined, { runDocker });
    }

    const context = () => ({ signal: new AbortController().signal, emitLog: vi.fn() });

    it("reports unknown rather than stopped when a per-service observation throws", async () => {
      const effects = systemFixture("file", async (args) => {
        const joined = args.join(" ");
        if (joined.startsWith("info ")) return "28.0.0\n";
        if (joined.includes("config")) return "";
        if (joined.includes("ps -q app-api")) throw new Error("compose ps failed");
        if (joined.includes("ps -q")) return "";
        throw new Error("missing image");
      });

      const result = await effects.inspectSystem(context());
      const api = result.services.find((service) => service.serviceId === "app-api");
      expect(api).toMatchObject({ state: "unknown", containerState: "unknown" });
      // A service that was actually observed as absent stays distinguishable.
      expect(result.services.find((service) => service.serviceId === "app-web")).toMatchObject({
        state: "not_running",
        containerState: "stopped",
      });
    });

    it("rejects a non-file Compose path instead of reporting it ready", async () => {
      const effects = systemFixture("directory", async (args) => {
        const joined = args.join(" ");
        if (joined.startsWith("info ")) return "28.0.0\n";
        return "";
      });

      const result = await effects.inspectSystem(context());
      expect(result).toMatchObject({ composeReady: false, maintenanceReady: false });
      for (const service of result.services) expect(service.state).toBe("unknown");
    });

    it("rejects a Compose document the Compose boundary cannot parse", async () => {
      const effects = systemFixture("file", async (args) => {
        const joined = args.join(" ");
        if (joined.startsWith("info ")) return "28.0.0\n";
        if (joined.includes("config")) throw new Error("invalid compose project");
        return "";
      });

      const result = await effects.inspectSystem(context());
      expect(result).toMatchObject({ composeReady: false, maintenanceReady: false });
      for (const service of result.services) expect(service.state).toBe("unknown");
    });
  });

  it("binds stored release IDs and restores the exact overlay when application fails", async () => {
    const rootDir = temporaryRoot();
    const releaseDirectory = join(rootDir, "infra", "docker", ".ops-agent-releases");
    mkdirSync(releaseDirectory, { mode: 0o700 });
    const releaseId = "release-123";
    writeFileSync(
      join(releaseDirectory, `${releaseId}.json`),
      JSON.stringify({
        schemaVersion: 1,
        release: releaseId,
        images: Object.fromEntries(
          [
            "api",
            "web",
            "data-manager",
            "ops-agent",
            "transitous-runner",
            "transitous-tools",
            "docs",
          ].map((name, index) => [
            name,
            `ghcr.io/openmapx/${name}@sha256:${String(index + 1).repeat(64)}`,
          ]),
        ),
      }),
      { mode: 0o600 },
    );
    const overlay = join(rootDir, "infra", "docker", "docker-compose.release.yml");
    writeFileSync(overlay, "previous-overlay\n", { mode: 0o600 });
    let attempts = 0;
    const effects = createDefaultReleaseEffects(rootDir, async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("injected update failure");
    });
    expect(inspectReleaseAuthority(rootDir, releaseId)).toBe(true);
    await expect(
      effects.apply(
        releaseId,
        ["app-api"],
        { signal: new AbortController().signal, emitLog: vi.fn() },
        "job-1",
      ),
    ).rejects.toThrow("injected update failure");
    expect(readFileSync(overlay, "utf8")).toBe("previous-overlay\n");
    expect(existsSync(join(releaseDirectory, "current.json"))).toBe(false);
    expect(attempts).toBe(2);
  });

  it("owns release resolution, pull, inspection, application, and API replacement", async () => {
    const calls: string[] = [];
    const cli: string[][] = [];
    const runtime = createUnavailableRuntime();
    createAdministrativeRuntime(runtime, {
      rootDir: temporaryRoot(),
      runFixedCli: async (args) => {
        cli.push([...args]);
      },
      releaseEffects: {
        resolve: async () => {
          calls.push("resolve");
          return "release-123";
        },
        pull: async (releaseId) => {
          calls.push(`pull:${releaseId}`);
        },
        inspect: async () => ({
          currentReleaseId: "release-old",
          availableReleaseId: "release-123",
        }),
        inspectSystem: async () => ({
          dockerReachable: true,
          composeReady: true,
          maintenanceReady: true,
          release: { currentReleaseId: "release-old", availableReleaseId: "release-123" },
          services: [
            {
              serviceId: "app-api",
              containerState: "running",
              pinnedImage: `ghcr.io/openmapx/api@sha256:${"a".repeat(64)}`,
              runningImageId: `sha256:${"b".repeat(64)}`,
              localImageId: `sha256:${"a".repeat(64)}`,
              releaseMember: true,
              state: "update_available",
            },
          ],
        }),
        apply: async (releaseId, serviceIds) => {
          calls.push(`apply:${releaseId}:${serviceIds.join(",")}`);
        },
      },
    });

    await expect(
      dispatchOpsOperation(runtime, { kind: "release.resolve" }, context("release.resolve")),
    ).resolves.toEqual({ releaseId: "release-123" });
    await dispatchOpsOperation(
      runtime,
      { kind: "release.pull", releaseId: "release-123" },
      context("release.pull"),
    );
    await expect(
      dispatchOpsOperation(runtime, { kind: "release.inspect" }, context("release.inspect")),
    ).resolves.toEqual({
      currentReleaseId: "release-old",
      availableReleaseId: "release-123",
    });
    await expect(
      dispatchOpsOperation(runtime, { kind: "system.inspect" }, context("system.inspect")),
    ).resolves.toMatchObject({
      dockerReachable: true,
      services: [{ serviceId: "app-api", state: "update_available" }],
    });
    await dispatchOpsOperation(
      runtime,
      { kind: "release.apply", releaseId: "release-123" },
      context("release.apply"),
    );
    await dispatchOpsOperation(
      runtime,
      { kind: "appApi.replace", releaseId: "release-123", updateJobId: "job-1" },
      context("appApi.replace"),
    );
    expect(calls).toEqual([
      "resolve",
      "pull:release-123",
      "apply:release-123:data-manager,app-web,app-api",
      "apply:release-123:app-api",
    ]);
    expect(cli).toEqual([]);
  });

  it("runs the optional backup before a single agent-owned system update", async () => {
    const order: string[] = [];
    const runtime = createUnavailableRuntime();
    createAdministrativeRuntime(runtime, {
      rootDir: temporaryRoot(),
      runFixedCli: async (args) => {
        order.push(`cli:${args.join(" ")}`);
      },
      releaseEffects: {
        resolve: async () => "release-123",
        pull: async (releaseId) => {
          order.push(`pull:${releaseId}`);
        },
        inspect: async () => ({}),
        inspectSystem: async () => ({
          dockerReachable: true,
          composeReady: true,
          maintenanceReady: true,
          release: {},
          services: [],
        }),
        apply: async (releaseId, serviceIds) => {
          order.push(`apply:${releaseId}:${serviceIds.join(",")}`);
        },
      },
    });
    await expect(
      dispatchOpsOperation(
        runtime,
        {
          kind: "system.update",
          releaseId: "release-123",
          createBackup: true,
          backupId: "pre-update-job-1",
        },
        context("system.update"),
      ),
    ).resolves.toEqual({ releaseId: "release-123" });
    expect(order).toEqual([
      "cli:backup create --name pre-update-job-1",
      "pull:release-123",
      "apply:release-123:data-manager,app-web,app-api",
    ]);
  });
});
