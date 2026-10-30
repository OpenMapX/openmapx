import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpsOperation, ServiceBatchResult } from "@openmapx/core/ops";
import { services as coreServices } from "@openmapx/core/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testExecution } from "./__fixtures__/execution";
import {
  createAdministrativeRuntime,
  createDefaultFixedCli,
  createDefaultReleaseEffects,
  inspectBackupAuthority,
  inspectDataTypeAuthority,
  inspectRegionAuthority,
  inspectReleaseAuthority,
  loadConfiguredResourceAuthority,
  pruneBackupRetention,
} from "./administrative-runtime";
import { createUnavailableRuntime, dispatchOpsOperation, OpsExecutionFailure } from "./runtime";

const temporaryRoots: string[] = [];
const privacyReleaseValidation = {
  version: 1 as const,
  sourceBuildFingerprint: "a".repeat(64),
  validatedAt: "2026-09-05T12:00:00.000Z",
  checks: {
    translationsConsistent: true as const,
    openApiConsistent: true as const,
    policyConsistent: true as const,
  },
};

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "openmapx-admin-runtime-"));
  temporaryRoots.push(root);
  mkdirSync(join(root, "infra", "docker", "backups"), { recursive: true });
  return root;
}

function context(kind: string) {
  return {
    execution: testExecution(),
    signal: new AbortController().signal,
    emitLog: vi.fn(),
    checkpointServiceBatch: vi.fn(async (_result: ServiceBatchResult) => {}),
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

describe("default fixed CLI live output", () => {
  it.each(["visibility", "volume"])("streams live bounded output: %s", async (check) => {
    const root = temporaryRoot();
    const release = join(root, "release");
    const ready = join(root, "ready");
    writeFileSync(
      join(root, "cli.mjs"),
      `
      import { existsSync, writeFileSync } from 'node:fs';
      import { setTimeout } from 'node:timers/promises';
      console.log('phase-one');
      writeFileSync(${JSON.stringify(ready)}, 'ready');
      while (!existsSync(${JSON.stringify(release)})) await setTimeout(5);
      for (let i = 0; i < 2048; i++) {
        if (!process.stdout.write('x'.repeat(1024) + '\\n'))
          await new Promise(resolve => process.stdout.once('drain', resolve));
      }
      console.log('last-diagnostic');
    `,
    );
    const seen: string[] = [];
    const completion = createDefaultFixedCli(root, join(root, "agent.mjs"))([], {
      execution: testExecution(),
      signal: new AbortController().signal,
      emitLog: (_stream, message) => seen.push(message),
    });
    // Attach immediately: the volume regression may reject before the assertion.
    void completion.catch(() => undefined);
    try {
      await vi.waitFor(() => expect(existsSync(ready)).toBe(true), { timeout: 2000 });
      if (check === "visibility") {
        await vi.waitFor(() => expect(seen).toContain("phase-one"), { timeout: 2000 });
      }
      writeFileSync(release, "go");
      await expect(completion).resolves.toBeUndefined();
      expect(seen).toContain("last-diagnostic");
    } finally {
      writeFileSync(release, "go");
      await completion.catch(() => undefined);
    }
  });
});

describe("administrative backup runtime", () => {
  it("runs scheduled retention through the fixed CLI under validated bounds", async () => {
    const calls: string[][] = [];
    await pruneBackupRetention(temporaryRoot(), 30, async (args) => {
      calls.push([...args]);
    });
    expect(calls).toEqual([["backup", "prune", "--retention-days", "30"]]);
    await expect(pruneBackupRetention(temporaryRoot(), 0, vi.fn())).rejects.toThrow(/retention/i);
  });

  it("maps typed backup effects to exact fixed CLI argv without a path or general runner", async () => {
    const rootDir = temporaryRoot();
    // Restore revalidates the exact manifest bytes before dispatch, so the
    // backup must really exist and declare the requested services.
    const backup = join(rootDir, "infra", "docker", "backups", "nightly-20260823");
    mkdirSync(backup, { mode: 0o700, recursive: true });
    writeFileSync(
      join(backup, "manifest.json"),
      JSON.stringify({
        formatVersion: 2,
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
          formatVersion: 2,
          name: "nightly-20260823",
          createdAt: "2026-08-23T18:00:00.000Z",
          openmapxVersion: "1.0.0",
          services: [
            {
              id: "postgis",
              version: "1.0.0",
              volumes: [
                {
                  name: "db",
                  file: "postgis__db.sql.gz",
                  mode: "pg_dump",
                  sizeBytes: 42,
                  sha256: "a".repeat(64),
                  postgresUser: "postgres",
                  postgresDb: "openmapx",
                },
              ],
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
          formatVersion: 2,
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
          formatVersion: 2,
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

  it.runIf(process.platform === "linux")(
    "flags omitted, legacy, and unknown backup formats as invalid inventory",
    async () => {
      const rootDir = temporaryRoot();
      for (const [backupId, formatVersion] of [
        ["omitted", undefined],
        ["legacy", 1],
        ["unknown", 3],
      ] as const) {
        const backup = join(rootDir, "infra", "docker", "backups", backupId);
        mkdirSync(backup, { mode: 0o700 });
        writeFileSync(
          join(backup, "manifest.json"),
          JSON.stringify({
            ...(formatVersion === undefined ? {} : { formatVersion }),
            name: backupId,
            createdAt: "2026-08-23T18:00:00.000Z",
            openmapxVersion: "1.0.0",
            services: [],
          }),
          { mode: 0o600 },
        );
      }
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

      expect(result.warningCount).toBe(3);
      expect(result.backups).toEqual(
        expect.arrayContaining(
          ["omitted", "legacy", "unknown"].map((backupId) =>
            expect.objectContaining({ backupId, corrupt: true, corruptReason: "invalid_manifest" }),
          ),
        ),
      );
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

  it("requires owned data workflows and maps only the remaining legacy CLI leaves", async () => {
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
      { kind: "data.overturePull", regionId: "europe/germany" },
      { kind: "data.overtureIngest", regionId: "europe/germany" },
      { kind: "data.overtureExtract", regionId: "europe/germany" },
      { kind: "data.overtureConflate", regionId: "europe/germany", restart: true },
      { kind: "data.searchIndexBuild", regionId: "europe/germany" },
    ];
    const owned = new Set([
      "data.downloadOsm",
      "data.downloadFonts",
      "data.update",
      "data.convertOverpass",
      "data.overtureSync",
      "data.overturePull",
      "data.overtureIngest",
      "data.overtureExtract",
      "data.overtureConflate",
      "data.searchIndexBuild",
    ]);
    for (const operation of operations) {
      if (owned.has(operation.kind))
        await expect(
          dispatchOpsOperation(runtime, operation, context(operation.kind)),
        ).rejects.toThrow("Host update required");
      else if (operation.kind === "data.generateApiKeys")
        await expect(
          dispatchOpsOperation(runtime, operation, context(operation.kind)),
        ).rejects.toThrow("Typed adapter is not wired");
      else await dispatchOpsOperation(runtime, operation, context(operation.kind));
    }
    expect(calls).toEqual([
      ["data", "link"],
      ["data", "clean", "osm"],
    ]);
    expect(calls.flat()).not.toContain("transitous-fixed-v1");
  });

  it("returns bounded data inventory from the agent-owned root without a host path", async () => {
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
      items: [
        {
          filename: "germany-latest.osm.pbf",
          sizeBytes: 3,
          region: null,
          fingerprintState: "missing",
        },
      ],
      total: 1,
      unavailable: false,
    });
    expect(result.builds).toContainEqual(
      expect.objectContaining({ target: "valhalla", built: false, readiness: "unknown" }),
    );
    expect(result.motisTransitous).toMatchObject({
      configFound: false,
      capabilityState: "missing",
    });
    expect(JSON.stringify(result)).not.toContain(rootDir);
  });
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

  it("passes MOTIS import only to the actual MOTIS build and refuses unsupported selections before effects", async () => {
    const calls: string[][] = [],
      runtime = createUnavailableRuntime();
    createAdministrativeRuntime(runtime, {
      rootDir: temporaryRoot(),
      loadBuildAuthority: async () => [
        ...buildAuthority,
        { serviceId: "motis", enabled: true, isBuiltIn: true, buildCommand: "motis" },
      ],
      runFixedCli: async (args) => {
        calls.push([...args]);
      },
    });
    await dispatchOpsOperation(
      runtime,
      { kind: "service.build", serviceId: "motis", motisImport: true },
      context("service.build"),
    );
    expect(calls).toEqual([["services", "build", "motis", "--import"]]);
    await expect(
      dispatchOpsOperation(
        runtime,
        { kind: "service.build", serviceId: "valhalla", motisImport: true },
        context("service.build"),
      ),
    ).rejects.toThrow(/MOTIS/);
    expect(calls).toHaveLength(1);
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
    ).rejects.toMatchObject({
      name: "OpsExecutionFailure",
      failureResult: {
        serviceBatch: {
          outcome: "partial",
          completedServiceIds: ["nominatim"],
          failedServiceIds: ["valhalla"],
          skippedServiceIds: [],
        },
      },
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
    ).rejects.toMatchObject({
      name: "OpsExecutionFailure",
      failureResult: {
        serviceBatch: {
          outcome: "failed",
          completedServiceIds: [],
          failedServiceIds: ["nominatim"],
          skippedServiceIds: ["valhalla"],
        },
      },
    });
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
    ).rejects.toMatchObject({
      failureResult: {
        serviceBatch: {
          outcome: "failed",
          completedServiceIds: [],
          failedServiceIds: [],
          skippedServiceIds: [],
        },
      },
    });
  });
  it.each(["continue", "fail-fast", "all-failed", "unknown", "cancel"] as const)(
    "retains ordered batch evidence and stops uncertain work: %s",
    async (mode) => {
      const calls: string[] = [];
      const controller = new AbortController();
      const runtime = createUnavailableRuntime();
      createAdministrativeRuntime(runtime, {
        rootDir: temporaryRoot(),
        loadBuildAuthority: async () =>
          ["gamma", "beta", "alpha"].map((serviceId) => ({
            serviceId,
            enabled: true,
            isBuiltIn: true,
            buildCommand: serviceId,
          })),
        runFixedCli: async (args) => {
          const id = args[2]!;
          calls.push(id);
          if (mode === "all-failed") throw Error("build failed");
          if (id === "beta") {
            if (mode === "unknown") throw new OpsExecutionFailure("recovery_required", {});
            if (mode === "cancel") {
              controller.abort();
              throw new DOMException("Aborted", "AbortError");
            }
            throw Error("build failed");
          }
        },
      });
      const ctx = { ...context("services.buildAll"), signal: controller.signal };
      const failure = await dispatchOpsOperation(
        runtime,
        { kind: "services.buildAll", ...(mode === "fail-fast" ? { failFast: true } : {}) },
        ctx,
      ).catch((error) => error);
      expect(failure).toBeInstanceOf(OpsExecutionFailure);
      expect(failure.failureResult.serviceBatch).toEqual({
        outcome: mode === "all-failed" ? "failed" : "partial",
        completedServiceIds:
          mode === "all-failed" ? [] : mode === "continue" ? ["alpha", "gamma"] : ["alpha"],
        failedServiceIds:
          mode === "all-failed"
            ? ["alpha", "beta", "gamma"]
            : mode === "unknown" || mode === "cancel"
              ? []
              : ["beta"],
        skippedServiceIds:
          mode === "unknown" || mode === "cancel"
            ? ["gamma"]
            : mode === "fail-fast"
              ? ["gamma"]
              : [],
      });
      expect(calls).toEqual(
        mode === "continue" || mode === "all-failed"
          ? ["alpha", "beta", "gamma"]
          : ["alpha", "beta"],
      );
      expect(ctx.checkpointServiceBatch).toHaveBeenCalledTimes(calls.length);
      expect(ctx.checkpointServiceBatch.mock.calls.at(-1)?.[0]).toEqual(
        failure.failureResult.serviceBatch,
      );
    },
  );

  it("does not start another build when its completed prefix cannot be journaled", async () => {
    const runtime = createUnavailableRuntime();
    const calls: string[] = [];
    createAdministrativeRuntime(runtime, {
      rootDir: temporaryRoot(),
      loadBuildAuthority: async () =>
        ["alpha", "beta"].map((serviceId) => ({
          serviceId,
          enabled: true,
          isBuiltIn: true,
          buildCommand: serviceId,
        })),
      runFixedCli: async (args) => {
        calls.push(args[2]!);
      },
    });
    const ctx = context("services.buildAll");
    ctx.checkpointServiceBatch.mockRejectedValueOnce(Error("journal unavailable"));
    await expect(
      dispatchOpsOperation(runtime, { kind: "services.buildAll" }, ctx),
    ).rejects.toMatchObject({
      errorClass: "recovery_required",
      failureResult: {
        serviceBatch: {
          completedServiceIds: ["alpha"],
          failedServiceIds: [],
          skippedServiceIds: ["beta"],
        },
      },
    });
    expect(calls).toEqual(["alpha"]);
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

async function appliedInspectionFixture(rootDir: string) {
  const infraDir = join(rootDir, "infra", "docker");
  await coreServices.commitConfigurationGeneration({
    infraDir,
    services: [],
    input: {
      domain: "localhost",
      selectedRoots: [],
      serviceConfigs: [],
      integrationConfigs: [],
      serviceSecrets: [],
    },
  });
}

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
          "privacy-backup",
          "transitous-runner",
          "transitous-tools",
        ].map((name) => [name, `ghcr.io/openmapx/${name}@sha256:${digit.repeat(64)}`]),
      ),
      privacyReleaseValidation,
    });
    let manifestText = JSON.stringify(makeManifest("4"));
    const dockerCalls: string[][] = [];
    const docker = async (args: readonly string[]) => {
      dockerCalls.push([...args]);
      if (args[0] === "pull") return `Digest: sha256:${"1".repeat(64)}`;
      if (args[0] === "image") return `sha256:${"2".repeat(64)}`;
      if (args[0] === "create") {
        expect(args[1]).toBe(`sha256:${"2".repeat(64)}`);
        return "a".repeat(64);
      }
      if (args[0] === "cp") {
        writeFileSync(args.at(-1) as string, manifestText, { mode: 0o600 });
      }
      return "";
    };
    const context = {
      execution: testExecution(),
      signal: new AbortController().signal,
      emitLog: vi.fn(),
    };
    const first = createDefaultReleaseEffects(rootDir, async () => undefined, {
      runDocker: docker,
    });
    await expect(first.resolve(context)).resolves.toBe(release);
    const checkedDigest = createHash("sha256").update(manifestText).digest("hex");
    await expect(first.validateCandidate?.(release, checkedDigest)).resolves.toBeUndefined();
    await expect(first.validateCandidate?.(release, "0".repeat(64))).rejects.toThrow(
      "Checked release",
    );
    process.env.OPENMAPX_RELEASE = "preview";
    try {
      await expect(first.validateCandidate?.(release, checkedDigest)).rejects.toThrow(
        "Checked release",
      );
    } finally {
      delete process.env.OPENMAPX_RELEASE;
    }
    await expect(first.pull(release, context)).resolves.toBeUndefined();
    expect(dockerCalls).toContainEqual([
      "pull",
      `ghcr.io/openmapx/privacy-backup@sha256:${"4".repeat(64)}`,
    ]);
    await expect(first.resolve(context)).resolves.toBe(release);
    manifestText = JSON.stringify(makeManifest("5"));
    await expect(first.resolve(context)).rejects.toThrow("Release authority rejected");
    expect(
      readFileSync(
        join(rootDir, "infra", "docker", ".ops-agent-releases", `${release}.json`),
        "utf8",
      ),
    ).toContain("4".repeat(64));
    expect(
      JSON.parse(
        readFileSync(
          join(rootDir, "infra", "docker", ".ops-agent-releases", `${release}.json`),
          "utf8",
        ),
      ),
    ).toMatchObject({
      images: { "privacy-backup": `ghcr.io/openmapx/privacy-backup@sha256:${"4".repeat(64)}` },
      privacyReleaseValidation,
    });

    manifestText = "x".repeat(32 * 1024 + 1);
    await expect(first.resolve(context)).rejects.toThrow();
  });

  it("stores distinct canonical identities for two producer attempts of the same run", async () => {
    const rootDir = temporaryRoot();
    let attempt = 1;
    const sourceRevision = "a".repeat(40);
    const manifest = () => ({
      schemaVersion: 1,
      release: `${sourceRevision}-123-${attempt}`,
      images: Object.fromEntries(
        [
          "api",
          "web",
          "data-manager",
          "ops-agent",
          "privacy-backup",
          "transitous-runner",
          "transitous-tools",
        ].map((name) => [name, `ghcr.io/openmapx/${name}@sha256:${String(attempt).repeat(64)}`]),
      ),
      privacyReleaseValidation,
      producer: {
        repository: "OpenMapX/openmapx",
        workflowPath: ".github/workflows/ci.yml",
        sourceRevision,
        runId: 123,
        runAttempt: attempt,
        event: "push",
      },
    });
    const runtime = createDefaultReleaseEffects(rootDir, async () => undefined, {
      runDocker: async (args) => {
        if (args[0] === "pull") return `Digest: sha256:${String(attempt).repeat(64)}`;
        if (args[0] === "image") return `sha256:${"e".repeat(64)}`;
        if (args[0] === "create") return "a".repeat(64);
        if (args[0] === "cp") writeFileSync(args.at(-1) as string, JSON.stringify(manifest()));
        return "";
      },
    });
    const context = {
      execution: testExecution(),
      signal: new AbortController().signal,
      emitLog: vi.fn(),
    };
    expect(await runtime.resolve(context)).toBe(`${sourceRevision}-123-1`);
    attempt = 2;
    expect(await runtime.resolve(context)).toBe(`${sourceRevision}-123-2`);
    for (const n of [1, 2])
      expect(
        JSON.parse(
          readFileSync(
            join(
              rootDir,
              "infra",
              "docker",
              ".ops-agent-releases",
              `${sourceRevision}-123-${n}.json`,
            ),
            "utf8",
          ),
        ).producer.runAttempt,
      ).toBe(n);
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
          "privacy-backup",
          "transitous-runner",
          "transitous-tools",
        ].map((name) => [name, `ghcr.io/openmapx/${name}@sha256:${digit.repeat(64)}`]),
      ),
      privacyReleaseValidation,
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
    await expect(effects.inspect()).resolves.toEqual({
      configuredSelector: "main",
      availableReleaseId: "a-new",
    });
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
            "privacy-backup",
            "transitous-runner",
            "transitous-tools",
          ].map((name) => [name, `ghcr.io/openmapx/${name}@sha256:${"3".repeat(64)}`]),
        ),
        privacyReleaseValidation,
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
          if (joined.startsWith("pull")) return `Digest: sha256:${"1".repeat(64)}`;
          if (joined.startsWith("image inspect")) return `sha256:${"2".repeat(64)}`;
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
      resolveFor("release-a").resolve({
        execution: testExecution(),
        signal: new AbortController().signal,
        emitLog: vi.fn(),
      }),
      resolveFor("release-b").resolve({
        execution: testExecution(),
        signal: new AbortController().signal,
        emitLog: vi.fn(),
      }),
    ]);

    const stayed = readdirSync(directory).filter((name) => name.endsWith(".json")).length;
    const fulfilled = results.filter((result) => result.status === "fulfilled").length;
    // 63 stored + latest.json; exactly one new release may land.
    expect(stayed).toBeLessThanOrEqual(64 + 2);
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
            "privacy-backup",
            "transitous-runner",
            "transitous-tools",
          ].map((name) => [name, `ghcr.io/openmapx/${name}@sha256:${"3".repeat(64)}`]),
        ),
        privacyReleaseValidation,
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
          { execution: testExecution(), signal: new AbortController().signal, emitLog: vi.fn() },
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
      expect(appliedCalls).toEqual([["services", "update", "--no-deps", "app-api"]]);
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
              "privacy-backup",
              "transitous-runner",
              "transitous-tools",
            ].map((name) => [name, `ghcr.io/openmapx/${name}@sha256:${"3".repeat(64)}`]),
          ),
          privacyReleaseValidation,
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
          { execution: testExecution(), signal: new AbortController().signal, emitLog: vi.fn() },
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
            "privacy-backup",
            "transitous-runner",
            "transitous-tools",
          ].map((name) => [name, `ghcr.io/openmapx/${name}@sha256:${tag.repeat(64)}`]),
        ),
        privacyReleaseValidation,
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
        execution: testExecution(),
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
              "privacy-backup",
              "transitous-runner",
              "transitous-tools",
            ].map((name) => [name, `ghcr.io/openmapx/${name}@sha256:${"5".repeat(64)}`]),
          ),
          privacyReleaseValidation,
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
          { execution: testExecution(), signal: new AbortController().signal, emitLog: vi.fn() },
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
    await appliedInspectionFixture(rootDir);
    writeFileSync(
      join(rootDir, "infra", "docker", ".trusted-config-current", "docker-compose.generated.yml"),
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
          "privacy-backup",
          "transitous-runner",
          "transitous-tools",
        ].map((name, index) => [
          name,
          `ghcr.io/openmapx/${name}@sha256:${String(index + 1).repeat(64)}`,
        ]),
      ),
      privacyReleaseValidation,
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
        if (joined.endsWith(" config -q")) return "";
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
      effects.inspectSystem({
        execution: testExecution(),
        signal: new AbortController().signal,
        emitLog: vi.fn(),
      }),
    ).resolves.toMatchObject({
      dockerReachable: true,
      services: [
        { serviceId: "app-api", state: "update_available", releaseMember: true },
        { serviceId: "app-web", state: "current", releaseMember: true },
        { serviceId: "data-manager", state: "not_running", releaseMember: true },
        { serviceId: "ops-agent", state: "unknown", releaseMember: true },
        { serviceId: "transitous-runner", state: "unknown", releaseMember: true },
      ],
    });
    expect(calls.flat()).not.toContain("attacker-container");
  });

  describe("system inspection fails closed on unusable observations", () => {
    async function systemFixture(
      compose: "file" | "directory" | "missing",
      runDocker: (args: readonly string[]) => Promise<string>,
    ) {
      const rootDir = temporaryRoot();
      const releaseDirectory = join(rootDir, "infra", "docker", ".ops-agent-releases");
      mkdirSync(releaseDirectory, { mode: 0o700 });
      await appliedInspectionFixture(rootDir);
      const composePath = join(
        rootDir,
        "infra",
        "docker",
        ".trusted-config-current",
        "docker-compose.generated.yml",
      );
      rmSync(composePath);
      if (compose === "file") writeFileSync(composePath, "services:{}\n", { mode: 0o600 });
      if (compose === "directory") mkdirSync(composePath, { mode: 0o700 });
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
              "privacy-backup",
              "transitous-runner",
              "transitous-tools",
            ].map((name, index) => [
              name,
              `ghcr.io/openmapx/${name}@sha256:${String(index + 1).repeat(64)}`,
            ]),
          ),
          privacyReleaseValidation,
        }),
        { mode: 0o600 },
      );
      return createDefaultReleaseEffects(rootDir, async () => undefined, { runDocker });
    }

    const context = () => ({
      execution: testExecution(),
      signal: new AbortController().signal,
      emitLog: vi.fn(),
    });

    it("reports unknown rather than stopped when a per-service observation throws", async () => {
      const effects = await systemFixture("file", async (args) => {
        const joined = args.join(" ");
        if (joined.startsWith("info ")) return "28.0.0\n";
        if (joined.endsWith(" config -q")) return "";
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

    it("compares running images with release pins by repository digest without downloading", async () => {
      const pin = (name: string, digit: number) =>
        `ghcr.io/openmapx/${name}@sha256:${String(digit).repeat(64)}`;
      const running: Record<string, string> = {
        [`sha256:${"a".repeat(64)}`]: JSON.stringify([pin("api", 1)]),
        [`sha256:${"b".repeat(64)}`]: JSON.stringify([
          `ghcr.io/openmapx/web@sha256:${"e".repeat(64)}`,
        ]),
        [`sha256:${"d".repeat(64)}`]: JSON.stringify([pin("ops-agent", 4)]),
        [`sha256:${"f".repeat(64)}`]: "[]",
      };
      const containers: Record<string, string> = {
        "app-api": "a",
        "app-web": "b",
        "data-manager": "c",
        "ops-agent": "d",
        "transitous-runner": "f",
      };
      const calls: string[][] = [];
      const effects = await systemFixture("file", async (args) => {
        calls.push([...args]);
        const joined = args.join(" ");
        if (joined.startsWith("info ")) return "28.0.0\n";
        if (joined.endsWith(" config -q")) return "";
        const ps = /ps -q ([a-z-]+)$/.exec(joined);
        if (ps) return containers[ps[1]].repeat(64);
        if (args.includes("{{.Image}}"))
          return `sha256:${String(args.at(-1)).slice(0, 1).repeat(64)}`;
        if (args.some((arg) => arg.includes(".Config.Env")))
          return `OPS_PRIVACY_BACKUP_COLLECTOR_IMAGE=${pin("privacy-backup", 5)}\n`;
        if (args.includes("{{json .RepoDigests}}")) {
          const digests = running[String(args.at(-1))];
          if (digests !== undefined) return digests;
        }
        throw new Error("No such image");
      });

      const result = await effects.inspectSystem(context());
      expect(result.services).toEqual([
        expect.objectContaining({ serviceId: "app-api", state: "current" }),
        expect.objectContaining({ serviceId: "app-web", state: "update_available" }),
        expect.objectContaining({ serviceId: "data-manager", state: "unknown" }),
        expect.objectContaining({ serviceId: "ops-agent", state: "current" }),
        expect.objectContaining({ serviceId: "transitous-runner", state: "update_available" }),
      ]);
      for (const service of result.services) expect(service.localImageId).toBeUndefined();
      expect(calls.some((args) => args[0] === "pull")).toBe(false);
    });

    it("rejects a non-file Compose path instead of reporting it ready", async () => {
      const effects = await systemFixture("directory", async (args) => {
        const joined = args.join(" ");
        if (joined.startsWith("info ")) return "28.0.0\n";
        return "";
      });

      const result = await effects.inspectSystem(context());
      expect(result).toMatchObject({ composeReady: false, maintenanceReady: false });
      for (const service of result.services) expect(service.state).toBe("unknown");
    });

    it("rejects a Compose document the Compose boundary cannot parse", async () => {
      const effects = await systemFixture("file", async (args) => {
        const joined = args.join(" ");
        if (joined.startsWith("info ")) return "28.0.0\n";
        if (joined.endsWith(" config -q")) throw new Error("invalid compose project");
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
            "privacy-backup",
            "transitous-runner",
            "transitous-tools",
          ].map((name, index) => [
            name,
            `ghcr.io/openmapx/${name}@sha256:${String(index + 1).repeat(64)}`,
          ]),
        ),
        privacyReleaseValidation,
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
        { execution: testExecution(), signal: new AbortController().signal, emitLog: vi.fn() },
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
        validateCandidate: async () => undefined,
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
      "apply:release-123:data-manager,app-web,transitous-runner,app-api",
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
        validateCandidate: async () => undefined,
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
          expectedDigest: "a".repeat(64),
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
      "apply:release-123:data-manager,app-web,transitous-runner,app-api",
    ]);
  });

  it("does not apply a system update when release pulling fails", async () => {
    const apply = vi.fn(async () => undefined);
    const runtime = createUnavailableRuntime();
    createAdministrativeRuntime(runtime, {
      rootDir: temporaryRoot(),
      runFixedCli: async () => undefined,
      releaseEffects: {
        validateCandidate: async () => undefined,
        resolve: async () => "release-123",
        pull: async () => {
          throw new Error("collector pull failed");
        },
        inspect: async () => ({}),
        inspectSystem: async () => ({
          dockerReachable: true,
          composeReady: true,
          maintenanceReady: true,
          release: {},
          services: [],
        }),
        apply,
      },
    });
    await expect(
      dispatchOpsOperation(
        runtime,
        {
          kind: "system.update",
          expectedDigest: "a".repeat(64),
          releaseId: "release-123",
          createBackup: false,
        },
        context("system.update"),
      ),
    ).rejects.toThrow("collector pull failed");
    expect(apply).not.toHaveBeenCalled();
  });
});

