import { beforeEach, describe, expect, it, vi } from "vitest";

const published: unknown[] = [];
const applyEnabledIds = vi.fn();
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
  executeAndWait: vi.fn(),
}));
vi.mock("../trusted-config-publisher", () => ({
  publishTrustedConfigurationSnapshot: async (options: {
    payload: unknown;
    operationForRevision: (revisionId: string) => unknown;
  }) => {
    published.push(options.payload);
    return { operation: options.operationForRevision(`cfg1_${"r".repeat(43)}`) };
  },
  consumePublishedTrustedConfiguration: async () => ({
    revisionId: `cfg1_${"r".repeat(43)}`,
    enabledServiceIds: ["photon"],
  }),
}));
vi.mock("@openmapx/core/ops", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openmapx/core/ops")>()),
  readOpsTokenFile: async () => "token",
}));

const { applyTrustedConfiguration } = await import("../trusted-config-operations");

describe("applyTrustedConfiguration", () => {
  beforeEach(() => {
    published.length = 0;
    applyEnabledIds.mockClear();
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
