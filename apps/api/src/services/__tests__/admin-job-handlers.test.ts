import { describe, expect, it, vi } from "vitest";

const runCliMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
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