describe("fixed CLI execution context", () => {
  it("uses the original long deadline and clears inherited control authority", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const root = temporaryRoot();
    const ready = join(root, "ready");
    const release = join(root, "release");
    const execution = testExecution();
    execution.deadlineAt = Date.now() + 12 * 3600_000;
    writeFileSync(
      join(root, "cli.mjs"),
      `import{writeFileSync,existsSync}from'node:fs';import{setTimeout}from'node:timers/promises';if(process.env.OPENMAPX_CONTROL_DELEGATION||process.env.OPENMAPX_PARENT_EXECUTION)process.exit(2);const execution=JSON.parse(process.env.OPENMAPX_CONTROL_EXECUTION);writeFileSync(${JSON.stringify(ready)},JSON.stringify(execution));while(!existsSync(${JSON.stringify(release)}))await setTimeout(5);console.log('completed');`,
    );
    vi.stubEnv("OPENMAPX_CONTROL_DELEGATION", "untrusted-inherited");
    vi.stubEnv("OPENMAPX_PARENT_EXECUTION", "untrusted-parent");
    let settled = false;
    const completion = createDefaultFixedCli(root, join(root, "agent.mjs"))([], {
      execution,
      operationKind: "service.build",
      signal: new AbortController().signal,
      emitLog: () => undefined,
    });
    void completion
      .finally(() => {
        settled = true;
      })
      .catch(() => undefined);
    try {
      await vi.waitFor(() => expect(existsSync(ready)).toBe(true), { timeout: 2000 });
      expect(JSON.parse(readFileSync(ready, "utf8"))).toEqual(execution);
      await vi.advanceTimersByTimeAsync(31 * 60_000);
      expect(settled).toBe(false);
      writeFileSync(release, "go");
      await expect(completion).resolves.toBeUndefined();
      await expect(
        createDefaultFixedCli(root, join(root, "agent.mjs"))([], {
          execution: { ...execution, deadlineAt: Date.now() - 1 },
          signal: new AbortController().signal,
          emitLog: () => undefined,
        }),
      ).rejects.toMatchObject({ errorClass: "timeout" });
    } finally {
      writeFileSync(release, "go");
      vi.useRealTimers();
      vi.unstubAllEnvs();
      await completion.catch(() => undefined);
    }
  });
});

