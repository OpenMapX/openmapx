import { beforeEach, describe, expect, it, vi } from "vitest";

const published: unknown[] = [];
const applyEnabledIds = vi.fn();
const abort = vi.fn();
const operations: unknown[] = [];
const inspect = vi.fn();
const prepared = vi.fn();
const service = (id: string) => ({
  manifest: { id, container: { image: `t/${id}`, tag: "1" } },
});

vi.mock("../../db", () => ({
  db: { select: () => ({ from: async () => [] }) },
}));
vi.mock("../../db/schema", () => ({ integrationConfig: {} }));
vi.mock("../../integration-host", () => ({ getAllIntegrations: () => [] }));
vi.mock("../service-registry", () => ({
  getServiceRegistry: () => ({
    list: () => [service("valhalla"), service("photon")],
    applyEnabledIds,
  }),
}));
vi.mock("../service-config-resolver", () => ({
  resolveAllServiceConfigs: async () => {
    prepared();
    return { values: new Map([["photon", { LANGUAGES: "de" }]]), envKeys: new Map() };
  },
}));
vi.mock("../service-secrets", () => ({
  resolveServiceVaultSecretsStrict: async () => ({}),
}));
vi.mock("../ops-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ops-client")>()),
  createApiOpsClient: vi.fn(),
  createDurableOpsKey: () => "opk1_inspect123456789",
  executeTrustedConfigurationAndWait: vi.fn(),
  executeAndWait: (...args: unknown[]) => inspect(...args),
}));
vi.mock("../admin-job-ops", async (original) => ({
  ...(await original<typeof import("../admin-job-ops")>()),
  executeAdminJobOperation: async (
    _ctx: unknown,
    operation: unknown,
    _namespace: string,
    options: { preparedRoot: { operationKey: string } },
  ) => {
    const { executeTrustedConfigurationAndWait } = await import("../ops-client");
    return executeTrustedConfigurationAndWait(
      undefined as never,
      operation as never,
      options.preparedRoot.operationKey,
    );
  },
}));
vi.mock("../trusted-config-publisher", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../trusted-config-publisher")>()),
  publishTrustedConfigurationSnapshot: async (options: {
    payload: unknown;
    operationKey: string;
    operationForRevision: (revisionId: string) => unknown;
  }) => {
    published.push(options.payload);
    const operation = options.operationForRevision(`cfg1_${"r".repeat(43)}`);
    operations.push(operation);
    expect(options.operationKey).toMatch(/^opk1_t1_/);
    return { operation, abort };
  },
}));
vi.mock("@openmapx/core/ops", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openmapx/core/ops")>()),
  readOpsTokenFile: async () => "token",
}));

const subject = await import("../trusted-config-operations");
function owner() {
  const ctx = {
    jobId: "1d2b29cd-23de-4b19-8c32-86c196833b79",
    execution: { owner: "4c0c9623-252c-41b6-8f99-41915ad38b12", version: 1 },
    payload: {},
    signal: new AbortController().signal,
    checkpointResult: {} as Record<string, unknown>,
    checkpoint: async (value: Record<string, unknown>) => {
      ctx.checkpointResult = value;
    },
    log: vi.fn(),
    setProgress: vi.fn(),
  };
  return ctx;
}
const applyTrustedConfiguration = (
  options: Parameters<typeof subject.applyTrustedConfiguration>[0],
) => subject.applyTrustedConfiguration({ ...options, ctx: options.ctx ?? owner() });
const applyTrustedConfigurationWithEvidence = (
  options: Parameters<typeof subject.applyTrustedConfigurationWithEvidence>[0],
) => subject.applyTrustedConfigurationWithEvidence({ ...options, ctx: options.ctx ?? owner() });
const applyTrustedConfigurationSnapshot = (
  options: Parameters<typeof subject.applyTrustedConfigurationSnapshot>[0],
) => subject.applyTrustedConfigurationSnapshot({ ...options, ctx: options.ctx ?? owner() });

