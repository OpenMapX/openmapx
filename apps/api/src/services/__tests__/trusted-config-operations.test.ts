import { beforeEach, describe, expect, it, vi } from "vitest";

const published: unknown[] = [];
const applyEnabledIds = vi.fn();
const abort = vi.fn();
const operations: unknown[] = [];
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
  resolveAllServiceConfigs: async () => ({
    values: new Map([["photon", { LANGUAGES: "de" }]]),
    envKeys: new Map(),
  }),
}));
vi.mock("../service-secrets", () => ({
  resolveServiceVaultSecretsStrict: async () => ({}),
}));
vi.mock("../ops-client", () => ({
  createApiOpsClient: vi.fn(),
  executeTrustedConfigurationAndWait: vi.fn(),
}));
vi.mock("../trusted-config-publisher", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../trusted-config-publisher")>()),
  publishTrustedConfigurationSnapshot: async (options: {
    payload: unknown;
    operationForRevision: (revisionId: string) => unknown;
  }) => {
    published.push(options.payload);
    const operation = options.operationForRevision(`cfg1_${"r".repeat(43)}`);
    operations.push(operation);
    return { operation, abort };
  },
}));
vi.mock("@openmapx/core/ops", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openmapx/core/ops")>()),
  readOpsTokenFile: async () => "token",
}));

const { applyTrustedConfiguration, applyTrustedConfigurationSnapshot } = await import(
  "../trusted-config-operations"
);

const { executeTrustedConfigurationAndWait } = await import("../ops-client");
const { TrustedConfigurationApplyError, isProvenConfigurationNonCommit } = await import(
  "../trusted-config-outcome"
);

describe("applyTrustedConfiguration", () => {
  beforeEach(() => {
    published.length = 0;
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
    expect(error).toBeInstanceOf(TrustedConfigurationApplyError);
    expect(error.outcome).toMatchObject({
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
    expect(error.outcome).toMatchObject({ outcome: "unknown", publisherCleanupFailed: true });
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
    ).rejects.toThrow("Trusted configuration unavailable");
    await expect(
      applyTrustedConfiguration({ kind: "serviceSelection.apply", operationKey: "opk1_sel" }),
    ).rejects.toThrow("Trusted configuration unavailable");
  });
});