it("never gives release recovery a fresh execution budget after restart expiry", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const rootDir = temporaryRoot();
  const releaseId = "release-expired-recovery";
  const directory = join(rootDir, "infra", "docker", ".ops-agent-releases");
  mkdirSync(directory, { mode: 0o700 });
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
          "privacy-backup",
          "transitous-runner",
          "transitous-tools",
        ].map((name) => [name, `ghcr.io/openmapx/${name}@sha256:${"a".repeat(64)}`]),
      ),
      privacyReleaseValidation,
    }),
    { mode: 0o600 },
  );
  const execution = { ...testExecution(), deadlineAt: Date.now() + 1000 };
  const runFixedCli = vi.fn(async () => undefined);
  try {
    const first = createDefaultReleaseEffects(rootDir, runFixedCli, {
      afterReleasePhase: (phase) => {
        if (phase === "overlay_written") throw Error("crash");
      },
    });
    await expect(
      first.apply(releaseId, ["app-api"], {
        signal: new AbortController().signal,
        emitLog: () => undefined,
        execution,
      }),
    ).rejects.toThrow("crash");
    vi.setSystemTime(Date.now() + 2000);
    const recovered = createDefaultReleaseEffects(rootDir, runFixedCli);
    await expect(recovered.initialize?.()).rejects.toMatchObject({
      name: "OpsExecutionFailure",
      errorClass: "timeout",
    });
    expect(runFixedCli).not.toHaveBeenCalled();
    expect(existsSync(join(directory, "transaction.json"))).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

describe("fix1 legacy release recovery", () => {
  it.each(["overlay_written", "rollback_services"])(
    "refuses legacy %s effects without a retained deadline",
    async (phase) => {
      const rootDir = temporaryRoot();
      const releaseId = "release-legacy-unknown";
      const directory = join(rootDir, "infra", "docker", ".ops-agent-releases");
      mkdirSync(directory, { mode: 0o700 });
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
              "privacy-backup",
              "transitous-runner",
              "transitous-tools",
            ].map((name) => [name, `ghcr.io/openmapx/${name}@sha256:${"a".repeat(64)}`]),
          ),
          privacyReleaseValidation,
        }),
        { mode: 0o600 },
      );
      const first = createDefaultReleaseEffects(rootDir, async () => undefined, {
        afterReleasePhase: (p) => {
          if (p === "overlay_written") throw Error("fixture crash");
        },
      });
      await expect(
        first.apply(releaseId, ["app-api"], {
          signal: new AbortController().signal,
          emitLog: () => undefined,
        }),
      ).rejects.toThrow("fixture crash");
      const transaction = join(directory, "transaction.json");
      const record = JSON.parse(readFileSync(transaction, "utf8"));
      record.phase = phase;
      writeFileSync(transaction, JSON.stringify(record));
      const overlay = join(rootDir, "infra", "docker", "docker-compose.release.yml");
      writeFileSync(overlay, "operator-state\n");
      const run = vi.fn(async () => undefined);
      const recovered = createDefaultReleaseEffects(rootDir, run, {
        verifyAppliedRelease: async () => true,
      });
      await expect(recovered.initialize?.()).rejects.toMatchObject({
        name: "OpsExecutionFailure",
        errorClass: "recovery_required",
      });
      expect(run).not.toHaveBeenCalled();
      expect(readFileSync(overlay, "utf8")).toBe("operator-state\n");
      expect(existsSync(transaction)).toBe(true);
    },
  );
});