const { executeTrustedConfigurationAndWait } = await import("../ops-client");
const { isProvenConfigurationNonCommit } = await import("../trusted-config-outcome");

describe("applyTrustedConfiguration", () => {
  beforeEach(() => {
    published.length = 0;
    prepared.mockReset();
    inspect.mockReset().mockResolvedValue({ revisionId: null, integrationConfigDigests: [] });
    operations.length = 0;
    applyEnabledIds.mockReset();
    abort.mockReset().mockResolvedValue(undefined);
    vi.mocked(executeTrustedConfigurationAndWait)
      .mockReset()
      .mockResolvedValue({
        outcome: "committed",
        revisionId: `cfg1_${"r".repeat(43)}`,
        enabledServiceIds: ["photon"],
        followUp: "complete",
        cleanupFailed: false,
      });
    process.env.OPS_TRUSTED_CONFIG_DIR = "/var/lib/openmapx/trusted-config";
    process.env.OPS_AGENT_TOKEN_FILE = "/run/secrets/ops-agent-api-token";
    process.env.OPS_TRUSTED_CONFIG_UID = "1000";
    process.env.OPS_TRUSTED_CONFIG_GID = "1000";
  });

  it.each([
    "stack.render",
    "serviceSelection.apply",
    "serviceConfig.apply",
    "integrationConfig.apply",
    "vault.apply",
  ] as const)(
    "fences a delayed %s snapshot after a competing writer completes, without retry",
    async (kind) => {
      const observed = `cfg1_${"a".repeat(43)}`;
      const completed = `cfg1_${"b".repeat(43)}`;
      let current = observed;
      let release!: () => void;
      let captured!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const capture = new Promise<void>((resolve) => {
        captured = resolve;
      });
      inspect.mockImplementation(async () => {
        expect(prepared).not.toHaveBeenCalled();
        return { revisionId: current, integrationConfigDigests: [] };
      });
      vi.mocked(executeTrustedConfigurationAndWait).mockImplementation(
        async (_client, operation) => {
          captured();
          await held;
          if (
            (operation as { expectedCurrentRevisionId?: string }).expectedCurrentRevisionId !==
              undefined &&
            (operation as { expectedCurrentRevisionId?: string }).expectedCurrentRevisionId !==
              current
          )
            return {
              outcome: "not_committed",
              reason: "conflict",
              currentRevisionId: current,
              cleanupFailed: false,
            };
          current = operation.revisionId;
          return {
            outcome: "committed",
            revisionId: current,
            enabledServiceIds: [],
            followUp: "complete",
            cleanupFailed: false,
          };
        },
      );
      const pending = applyTrustedConfigurationWithEvidence({
        kind,
        operationKey: "opk1_initialOwnership",
        serviceId: "photon",
        integrationId: "alpha",
        ...(kind === "serviceSelection.apply" ? { selectedRoots: ["photon"] } : {}),
      });
      await capture;
      // B finishes while A's already prepared payload is held at submission.
      current = completed;
      release();
      const result = await pending;
      expect(operations[0]).toHaveProperty("expectedCurrentRevisionId", observed);
      expect(result.outcome).toMatchObject({ outcome: "not_committed", reason: "conflict" });
      expect(current).toBe(completed);
      expect(executeTrustedConfigurationAndWait).toHaveBeenCalledTimes(1);
    },
  );
  it("does not prepare or publish when authoritative observation is unavailable", async () => {
    inspect.mockRejectedValueOnce(new Error("synthetic observation failure"));
    const result = await applyTrustedConfigurationWithEvidence({
      kind: "stack.render",
      operationKey: "opk1_observeFailure123",
    });
    expect(result.outcome).toMatchObject({ outcome: "not_committed", reason: "failed" });
    expect(prepared).not.toHaveBeenCalled();
    expect(published).toEqual([]);
    expect(executeTrustedConfigurationAndWait).not.toHaveBeenCalled();
  });
  it("returns the exact submitted payload with settled evidence for scoped compensation", async () => {
    const result = await applyTrustedConfigurationWithEvidence({
      kind: "stack.render",
      operationKey: "opk1_import",
    });
    expect(result.payload).toEqual(published[0]);
    expect(result.previousApplied).toEqual({ revisionId: null, integrationConfigDigests: [] });
    expect(result.outcome).toMatchObject({
      outcome: "committed",
      followUp: "complete",
      publisherCleanupFailed: false,
    });
    expect(operations).toHaveLength(1);
  });
  it("leaves the selection to the deployment and carries every service's saved config", async () => {
    await applyTrustedConfiguration({ kind: "stack.render", operationKey: "opk1_render" });

    expect(published).toHaveLength(1);
    const payload = published[0] as Record<string, unknown>;
    expect(payload).not.toHaveProperty("selectedRoots");
    expect(payload.serviceConfigs).toEqual([
      { serviceId: "valhalla", values: {} },
      { serviceId: "photon", values: { LANGUAGES: "de" } },
    ]);
    // The registry follows what the ops-agent applied.
    expect(applyEnabledIds).toHaveBeenCalledWith(new Set(["photon"]));
  });

  it("publishes the exact full snapshot with a bound expected-current precondition", async () => {
    const payload = {
      domain: "old.example.test",
      serviceConfigs: [],
      integrationConfigs: [],
      serviceSecrets: [],
    };
    const result = await applyTrustedConfigurationSnapshot({
      payload,
      expectedCurrentRevisionId: null,
      operationKey: "opk1_compensation123",
    });
    expect(published).toEqual([payload]);
    expect(operations).toEqual([
      {
        kind: "stack.render",
        revisionId: `cfg1_${"r".repeat(43)}`,
        expectedCurrentRevisionId: null,
      },
    ]);
    expect(result).toMatchObject({ outcome: "committed", publisherCleanupFailed: false });
    for (const expectedCurrentRevisionId of [undefined, "manifest-v1"] as unknown as string[]) {
      expect(
        await applyTrustedConfigurationSnapshot({
          payload,
          expectedCurrentRevisionId,
          operationKey: "opk1_badConditional123",
        }),
      ).toMatchObject({ outcome: "not_committed" });
    }
    expect(published).toHaveLength(1);
  });
  it("retains known commit evidence on publisher or registry cleanup failure", async () => {
    abort.mockRejectedValueOnce(new Error("cleanup"));
    applyEnabledIds.mockImplementationOnce(() => {
      throw new Error("registry");
    });
    const error = await applyTrustedConfiguration({
      kind: "stack.render",
      operationKey: "opk1_cleanup1234567",
    }).catch((error) => error);
    expect(error).toMatchObject({ name: "AdminJobFailure" });
    expect(error.result.configuration).toMatchObject({
      outcome: "committed",
      publisherCleanupFailed: true,
      registryUpdateFailed: true,
    });
    expect(isProvenConfigurationNonCommit(error)).toBe(false);
  });
  it("never classifies an arbitrary submission rejection as proven non-commit", async () => {
    vi.mocked(executeTrustedConfigurationAndWait).mockRejectedValueOnce(new Error("transport"));
    abort.mockRejectedValueOnce(new Error("cleanup"));
    const error = await applyTrustedConfiguration({
      kind: "stack.render",
      operationKey: "opk1_unknown1234567",
    }).catch((error) => error);
    expect(error).toBeInstanceOf(Error);
    expect(isProvenConfigurationNonCommit(error)).toBe(false);
    expect(isProvenConfigurationNonCommit(new Error("generic failure"))).toBe(false);
  });
  it("carries roots with a selection apply only", async () => {
    await applyTrustedConfiguration({
      kind: "serviceSelection.apply",
      operationKey: "opk1_selection",
      selectedRoots: ["photon"],
    });
    expect(published[0]).toMatchObject({ selectedRoots: ["photon"] });

    await expect(
      applyTrustedConfiguration({
        kind: "stack.render",
        operationKey: "opk1_render",
        selectedRoots: ["photon"],
      }),
    ).rejects.toMatchObject({
      name: "AdminJobFailure",
      result: { configuration: { outcome: "not_committed" } },
    });
    await expect(
      applyTrustedConfiguration({ kind: "serviceSelection.apply", operationKey: "opk1_sel" }),
    ).rejects.toMatchObject({
      name: "AdminJobFailure",
      result: { configuration: { outcome: "not_committed" } },
    });
  });
});

