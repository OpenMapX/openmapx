import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JobContext } from "../job-runner";

const order: string[] = [];
let pullDurationMs = 0;
const executeAdminOperation = vi.fn(async (_ctx: JobContext, operation: { kind: string }) => {
  order.push(operation.kind);
  if (operation.kind === "release.images.pull") vi.setSystemTime(Date.now() + pullDurationMs);
  if (operation.kind === "release.images.pull" && registryDown)
    throw new Error("registry unavailable");
  return { images: [] };
});
let registryDown = false;
let previewRelease: { releaseId: string; manifestDigest: string } | undefined;
const writer = vi.fn(async (_input: unknown, run: () => Promise<unknown>) => {
  order.push("maintenance");
  return run();
});

vi.mock("../../integration-host", () => ({ getAllIntegrations: () => [] }));
vi.mock("../admin-job-ops", () => ({ executeAdminJobOperation: executeAdminOperation }));
vi.mock("../administrative-configuration-writer-owner", () => ({
  currentAdministrativeConfigurationWriter: () => ({
    actorId: "admin-1",
    operationKey: "opk1_aaaaaaaaaaaaaaaaaaaa",
  }),
  withAdministrativeConfigurationJob: (_ctx: JobContext, run: () => Promise<unknown>) => run(),
  withAdministrativeConfigurationWriter: writer,
}));
vi.mock("../configuration-commit-participant", () => ({
  withConfigurationCommitParticipant: vi.fn(),
}));
// The real participant reads the preview again and enforces its lifetime.
vi.mock("../platform-configuration-participant", () => ({
  platformConfigurationParticipation: vi.fn(),
  preparePlatformConfigurationChange: async (input: { previewCheckedAt?: Date }) => {
    order.push("participant");
    await readPreview({
      actorId: "admin-1",
      previewFingerprint: "f".repeat(64),
      ...(input.previewCheckedAt ? { now: input.previewCheckedAt } : {}),
    });
    throw new Error("stop after the preview check");
  },
}));
vi.mock("../prospective-configuration", () => ({
  persistAndApplyProspectiveConfiguration: vi.fn(),
  prepareProspectiveConfiguration: vi.fn(),
}));
const PREVIEW_LIFETIME_MS = 600_000;
let previewCreatedAt = 0;
const readPreview = async (input: {
  actorId?: string;
  previewFingerprint?: string;
  now?: Date;
}) => {
  if ((input.now ?? new Date()).getTime() >= previewCreatedAt + PREVIEW_LIFETIME_MS)
    throw new Error("Platform preview expired; create a new preview");
  return { preview: previewRelease ? { release: previewRelease } : {} };
};
vi.mock("../platform-preview-store", () => ({ readPlatformPreview: readPreview }));

const { runPlatformConfigurationChange } = await import("../platform-configuration-application");
const input = {
  actorId: "admin-1",
  operationKey: "opk1_aaaaaaaaaaaaaaaaaaaa",
  previewFingerprint: "f".repeat(64),
  expectedCurrentRevisionId: null,
  confirmations: {
    domain: false,
    dnsTls: false,
    oauth: false,
    passkeys: false,
    alternateLogin: false,
  },
};
const context = (checkpointResult?: Record<string, unknown>): JobContext => ({
  jobId: "job-1",
  payload: {},
  signal: new AbortController().signal,
  log: vi.fn().mockResolvedValue(undefined),
  setProgress: vi.fn().mockResolvedValue(undefined),
  checkpoint: vi.fn().mockResolvedValue(undefined),
  ...(checkpointResult ? { checkpointResult } : {}),
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-09T12:00:00Z") });
  previewCreatedAt = Date.now() - 60_000;
  vi.clearAllMocks();
  order.length = 0;
  registryDown = false;
  pullDurationMs = 0;
  previewRelease = undefined;
});

describe("platform change with a release selection", () => {
  it("pulls the selected release's images before maintenance begins", async () => {
    previewRelease = { releaseId: "release-checked", manifestDigest: "a".repeat(64) };

    await runPlatformConfigurationChange(context(), input).catch(() => undefined);

    expect(order).toEqual(["release.images.pull", "maintenance", "participant"]);
    expect(executeAdminOperation.mock.calls[0]?.[1]).toEqual({
      kind: "release.images.pull",
      releaseId: "release-checked",
      manifestDigest: "a".repeat(64),
    });
  });

  it("never enters maintenance when the registry is unavailable", async () => {
    previewRelease = { releaseId: "release-checked", manifestDigest: "a".repeat(64) };
    registryDown = true;

    await expect(runPlatformConfigurationChange(context(), input)).rejects.toThrow(
      "registry unavailable",
    );

    expect(order).toEqual(["release.images.pull"]);
  });

  it("downloads nothing for a change without a release", async () => {
    await runPlatformConfigurationChange(context(), input).catch(() => undefined);
    expect(order).toEqual(["maintenance", "participant"]);
  });

  it("keeps the preview valid when the download outlasts its lifetime", async () => {
    previewRelease = { releaseId: "release-checked", manifestDigest: "a".repeat(64) };
    pullDurationMs = 30 * 60_000;

    await expect(runPlatformConfigurationChange(context(), input)).rejects.toThrow(
      "stop after the preview check",
    );

    expect(order).toEqual(["release.images.pull", "maintenance", "participant"]);
  });

  it("still refuses a preview that was already expired when the job started", async () => {
    previewRelease = { releaseId: "release-checked", manifestDigest: "a".repeat(64) };
    previewCreatedAt = Date.now() - PREVIEW_LIFETIME_MS - 1;

    await expect(runPlatformConfigurationChange(context(), input)).rejects.toThrow(
      "Platform preview expired",
    );

    expect(order).toEqual([]);
  });

  it("does not pull again once the change has resumed from a retained candidate", async () => {
    previewRelease = { releaseId: "release-checked", manifestDigest: "a".repeat(64) };

    await runPlatformConfigurationChange(
      context({ _configurationCandidate: { operationKey: "opk1_x" } }),
      input,
    ).catch(() => undefined);

    expect(order).toEqual(["maintenance", "participant"]);
  });
});
