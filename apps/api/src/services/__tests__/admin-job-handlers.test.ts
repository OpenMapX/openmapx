import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

const runCliMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const preparedRevision = `cfg1_${"p".repeat(43)}`;
const prepareGenerationMock = vi.hoisted(() => vi.fn());
vi.mock("../service-preparation", () => ({
  prepareServiceGeneration: (...args: unknown[]) => prepareGenerationMock(...args),
}));
const runAdminOperationMock = vi.hoisted(() =>
  vi
    .fn()
    .mockImplementation(async (_ctx, operation) =>
      "backupId" in operation
        ? { backupId: operation.backupId }
        : { completed: true, resourceId: operation.regionId ?? operation.dataTypeId },
    ),
);

// Stub the heavy import chain so the argv-guard tests don't bring in the real
// service registry, postgres client, or CLI runner. We only exercise pure
// validation helpers.
vi.mock("@openmapx/core/server", () => ({
  findRepoRoot: () => "/repo",
}));
vi.mock("@openmapx/core", () => ({
  validatePublicUrl: (url: string) => {
    if (!/^https?:\/\//i.test(url)) throw new Error("not a public url");
  },
}));
vi.mock("../admin-cli", () => ({
  assertValidBackupName: vi.fn(),
  runOpenmapxCliJobCommand: runCliMock,
}));
vi.mock("../admin-job-ops", () => ({
  executeAdminJobOperation: runAdminOperationMock,
}));
vi.mock("../service-registry", () => ({
  getServiceRegistry: () => ({
    list: () => [
      { manifest: { id: "valhalla" } },
      { manifest: { id: "osrm" } },
      { manifest: { id: "app-api" } },
    ],
  }),
}));

const enqueue = vi.fn().mockResolvedValue("queued-job");
const audit = vi.fn();
vi.mock("../job-runner", () => ({
  jobRunner: { enqueue: (...args: unknown[]) => enqueue(...args) },
}));
vi.mock("../../utils/audit-log", () => ({ writeAuditLog: (...args: unknown[]) => audit(...args) }));
vi.mock("../../utils/require-admin", () => ({
  requireAdmin: async () => ({ user: { id: "admin" } }),
  getAdminSession: () => ({ user: { id: "admin" } }),
}));
const { adminOperationsRoute } = await import("../../routes/admin-operations");

const { handleBackupOperationJob, handleDataOperationJob, handleServiceBulkJob } = await import(
  "../admin-job-handlers"
);

describe("admin job handlers", () => {
  describe("backup operations", () => {
    it("submits only typed backup IDs and options to the operations agent", async () => {
      runAdminOperationMock.mockClear();
      const ctx = {
        jobId: "1d2b29cd-23de-4b19-8c32-86c196833b79",
        payload: {
          operation: "restore",
          name: "nightly",
          serviceIds: ["valhalla", "osrm"],
          stopRunning: true,
          argv: ["--privileged"],
          path: "/etc",
        },
        signal: new AbortController().signal,
        log: vi.fn(),
        setProgress: vi.fn(),
        checkpoint: vi.fn(),
      };

      await expect(handleBackupOperationJob(ctx)).resolves.toEqual({
        operation: "restore",
        backupId: "nightly",
      });
      expect(runAdminOperationMock).toHaveBeenCalledWith(
        ctx,
        {
          kind: "backup.restore",
          backupId: "nightly",
          serviceIds: ["valhalla", "osrm"],
          stopRunning: true,
        },
        "admin-job.backup.restore",
      );
      expect(runCliMock).not.toHaveBeenCalled();
    });

    it("derives an idempotent bounded backup ID when create omits one", async () => {
      runAdminOperationMock.mockClear();
      const ctx = {
        jobId: "1d2b29cd-23de-4b19-8c32-86c196833b79",
        payload: { operation: "create" },
        signal: new AbortController().signal,
        log: vi.fn(),
        setProgress: vi.fn(),
        checkpoint: vi.fn(),
      };
      await handleBackupOperationJob(ctx);
      expect(runAdminOperationMock).toHaveBeenCalledWith(
        ctx,
        {
          kind: "backup.create",
          backupId: "job-1d2b29cd-23de-4b19-8c32-86c196833b79",
        },
        "admin-job.backup.create",
      );
    });
  });

  describe("data operations", () => {
    function dataCtx(payload: Record<string, unknown>) {
      return {
        jobId: "job",
        payload,
        signal: new AbortController().signal,
        log: vi.fn(),
        setProgress: vi.fn(),
        checkpoint: vi.fn(),
      };
    }

    // Queuing normalized countries makes the actual execution parser reject a valid request.
    it.each([
      [
        { region: "europe/germany", countries: "de, at", failFast: true },
        {
          kind: "data.update",
          regionId: "europe/germany",
          countryCodes: ["DE", "AT"],
          failFast: true,
        },
      ],
      [{ countries: "  , " }, { kind: "data.update" }],
      [{}, { kind: "data.update" }],
    ])("executes actual update route payload %j exactly once", async (raw, effect) => {
      enqueue.mockClear();
      audit.mockClear();
      runAdminOperationMock.mockClear();
      const app = Fastify();
      await app.register(adminOperationsRoute);
      try {
        const preview = await app.inject({
          method: "POST",
          url: "/admin/operations/update/preview",
          payload: raw,
        });
        expect(preview.statusCode).toBe(200);
        expect(preview.json().preview.length).toBeGreaterThan(0);
        const response = await app.inject({
          method: "POST",
          url: "/admin/operations/update/run",
          payload: raw,
        });
        expect(response.statusCode).toBe(200);
        const payload = enqueue.mock.calls[0][1];
        const ctx = dataCtx(payload);
        await handleDataOperationJob(ctx);
        expect(runAdminOperationMock.mock.calls).toEqual([[ctx, effect, "admin-job.data.update"]]);
        expect(payload).toEqual({ operation: "update", version: 1, input: raw });
        expect(audit.mock.calls[0][0].details).toEqual(preview.json().input);
      } finally {
        await app.close();
      }
    });

    it.each([
      ["download-osm", { region: "  " }, { kind: "data.downloadOsm" }],
      [
        "convert-overpass",
        { region: " europe/germany " },
        { kind: "data.convertOverpass", regionId: "europe/germany" },
      ],
      ["clean", { target: " osm " }, { kind: "data.clean", dataTypeId: "osm" }],
      [
        "overture-sync",
        { region: " europe/germany " },
        { kind: "data.overtureSync", regionId: "europe/germany" },
      ],
      [
        "overture-conflate",
        { region: " europe/germany " },
        { kind: "data.overtureConflate", regionId: "europe/germany" },
      ],
      [
        "search-index-build",
        { region: " europe/germany " },
        { kind: "data.searchIndexBuild", regionId: "europe/germany" },
      ],
    ])("round trips other transforming catalogue input %s", async (id, raw, effect) => {
      enqueue.mockClear();
      audit.mockClear();
      runAdminOperationMock.mockClear();
      const app = Fastify();
      await app.register(adminOperationsRoute);
      try {
        const response = await app.inject({
          method: "POST",
          url: `/admin/operations/${id}/run`,
          payload: raw,
        });
        expect(response.statusCode).toBe(200);
        const payload = enqueue.mock.calls[0][1];
        expect(payload).toEqual({ operation: id, version: 1, input: raw });
        const ctx = dataCtx(payload);
        await handleDataOperationJob(ctx);
        expect(runAdminOperationMock.mock.calls).toEqual([[ctx, effect, `admin-job.data.${id}`]]);
        if (id === "overture-conflate")
          expect(audit.mock.calls[0][0].details).toEqual({
            region: "europe/germany",
            restart: false,
          });
        if (id === "clean") expect(audit.mock.calls[0][0].details).toEqual({ target: "osm" });
      } finally {
        await app.close();
      }
    });

    it.each([undefined, null])("executes a parameterless raw %j route payload", async (raw) => {
      enqueue.mockClear();
      runAdminOperationMock.mockClear();
      const app = Fastify();
      await app.register(adminOperationsRoute);
      try {
        const response = await app.inject({
          method: "POST",
          url: "/admin/operations/download-fonts/run",
          ...(raw === undefined
            ? {}
            : { headers: { "content-type": "application/json" }, payload: "null" }),
        });
        expect(response.statusCode).toBe(200);
        const payload = enqueue.mock.calls[0][1];
        expect(payload).toEqual({ operation: "download-fonts", version: 1, input: {} });
        await handleDataOperationJob(dataCtx(payload));
        expect(runAdminOperationMock.mock.calls.map((call) => call[1])).toEqual([
          { kind: "data.downloadFonts" },
        ]);
      } finally {
        await app.close();
      }
    });

    it("rejects extra keys and transformed-array forgeries before enqueue or execution", async () => {
      enqueue.mockClear();
      runAdminOperationMock.mockClear();
      const app = Fastify();
      await app.register(adminOperationsRoute);
      try {
        for (const input of [{ countries: ["DE"] }, { argv: ["--privileged"] }]) {
          const response = await app.inject({
            method: "POST",
            url: "/admin/operations/update/run",
            payload: input,
          });
          expect(response.statusCode).toBe(400);
          await expect(
            handleDataOperationJob(dataCtx({ operation: "update", version: 1, input })),
          ).rejects.toThrow(/Invalid input/);
        }
        expect(enqueue).not.toHaveBeenCalled();
        expect(runAdminOperationMock).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    });

    it("maps a validated catalog input to a typed agent operation", async () => {
      runAdminOperationMock.mockClear();
      const ctx = dataCtx({
        operation: "overture-sync",
        version: 1,
        input: { region: "europe/germany" },
      });
      await expect(handleDataOperationJob(ctx)).resolves.toEqual({
        operation: "overture-sync",
        resourceId: "europe/germany",
      });
      expect(runAdminOperationMock).toHaveBeenCalledWith(
        ctx,
        { kind: "data.overtureSync", regionId: "europe/germany" },
        "admin-job.data.overture-sync",
      );
      expect(runCliMock).not.toHaveBeenCalled();
    });

    it("re-validates the stored input before submitting", async () => {
      runAdminOperationMock.mockClear();
      await expect(
        handleDataOperationJob(
          dataCtx({ operation: "overture-conflate", version: 1, input: { region: "../etc" } }),
        ),
      ).rejects.toThrow(/region/);
      await expect(
        handleDataOperationJob(dataCtx({ operation: "search-index-build", version: 1, input: {} })),
      ).rejects.toThrow(/region/);
      expect(runAdminOperationMock).not.toHaveBeenCalled();
    });

    it("rejects unknown operations and stale catalog versions", async () => {
      runAdminOperationMock.mockClear();
      await expect(
        handleDataOperationJob(dataCtx({ operation: "rm-rf", version: 1, input: {} })),
      ).rejects.toThrow("Unsupported data operation: rm-rf");
      await expect(
        handleDataOperationJob(dataCtx({ operation: "link", version: 99, input: {} })),
      ).rejects.toThrow(/catalog version 99; current is 1/);
      expect(runAdminOperationMock).not.toHaveBeenCalled();
    });

    it("does not forward caller URL, output path, argv, or environment for API-key generation", async () => {
      runAdminOperationMock.mockClear();
      await expect(
        handleDataOperationJob(
          dataCtx({
            operation: "generate-api-keys",
            version: 1,
            input: {
              repoUrl: "https://attacker.example/catalog.git",
              output: "/tmp/attacker",
              argv: ["--output", "/etc/passwd"],
              environment: { NODE_OPTIONS: "--require=/tmp/payload" },
            },
          }),
        ),
      ).rejects.toThrow(/Invalid input/);
      expect(runAdminOperationMock).not.toHaveBeenCalled();

      const ctx = dataCtx({ operation: "generate-api-keys", version: 1, input: {} });
      await handleDataOperationJob(ctx);
      expect(runAdminOperationMock).toHaveBeenCalledWith(
        ctx,
        { kind: "data.generateApiKeys", catalogRevisionId: "transitous-fixed-v1" },
        "admin-job.data.generate-api-keys",
      );
    });
  });

  describe("bulk service operations", () => {
    it("prepares one full generation before bulk Start and carries it to deterministic target children", async () => {
      prepareGenerationMock.mockReset().mockResolvedValue({
        revisionId: preparedRevision,
        coordinatorMode: "ensure-running",
        hardlinks: { applied: true, entries: 0, linked: 0, skipped: 0, pruned: 0 },
      });
      runAdminOperationMock.mockClear();
      const ctx = {
        jobId: "bulk-start-fixture",
        payload: { action: "start", serviceIds: ["valhalla", "osrm"] },
        signal: new AbortController().signal,
        log: vi.fn(),
        setProgress: vi.fn(),
        checkpoint: vi.fn(),
      };
      await handleServiceBulkJob(ctx);
      expect(prepareGenerationMock).toHaveBeenCalledTimes(1);
      expect(prepareGenerationMock).toHaveBeenCalledWith(ctx, "bulk-start", {
        coordinatorMode: "ensure-running",
      });
      expect(runAdminOperationMock.mock.calls.map((call) => call[1])).toEqual([
        {
          kind: "service.start",
          serviceId: "valhalla",
          expectedConfigurationRevisionId: preparedRevision,
        },
        {
          kind: "service.start",
          serviceId: "osrm",
          expectedConfigurationRevisionId: preparedRevision,
        },
      ]);
      expect(runAdminOperationMock.mock.calls.map((call) => call[3])).toEqual([
        { durableIdentity: "valhalla" },
        { durableIdentity: "osrm" },
      ]);
    });
    it("starts no bulk target when full preparation or hardlinks fail", async () => {
      prepareGenerationMock.mockReset().mockRejectedValue(new Error("synthetic hardlink failure"));
      runAdminOperationMock.mockClear();
      await expect(
        handleServiceBulkJob({
          jobId: "bulk-start-refusal",
          payload: { action: "start", serviceIds: ["valhalla", "osrm"] },
          signal: new AbortController().signal,
          log: vi.fn(),
          setProgress: vi.fn(),
          checkpoint: vi.fn(),
        }),
      ).rejects.toThrow("synthetic hardlink failure");
      expect(runAdminOperationMock).not.toHaveBeenCalled();
    });
    it("does not continue a batch after unknown admission even with continueOnError", async () => {
      const { OpsObservationPending } = await import("../ops-client");
      const pending = new OpsObservationPending(
        { kind: "service.build", operationKey: "opk1_abcdefghijklmnop" },
        "transport",
      );
      runAdminOperationMock.mockClear();
      runAdminOperationMock.mockRejectedValueOnce(pending);
      await expect(
        handleServiceBulkJob({
          jobId: "job",
          payload: { action: "build", serviceIds: ["valhalla", "osrm"], continueOnError: true },
          signal: new AbortController().signal,
          log: vi.fn(),
          setProgress: vi.fn(),
          checkpoint: vi.fn(),
        }),
      ).rejects.toBe(pending);
      expect(runAdminOperationMock).toHaveBeenCalledTimes(1);
    });

    it("submits one typed lifecycle operation per exact service ID", async () => {
      runAdminOperationMock.mockClear();
      const ctx = {
        jobId: "job",
        payload: { action: "restart", serviceIds: ["valhalla", "osrm"] },
        signal: new AbortController().signal,
        log: vi.fn(),
        setProgress: vi.fn(),
        checkpoint: vi.fn(),
      };
      await handleServiceBulkJob(ctx);
      expect(runAdminOperationMock.mock.calls.map((call) => call.slice(1))).toEqual([
        [
          { kind: "service.restart", serviceId: "valhalla" },
          "admin-job.service.restart",
          { durableIdentity: "valhalla" },
        ],
        [
          { kind: "service.restart", serviceId: "osrm" },
          "admin-job.service.restart",
          { durableIdentity: "osrm" },
        ],
      ]);
      expect(runCliMock).not.toHaveBeenCalled();
    });

    it("uses the bounded build-all variant and typed region options", async () => {
      runAdminOperationMock.mockClear();
      const ctx = {
        jobId: "job",
        payload: {
          action: "build",
          all: true,
          region: "europe/germany",
          continueOnError: false,
        },
        signal: new AbortController().signal,
        log: vi.fn(),
        setProgress: vi.fn(),
        checkpoint: vi.fn(),
      };
      await handleServiceBulkJob(ctx);
      expect(runAdminOperationMock).toHaveBeenCalledWith(
        ctx,
        { kind: "services.buildAll", regionId: "europe/germany", failFast: true },
        "admin-job.services.build-all",
      );
    });

    it("rejects flag-shaped and unknown service IDs before submitting", async () => {
      runAdminOperationMock.mockClear();
      await expect(
        handleServiceBulkJob({
          jobId: "job",
          payload: { action: "start", serviceIds: ["--all"] },
          signal: new AbortController().signal,
          log: vi.fn(),
          setProgress: vi.fn(),
          checkpoint: vi.fn(),
        }),
      ).rejects.toThrow();
      expect(runAdminOperationMock).not.toHaveBeenCalled();
    });
  });
});
