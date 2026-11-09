import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JobContext } from "../job-runner";

const releaseId = "release-checked",
  expectedDigest = "a".repeat(64),
  actorId = "admin-1";

// A small stand-in for the host: images arrive only through a pull, a started
// configuration change holds maintenance and stops services, and a registry
// outage fails any pull. The outcome a person sees is the host state afterwards.
const host = {
  registryDown: false,
  imagesPresent: false,
  maintenance: false,
  runningRelease: "old",
  running: ["app-api", "data-manager", "ops-agent"],
  kinds: [] as string[],
};
function resetHost() {
  host.registryDown = false;
  host.imagesPresent = false;
  host.maintenance = false;
  host.runningRelease = "old";
  host.running = ["app-api", "data-manager", "ops-agent"];
  host.kinds = [];
}

const executeAdminOperation = vi.fn(
  async (_ctx: JobContext, operation: { kind: string }, _namespace: string) => {
    host.kinds.push(operation.kind);
    if (operation.kind === "backup.create") return { backupId: "pre-update" };
    if (operation.kind === "release.images.pull") {
      if (host.registryDown) throw new Error("registry unavailable");
      host.imagesPresent = true;
      return { images: [{ image: "api", imageId: `sha256:${"d".repeat(64)}` }] };
    }
    throw new Error(`Unexpected operation ${operation.kind}`);
  },
);
// Applying the release enters maintenance and stops services. Without the
// images already on the host, the replacement has to pull them and fails during
// an outage with maintenance still held and services stopped.
const applyIntent = vi.fn(async () => {
  host.kinds.push("configurationMaintenance.prepare");
  host.maintenance = true;
  host.running = [];
  if (!host.imagesPresent) throw new Error("registry unavailable");
  host.runningRelease = releaseId;
  host.running = ["app-api", "data-manager", "ops-agent"];
  host.maintenance = false;
  return { application: { outcome: "applied" } };
});
const previewConfiguration = vi.fn(async () => ({
  preview: {
    previewFingerprint: "f".repeat(64),
    expectedCurrentRevisionId: null,
    requiredConfirmation: {
      domain: false,
      dnsTls: false,
      oauth: false,
      passkeys: false,
      alternateLogin: false,
    },
  },
}));

vi.mock("../../db", async () => {
  const { adminJob, user } = await import("../../db/schema");
  return {
    db: {
      select: () => ({
        from: (table: unknown) => ({
          where: async () =>
            table === adminJob
              ? [{ id: "job-1", type: "system.update", createdBy: actorId }]
              : table === user
                ? [{ id: actorId, role: "admin", banned: false }]
                : [],
        }),
      }),
    },
  };
});
vi.mock("../../integration-host", () => ({ getAllIntegrations: () => [] }));
vi.mock("../admin-job-ops", () => ({ executeAdminJobOperation: executeAdminOperation }));
vi.mock("../admin-job-state", () => ({ jobOwnership: () => ({}) }));
vi.mock("../administrative-configuration-writer-owner", () => ({
  withAdministrativeConfigurationJob: (_ctx: JobContext, run: () => Promise<unknown>) => run(),
  withAdministrativeConfigurationWriter: (_input: unknown, run: () => Promise<unknown>) => run(),
}));
vi.mock("../platform-configuration-application", () => ({
  applyPlatformConfigurationIntent: applyIntent,
}));
vi.mock("../platform-configuration-view", () => ({
  inspectPlatformConfiguration: async () => ({ expectedCurrentRevisionId: null }),
  previewPlatformConfiguration: previewConfiguration,
}));
vi.mock("../platform-preview-store", () => ({
  readPlatformPreview: async () => ({ preview: { release: { releaseId, manifestDigest: "a" } } }),
}));
vi.mock("../platform-configuration-job", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../platform-configuration-job")>()),
  platformJobMatchesPreview: () => true,
}));
vi.mock("../prospective-configuration", () => ({
  resumeRetainedConfigurationCandidate: vi.fn(),
  retainedConfigurationIntegrationIds: vi.fn(),
}));
vi.mock("../trusted-config-outcome", () => ({
  completeTrustedConfigurationApply: () => true,
  parseTrustedConfigurationApplyOutcome: (value: unknown) => value,
}));

const { runGuardedSystemRelease } = await import("../system-release-application");

function context(payload: Record<string, unknown> = {}): JobContext {
  return {
    jobId: "job-1",
    jobType: "system.update",
    execution: {} as JobContext["execution"],
    payload: {
      operation: "apply",
      workflow: "guarded-release",
      releaseId,
      expectedDigest,
      ...payload,
    },
    signal: new AbortController().signal,
    log: vi.fn().mockResolvedValue(undefined),
    setProgress: vi.fn().mockResolvedValue(undefined),
    checkpoint: vi.fn().mockResolvedValue(undefined),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetHost();
});

describe("guarded release image acquisition", () => {
  it("pulls the checked release images after the backup and before any preview or maintenance", async () => {
    await runGuardedSystemRelease(context());

    expect(host.kinds).toEqual([
      "backup.create",
      "release.images.pull",
      "configurationMaintenance.prepare",
    ]);
    const pull = executeAdminOperation.mock.calls.find(
      ([, operation]) => operation.kind === "release.images.pull",
    );
    expect(pull?.[1]).toEqual({
      kind: "release.images.pull",
      releaseId,
      manifestDigest: expectedDigest,
    });
    expect(pull?.[2]).toBe("admin-job.release.images");
    expect(previewConfiguration.mock.invocationCallOrder[0]).toBeGreaterThan(
      executeAdminOperation.mock.invocationCallOrder[1]!,
    );
    expect(host.runningRelease).toBe(releaseId);
  });

  it("pulls the images even when the backup is skipped", async () => {
    await runGuardedSystemRelease(context({ createBackup: false }));
    expect(host.kinds.slice(0, 2)).toEqual([
      "release.images.pull",
      "configurationMaintenance.prepare",
    ]);
  });

  it("a failed pre-pull ends the job and never sends configurationMaintenance.prepare", async () => {
    host.registryDown = true;

    await expect(runGuardedSystemRelease(context())).rejects.toThrow("registry unavailable");

    expect(host.kinds).toEqual(["backup.create", "release.images.pull"]);
    expect(previewConfiguration).not.toHaveBeenCalled();
    expect(applyIntent).not.toHaveBeenCalled();
  });

  it("services keep running on the old release during a registry outage", async () => {
    host.registryDown = true;

    await expect(runGuardedSystemRelease(context())).rejects.toThrow();

    expect(host.maintenance).toBe(false);
    expect(host.runningRelease).toBe("old");
    expect(host.running).toEqual(["app-api", "data-manager", "ops-agent"]);
  });
});
