/** Producer-boundary tests. SQL writer/CAS and real prospective publication are
 * qualified by the owned PostgreSQL suites; these fixtures exercise the retained
 * producer's immutable candidate, observation and public outcome contracts. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AdminJobFailure } from "../admin-job-failure";
import type { JobContext } from "../job-runner";
import { TrustedConfigurationApplyError } from "../trusted-config-outcome";

const ports = vi.hoisted(() => ({
  inspect: vi.fn(),
  prepare: vi.fn(),
  state: vi.fn(),
  apply: vi.fn(),
  retained: vi.fn(),
  observe: vi.fn(),
  immediate: vi.fn(),
  writer: vi.fn(),
}));
vi.mock("../../integration-host", () => ({ getAllIntegrations: () => [] }));
vi.mock("../ops-client", () => ({
  createApiOpsClient: () => ({}),
  createDurableOpsKey: (namespace: string, key: string) => `${namespace}:${key}`,
  executeAndWait: (...args: unknown[]) => ports.inspect(...args),
}));
vi.mock("../admin-job-ops", () => ({
  hasRetainedAdminJobOperation: (...args: unknown[]) => ports.retained(...args),
  observeRetainedAdminJobOperation: (...args: unknown[]) => ports.observe(...args),
}));
vi.mock("../job-runner", () => ({
  jobRunner: { applyImmediateConfiguration: (...args: unknown[]) => ports.immediate(...args) },
}));
vi.mock("../administrative-configuration-writer", () => ({
  withAdministrativeConfigurationJob: (_ctx: JobContext, run: () => unknown) => run(),
  withAdministrativeConfigurationWriter: (options: unknown, run: () => unknown) => {
    ports.writer(options);
    return run();
  },
}));
vi.mock("../prospective-configuration", () => ({
  prepareProspectiveConfiguration: (...args: unknown[]) => ports.prepare(...args),
  validatedConfigurationCandidateState: (...args: unknown[]) => ports.state(...args),
  persistAndApplyProspectiveConfiguration: (...args: unknown[]) => ports.apply(...args),
  retireSettledProspectiveConfiguration: vi.fn(),
}));

const subject = await import("../trusted-config-operations");
const owned = await import("../trusted-configuration-producer");
const key = "opk1_originalConfiguration123";
const revisionId = `cfg1_${"r".repeat(43)}`;
const previousRevisionId = `cfg1_${"p".repeat(43)}`;
const candidate = { candidateId: "original-candidate", revisionId, operationKey: key };
const payload = {
  domain: "fixture.example.test",
  selectedRoots: ["photon"],
  serviceConfigs: [],
  integrationConfigs: [],
  serviceSecrets: [],
};
const committed = {
  outcome: "committed" as const,
  revisionId,
  enabledServiceIds: ["photon"],
  followUp: "complete" as const,
  cleanupFailed: false,
  publisherCleanupFailed: false,
  registryUpdateFailed: false,
};
function owner(): JobContext {
  const ctx: JobContext = {
    jobId: "original-job",
    payload: {},
    signal: new AbortController().signal,
    log: vi.fn(),
    setProgress: vi.fn(),
    checkpoint: vi.fn(async (value) => {
      ctx.checkpointResult = value;
    }),
    checkpointResult: {},
  };
  return ctx;
}
beforeEach(() => {
  vi.clearAllMocks();
  ports.inspect
    .mockReset()
    .mockResolvedValue({ revisionId: previousRevisionId, integrationConfigDigests: [] });
  ports.prepare.mockReset().mockResolvedValue(candidate);
  ports.state.mockReset().mockReturnValue({
    payload,
    sealed: { operation: { kind: "stack.render" } },
    record: {},
    overlay: { purpose: "render", changes: [] },
  });
  ports.apply.mockReset().mockImplementation(async () => ({ application: { ...committed } }));
  ports.retained.mockReset().mockReturnValue(false);
  const {
    publisherCleanupFailed: _publisher,
    registryUpdateFailed: _registry,
    ...agentOutcome
  } = committed;
  ports.observe.mockReset().mockResolvedValue(agentOutcome);
  ports.immediate.mockReset();
});

describe("retained trusted configuration producer", () => {
  it("binds preparation to the observed applied generation and submits the original candidate once", async () => {
    const ctx = owner();
    const result = await subject.applyTrustedConfigurationWithEvidence({
      kind: "stack.render",
      operationKey: key,
      ctx,
    });
    expect(ports.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: ctx.jobId,
        expectedCurrentRevisionId: previousRevisionId,
        operationKey: key,
      }),
    );
    expect(ports.apply).toHaveBeenCalledExactlyOnceWith(candidate, {
      coordinatorMode: "ensure-running",
      signal: ctx.signal,
    });
    expect(result).toMatchObject({
      payload,
      previousApplied: { revisionId: previousRevisionId },
      outcome: committed,
    });
  });

  it("does not prepare or submit when authoritative observation fails", async () => {
    ports.inspect.mockRejectedValueOnce(new Error("observation unavailable"));
    await expect(
      subject.applyTrustedConfigurationWithEvidence({
        kind: "stack.render",
        operationKey: key,
        ctx: owner(),
      }),
    ).rejects.toThrow("observation unavailable");
    expect(ports.prepare).not.toHaveBeenCalled();
    expect(ports.apply).not.toHaveBeenCalled();
  });

  it.each<{
    sealed?: { operation: { kind: string; serviceId?: string } };
    record?: { apiFollowUp: string };
    followUp?: "service-apply";
    message: string;
  }>([
    {
      sealed: { operation: { kind: "vault.apply", serviceId: "photon" } },
      message: "candidate intent",
    },
    {
      record: { apiFollowUp: "integration-reload" },
      followUp: "service-apply" as const,
      message: "continuation intent",
    },
  ])(
    "rejects mismatched immutable $message before submission",
    async ({ sealed, record, followUp, message }) => {
      ports.state.mockReturnValue({
        payload,
        sealed: sealed ?? { operation: { kind: "stack.render" } },
        record: record ?? {},
        overlay: { purpose: "render", changes: [] },
      });
      await expect(
        subject.applyTrustedConfigurationWithEvidence({
          kind: "stack.render",
          operationKey: key,
          ctx: owner(),
          ...(followUp ? { followUp } : {}),
        }),
      ).rejects.toThrow(message);
      expect(ports.apply).not.toHaveBeenCalled();
    },
  );

  it("does not restore a snapshot different from the strictly owned candidate", async () => {
    await expect(
      subject.applyTrustedConfigurationSnapshot({
        payload: { ...payload, domain: "changed.example.test" },
        expectedCurrentRevisionId: previousRevisionId,
        operationKey: key,
        ctx: owner(),
      }),
    ).rejects.toThrow("Strict compensation requires current owned desired rows");
    expect(ports.apply).not.toHaveBeenCalled();
  });

  it("keeps a known failure actionable in the owned checkpoint and public immediate response", async () => {
    const ctx = owner();
    const problem = "services/martin/config/martin.yaml has more than one link";
    ports.apply.mockResolvedValue({
      application: {
        outcome: "not_committed",
        reason: "failed",
        cleanupFailed: false,
        publisherCleanupFailed: false,
        registryUpdateFailed: false,
      },
    });
    ports.inspect.mockImplementation(async (_client, operation: { kind: string }) =>
      operation.kind === "configuration.failure.inspect"
        ? { attemptedRevisionId: revisionId, problem }
        : { revisionId: previousRevisionId },
    );
    ports.immediate.mockImplementation((options) =>
      owned.applyTrustedConfigurationWithEvidence({ ...options, ctx }),
    );
    const error = await subject
      .applyTrustedConfiguration({ kind: "stack.render", operationKey: key })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TrustedConfigurationApplyError);
    expect(error).toMatchObject({ message: problem, statusCode: 409 });
    expect(ctx.checkpointResult?._configurationOutcomes).toMatchObject({
      [key]: { problem, outcome: "not_committed" },
    });
    expect(ports.inspect).toHaveBeenCalledWith(
      {},
      { kind: "configuration.failure.inspect", attemptedRevisionId: revisionId },
      expect.any(String),
      expect.anything(),
    );
  });

  it("retains failure evidence when an older agent cannot explain it", async () => {
    ports.apply.mockResolvedValue({
      application: {
        outcome: "not_committed",
        reason: "failed",
        cleanupFailed: false,
        publisherCleanupFailed: false,
        registryUpdateFailed: false,
      },
    });
    ports.inspect.mockImplementation(async (_client, operation: { kind: string }) => {
      if (operation.kind === "configuration.failure.inspect") throw new Error("unknown kind");
      return { revisionId: previousRevisionId };
    });
    const result = await subject.applyTrustedConfigurationWithEvidence({
      kind: "stack.render",
      operationKey: key,
      ctx: owner(),
    });
    expect(result.outcome).toMatchObject({ outcome: "not_committed", reason: "failed" });
    expect(result.outcome).not.toHaveProperty("problem");
    expect(ports.apply).toHaveBeenCalledOnce();
  });

  it("reobserves the retained attempt and original outcome without preparing newer input", async () => {
    const ctx = owner();
    ctx.checkpointResult = { _configurationOutcomes: { [key]: committed } };
    ports.retained.mockReturnValue(true);
    const result = await subject.applyTrustedConfigurationWithEvidence({
      kind: "stack.render",
      operationKey: key,
      ctx,
    });
    expect(result.outcome).toEqual(committed);
    expect(ports.observe).toHaveBeenCalledExactlyOnceWith(ctx, key);
    expect(ports.inspect).not.toHaveBeenCalled();
    expect(ports.prepare).not.toHaveBeenCalled();
    expect(ports.apply).not.toHaveBeenCalled();
  });

  it("keeps a retained child receipt unknown when API-owned cleanup evidence is missing", async () => {
    ports.retained.mockReturnValue(true);
    await expect(
      subject.applyTrustedConfigurationWithEvidence({
        kind: "stack.render",
        operationKey: key,
        ctx: owner(),
      }),
    ).rejects.toMatchObject({ reason: "recovery_required" });
    expect(ports.prepare).not.toHaveBeenCalled();
    expect(ports.apply).not.toHaveBeenCalled();
  });

  it("retains committed cleanup failure instead of claiming completed application", async () => {
    ports.apply.mockResolvedValue({ application: { ...committed, publisherCleanupFailed: true } });
    const error = await subject
      .applyTrustedConfiguration({ kind: "stack.render", operationKey: key, ctx: owner() })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AdminJobFailure);
    if (!(error instanceof AdminJobFailure)) throw error;
    expect(error.result.configuration).toMatchObject({
      outcome: "committed",
      publisherCleanupFailed: true,
    });
  });

  it("routes public contextless work to the retained immediate job rather than submitting directly", async () => {
    ports.immediate.mockResolvedValue({ outcome: committed, jobId: "retained-immediate-job" });
    await expect(
      subject.applyTrustedConfiguration({ kind: "stack.render", operationKey: key }),
    ).resolves.toMatchObject({ revisionId, jobId: "retained-immediate-job" });
    expect(ports.immediate).toHaveBeenCalledExactlyOnceWith({
      kind: "stack.render",
      operationKey: key,
    });
    expect(ports.apply).not.toHaveBeenCalled();
    await expect(
      owned.applyTrustedConfigurationWithEvidence({ kind: "stack.render", operationKey: key }),
    ).rejects.toMatchObject({ name: "TrustedConfigurationUpgradeRequired" });
  });
});