it("resumes a retained render without inspecting or rebuilding newer configuration", async () => {
  prepared.mockClear();
  inspect.mockReset().mockResolvedValue({ revisionId: null, integrationConfigDigests: [] });
  published.length = 0;
  process.env.OPS_TRUSTED_CONFIG_DIR = "/var/lib/openmapx/trusted-config";
  process.env.OPS_AGENT_TOKEN_FILE = "/run/secrets/ops-agent-api-token";
  process.env.OPS_TRUSTED_CONFIG_UID = "1000";
  process.env.OPS_TRUSTED_CONFIG_GID = "1000";
  vi.mocked(executeTrustedConfigurationAndWait).mockResolvedValue({
    outcome: "not_committed",
    reason: "failed",
    cleanupFailed: false,
  });
  const { createApiOpsClient } = await import("../ops-client");
  const key = "opk1_retainedRender12345";
  const operationId = "job1_retainedRender12345";
  const revisionId = `cfg1_${"r".repeat(43)}`;
  const operation = { kind: "stack.render", revisionId, expectedCurrentRevisionId: null };
  const result = {
    outcome: "committed",
    revisionId,
    enabledServiceIds: [],
    followUp: "complete",
    cleanupFailed: false,
  };
  const client = {
    execute: vi.fn(),
    lookup: vi.fn(),
    cancel: vi.fn(),
    status: vi.fn().mockResolvedValue({
      version: 1,
      kind: operation.kind,
      operationId,
      operationKey: key,
      state: "succeeded",
      result,
      submittedAt: "2026-10-23T00:00:00Z",
      updatedAt: "2026-10-23T00:00:00Z",
    }),
    events: vi.fn().mockResolvedValue({
      version: 1,
      operationId,
      nextCursor: 0,
      terminal: true,
      truncated: false,
      events: [],
    }),
  };
  vi.mocked(createApiOpsClient).mockReturnValue(client as never);
  const ctx = {
    jobId: "1d2b29cd-23de-4b19-8c32-86c196833b79",
    payload: {},
    signal: new AbortController().signal,
    log: vi.fn(),
    checkpoint: vi.fn(),
    setProgress: vi.fn(),
    checkpointResult: {
      opsProjection: {
        version: 2,
        eventTotal: 0,
        byteTotal: 0,
        truncated: false,
        operations: {
          [key]: {
            kind: operation.kind,
            operation,
            operationId,
            operationKey: key,
            phase: "observing",
            cursor: 0,
            events: 0,
            bytes: 0,
            terminal: false,
            truncated: false,
          },
        },
      },
    },
  };
  await expect(
    applyTrustedConfigurationWithEvidence({
      kind: "stack.render",
      operationKey: key,
      ctx,
    } as never),
  ).rejects.toMatchObject({ reason: "recovery_required" });
  expect(prepared).not.toHaveBeenCalled();
  expect(inspect).not.toHaveBeenCalled();
  expect(published).toEqual([]);
  expect(client.execute).not.toHaveBeenCalled();
  expect(client.status).toHaveBeenCalled();
});

it("refuses unowned direct configuration before preparing a new snapshot", async () => {
  prepared.mockClear();
  published.length = 0;
  inspect.mockClear();
  const result = await subject
    .applyTrustedConfiguration({ kind: "stack.render", operationKey: "opk1_opaqueDirect12345" })
    .catch((e) => e);
  expect(result).toMatchObject({
    name: "TrustedConfigurationUpgradeRequired",
    outcome: { outcome: "not_committed" },
  });
  expect(isProvenConfigurationNonCommit(result)).toBe(true);
  expect(prepared).not.toHaveBeenCalled();
  expect(inspect).not.toHaveBeenCalled();
  expect(published).toEqual([]);
});
