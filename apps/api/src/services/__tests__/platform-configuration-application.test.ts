import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JobContext } from "../job-runner";

const order: string[] = [];
const executeAdminOperation = vi.fn(async (_ctx: JobContext, operation: { kind: string }) => {
  order.push(operation.kind);
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
  currentAdministrativeConfigurationWriter: vi.fn(),
  withAdministrativeConfigurationJob: (_ctx: JobContext, run: () => Promise<unknown>) => run(),
  withAdministrativeConfigurationWriter: writer,
}));
vi.mock("../configuration-commit-participant", () => ({
  withConfigurationCommitParticipant: vi.fn(),
}));
vi.mock("../platform-configuration-participant", () => ({
  platformConfigurationParticipation: vi.fn(),
  preparePlatformConfigurationChange: vi.fn(),
}));
vi.mock("../prospective-configuration", () => ({
  persistAndApplyProspectiveConfiguration: vi.fn(),
  prepareProspectiveConfiguration: vi.fn(),
}));
vi.mock("../platform-preview-store", () => ({
  readPlatformPreview: async () => ({
    preview: previewRelease ? { release: previewRelease } : {},
  }),
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

beforeEach(() => {
  vi.clearAllMocks();
  order.length = 0;
  registryDown = false;
  previewRelease = undefined;
});

describe("platform change with a release selection", () => {
  it("pulls the selected release's images before maintenance begins", async () => {
    previewRelease = { releaseId: "release-checked", manifestDigest: "a".repeat(64) };

    await runPlatformConfigurationChange(context(), input).catch(() => undefined);

    expect(order).toEqual(["release.images.pull", "maintenance"]);
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
    expect(order).toEqual(["maintenance"]);
  });

  it("does not pull again once the change has resumed from a retained candidate", async () => {
    previewRelease = { releaseId: "release-checked", manifestDigest: "a".repeat(64) };

    await runPlatformConfigurationChange(
      context({ _configurationCandidate: { operationKey: "opk1_x" } }),
      input,
    ).catch(() => undefined);

    expect(order).toEqual(["maintenance"]);
  });
});
