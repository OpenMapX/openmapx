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

const { _argvGuards, handleBackupOperationJob, handleDataOperationJob, handleServiceBulkJob } =
  await import("../admin-job-handlers");

describe("argv guards", () => {
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

  describe("rejectFlagLike", () => {
    it("rejects strings starting with '-'", () => {
      expect(() => _argvGuards.rejectFlagLike("--preset=app", "x")).toThrow(/must not begin/);
      expect(() => _argvGuards.rejectFlagLike("-h", "x")).toThrow();
    });
    it("accepts plain values", () => {
      expect(() => _argvGuards.rejectFlagLike("germany", "x")).not.toThrow();
    });
  });

  describe("assertSlug", () => {
    it("accepts typical service ids", () => {
      expect(() => _argvGuards.assertSlug("valhalla", "id")).not.toThrow();
      expect(() => _argvGuards.assertSlug("app-api", "id")).not.toThrow();
      expect(() => _argvGuards.assertSlug("foo_bar.baz", "id")).not.toThrow();
    });
    it("rejects flag-like, empty, or odd-shape input", () => {
      expect(() => _argvGuards.assertSlug("--preset", "id")).toThrow();
      expect(() => _argvGuards.assertSlug("foo bar", "id")).toThrow();
      expect(() => _argvGuards.assertSlug("/etc/passwd", "id")).toThrow();
    });
  });

  describe("assertRegion", () => {
    it("accepts typical region selectors", () => {
      expect(() => _argvGuards.assertRegion("germany")).not.toThrow();
      expect(() => _argvGuards.assertRegion("europe/germany")).not.toThrow();
    });
    it("rejects path traversal and flags", () => {
      expect(() => _argvGuards.assertRegion("../etc")).toThrow();
      expect(() => _argvGuards.assertRegion("--region")).toThrow();
    });
  });

  describe("assertCountries", () => {
    it("accepts ISO codes", () => {
      expect(() => _argvGuards.assertCountries("DE")).not.toThrow();
      expect(() => _argvGuards.assertCountries("DE,CH,AT")).not.toThrow();
    });
    it("rejects malformed input", () => {
      expect(() => _argvGuards.assertCountries("germany")).toThrow();
      expect(() => _argvGuards.assertCountries("--countries=DE")).toThrow();
    });
  });

  describe("assertInsideRepo", () => {
    it("accepts paths that resolve inside the repo", () => {
      expect(_argvGuards.assertInsideRepo("infra/docker/feeds.json", "feedsFile")).toBe(
        "/repo/infra/docker/feeds.json",
      );
      expect(_argvGuards.assertInsideRepo("/repo/data/feeds.json", "feedsFile")).toBe(
        "/repo/data/feeds.json",
      );
    });
    it("rejects path traversal escapes", () => {
      expect(() => _argvGuards.assertInsideRepo("../../etc/passwd", "feedsFile")).toThrow(
        /inside the repo root/,
      );
      expect(() => _argvGuards.assertInsideRepo("/etc/passwd", "feedsFile")).toThrow(
        /inside the repo root/,
      );
    });
    it("rejects flag-like input", () => {
      expect(() => _argvGuards.assertInsideRepo("--output=foo", "output")).toThrow();
    });
  });

  describe("assertKnownServiceIds", () => {
    it("admits ids in the registry", () => {
      expect(() => _argvGuards.assertKnownServiceIds(["valhalla", "osrm"])).not.toThrow();
    });
    it("rejects unknown ids", () => {
      expect(() => _argvGuards.assertKnownServiceIds(["nope"])).toThrow(/Unknown serviceId/);
    });
    it("rejects flag-shaped ids before checking the registry", () => {
      expect(() => _argvGuards.assertKnownServiceIds(["--preset=app"])).toThrow();
    });
  });

  describe("Overture operations", () => {
    it("maps a validated sync region to a typed agent operation", async () => {
      runAdminOperationMock.mockClear();
      const ctx = {
        jobId: "job",
        payload: { operation: "overture-sync", region: "europe/germany" },
        signal: new AbortController().signal,
        log: vi.fn(),
        setProgress: vi.fn(),
        checkpoint: vi.fn(),
      };
      await handleDataOperationJob(ctx);
      expect(runAdminOperationMock).toHaveBeenCalledWith(
        ctx,
        { kind: "data.overtureSync", regionId: "europe/germany" },
        "admin-job.data.overture-sync",
      );
      expect(runCliMock).not.toHaveBeenCalled();
    });

    it("rejects an invalid region before invoking the CLI", async () => {
      runAdminOperationMock.mockClear();
      await expect(
        handleDataOperationJob({
          jobId: "job",
          payload: { operation: "overture-conflate", region: "../etc", restart: true },
          signal: new AbortController().signal,
          log: vi.fn(),
          setProgress: vi.fn(),
          checkpoint: vi.fn(),
        }),
      ).rejects.toThrow(/region/);
      expect(runAdminOperationMock).not.toHaveBeenCalled();
    });
  });

  describe("search index operations", () => {
    it("maps search-index-build to a typed region ID", async () => {
      runAdminOperationMock.mockClear();
      const ctx = {
        jobId: "job",
        payload: { operation: "search-index-build", region: "europe/germany" },
        signal: new AbortController().signal,
        log: vi.fn(),
        setProgress: vi.fn(),
        checkpoint: vi.fn(),
      };
      await handleDataOperationJob(ctx);

      expect(runAdminOperationMock).toHaveBeenCalledWith(
        ctx,
        { kind: "data.searchIndexBuild", regionId: "europe/germany" },
        "admin-job.data.search-index-build",
      );
    });

    it("requires a search index region", async () => {
      runAdminOperationMock.mockClear();
      await expect(
        handleDataOperationJob({
          jobId: "job",
          payload: { operation: "search-index-build" },
          signal: new AbortController().signal,
          log: vi.fn(),
          setProgress: vi.fn(),
          checkpoint: vi.fn(),
        }),
      ).rejects.toThrow("search-index-build requires region");
      expect(runAdminOperationMock).not.toHaveBeenCalled();
    });

    it("rejects traversal in search index region", async () => {
      runAdminOperationMock.mockClear();
      await expect(
        handleDataOperationJob({
          jobId: "job",
          payload: { operation: "search-index-build", region: "../etc" },
          signal: new AbortController().signal,
          log: vi.fn(),
          setProgress: vi.fn(),
          checkpoint: vi.fn(),
        }),
      ).rejects.toThrow("region must match");
      expect(runAdminOperationMock).not.toHaveBeenCalled();
    });
  });

  describe("fixed data authority", () => {
    it("does not forward caller URL, output path, argv, or environment for API-key generation", async () => {
      runAdminOperationMock.mockClear();
      const ctx = {
        jobId: "job",
        payload: {
          operation: "generate-api-keys",
          repoUrl: "https://attacker.example/catalog.git",
          output: "/tmp/attacker",
          argv: ["--output", "/etc/passwd"],
          environment: { NODE_OPTIONS: "--require=/tmp/payload" },
        },
        signal: new AbortController().signal,
        log: vi.fn(),
        setProgress: vi.fn(),
        checkpoint: vi.fn(),
      };
      await handleDataOperationJob(ctx);
      expect(runAdminOperationMock).toHaveBeenCalledWith(
        ctx,
        { kind: "data.generateApiKeys", catalogRevisionId: "transitous-fixed-v1" },
        "admin-job.data.generate-api-keys",
      );
      expect(JSON.stringify(runAdminOperationMock.mock.calls[0]?.[1])).not.toContain("attacker");
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
