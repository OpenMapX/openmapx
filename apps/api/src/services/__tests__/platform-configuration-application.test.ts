import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JobContext } from "../job-runner";

const PREVIEW_LIFETIME_MS = 600_000;
const order: string[] = [];
let registryDown = false;
let pullDurationMs = 0;
let previewRelease: { releaseId: string; manifestDigest: string } | undefined;
let previewCreatedAt = 0;

const executeAdminOperation = vi.fn(async (_ctx: JobContext, operation: { kind: string }) => {
  order.push(operation.kind);
  if (operation.kind === "release.images.pull") {
    if (registryDown) throw new Error("registry unavailable");
    vi.setSystemTime(Date.now() + pullDurationMs);
  }
  return { images: [] };
});
const writer = vi.fn(async (_input: unknown, run: () => Promise<unknown>) => {
  order.push("maintenance");
  return run();
});
// The store enforces the preview's original lifetime against the current time.
const readPreview = vi.fn(async () => {
  if (Date.now() >= previewCreatedAt + PREVIEW_LIFETIME_MS)
    throw new PlatformPreviewConflict("Platform preview expired; create a new preview");
  return { preview: previewRelease ? { release: previewRelease } : {} };
});
class PlatformPreviewConflict extends Error {}

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
vi.mock("../platform-configuration-participant", () => ({
  platformConfigurationParticipation: vi.fn(),
  preparePlatformConfigurationChange: async () => {
    throw new Error("stop after maintenance began");
  },
}));
vi.mock("../prospective-configuration", () => ({
  persistAndApplyProspectiveConfiguration: vi.fn(),
  prepareProspectiveConfiguration: vi.fn(),
}));
vi.mock("../platform-preview-store", () => ({
  PlatformPreviewConflict,
  readPlatformPreview: readPreview,
}));

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
const release = { releaseId: "release-checked", manifestDigest: "a".repeat(64) };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-09T12:00:00Z") });
  vi.clearAllMocks();
  order.length = 0;
  registryDown = false;
  pullDurationMs = 0;
  previewRelease = undefined;
  previewCreatedAt = Date.now() - 60_000;
});

describe("platform change with a release selection", () => {
  it("pulls the selected release's images before maintenance begins", async () => {
    previewRelease = release;

    await runPlatformConfigurationChange(context(), input).catch(() => undefined);

    expect(order).toEqual(["release.images.pull", "maintenance"]);
    expect(executeAdminOperation.mock.calls[0]?.[1]).toEqual({
      kind: "release.images.pull",
      ...release,
    });
  });

  it("never enters maintenance when the registry is unavailable", async () => {
    previewRelease = release;
    registryDown = true;

    await expect(runPlatformConfigurationChange(context(), input)).rejects.toThrow(
      "registry unavailable",
    );

    expect(order).toEqual(["release.images.pull"]);
  });

  it("fails before maintenance when the download outlasts the preview", async () => {
    previewRelease = release;
    pullDurationMs = 30 * 60_000;

    await expect(runPlatformConfigurationChange(context(), input)).rejects.toThrow(
      "Create a new preview and apply again",
    );

    expect(order).toEqual(["release.images.pull"]);
  });

  it("downloads nothing for a change without a release", async () => {
    await runPlatformConfigurationChange(context(), input).catch(() => undefined);
    expect(order).toEqual(["maintenance"]);
  });

  it("does not pull again once the change has resumed from a retained candidate", async () => {
    previewRelease = release;

    await runPlatformConfigurationChange(
      context({ _configurationCandidate: { operationKey: "opk1_x" } }),
      input,
    ).catch(() => undefined);

    expect(order).toEqual(["maintenance"]);
  });
});