it("fix1 recovery cannot publish after verification consumes the remaining deadline", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const rootDir = temporaryRoot();
  const releaseId = "release-verification-expiry";
  const directory = join(rootDir, "infra/docker/.ops-agent-releases");
  mkdirSync(directory, { mode: 0o700 });
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
          "privacy-backup",
          "transitous-runner",
          "transitous-tools",
        ].map((name) => [name, `ghcr.io/openmapx/${name}@sha256:${"a".repeat(64)}`]),
      ),
      privacyReleaseValidation,
    }),
    { mode: 0o600 },
  );
  const execution = { ...testExecution(), deadlineAt: Date.now() + 1000 };
  try {
    const first = createDefaultReleaseEffects(rootDir, async () => undefined, {
      afterReleasePhase: (phase) => {
        if (phase === "overlay_written") throw Error("fixture crash");
      },
    });
    await expect(
      first.apply(releaseId, ["app-api"], {
        execution,
        signal: new AbortController().signal,
        emitLog: () => undefined,
      }),
    ).rejects.toThrow("fixture crash");
    const path = join(directory, "transaction.json");
    const record = JSON.parse(readFileSync(path, "utf8"));
    record.phase = "services_applied";
    writeFileSync(path, JSON.stringify(record));
    const recovered = createDefaultReleaseEffects(rootDir, async () => undefined, {
      verifyAppliedRelease: async () => {
        vi.setSystemTime(Date.now() + 2000);
        return true;
      },
    });
    await expect(recovered.initialize?.()).rejects.toMatchObject({ errorClass: "timeout" });
    expect(existsSync(join(directory, "current.json"))).toBe(false);
    expect(existsSync(path)).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});
