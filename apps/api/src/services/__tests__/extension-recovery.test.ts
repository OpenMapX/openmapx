import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../agent-integrations", () => ({ recoverAgentIntegrations: vi.fn() }));
vi.mock("../community-repositories", () => ({
  reconcileCommunityRepositoryTransactions: vi.fn(),
}));
vi.mock("../runtime-recovery-authority", () => ({
  openRuntimeRecoveryAuthority: vi.fn(async () => ({ record: () => null, replace: vi.fn() })),
}));
vi.mock("../service-runtime-recovery", () => ({ reconcileDurableServiceRuntime: vi.fn() }));
vi.mock("../../integration-host", () => ({
  isIntegrationHostInitialized: vi.fn(() => true),
  reloadIntegrations: vi.fn(async () => ({ message: "ok", reloaded: 1, enabled: 1 })),
}));
vi.mock("../admin-ops", () => ({ renderAndPersistCompose: vi.fn() }));
vi.mock("../../utils/docker-compose", () => ({ dockerComposeAction: vi.fn() }));
vi.mock("../service-registry", () => ({ initServiceRegistry: vi.fn() }));
vi.mock("../trusted-config-operations", () => ({ applyTrustedConfiguration: vi.fn() }));

import { isIntegrationHostInitialized, reloadIntegrations } from "../../integration-host";
import { recoverAgentIntegrations } from "../agent-integrations";
import { reconcileCommunityRepositoryTransactions } from "../community-repositories";
import type { JobContext } from "../job-runner";

let recovery: typeof import("../extension-recovery.js");
beforeAll(async () => {
  recovery = await import("../extension-recovery.js");
}, 30_000);

const integrationsMock = vi.mocked(recoverAgentIntegrations);
const repositoriesMock = vi.mocked(reconcileCommunityRepositoryTransactions);
const reloadMock = vi.mocked(reloadIntegrations);
const initializedMock = vi.mocked(isIntegrationHostInitialized);

function integrationOutcome(overrides: { rolledBack?: string[] } = {}) {
  return { committed: [], rolledBack: [], ...overrides };
}

afterEach(() => {
  vi.clearAllMocks();
  initializedMock.mockReturnValue(true);
});

describe("recoverInterruptedExtensionChanges", () => {
  it("settles integration transactions before repository transactions", async () => {
    integrationsMock.mockResolvedValue(integrationOutcome());
    repositoriesMock.mockResolvedValue({
      runtimeRecoveryNeeded: false,
      orphanedServiceIds: [],
      restartServiceIds: [],
    });

    await recovery.recoverInterruptedExtensionChanges();

    expect(integrationsMock.mock.invocationCallOrder[0]).toBeLessThan(
      repositoriesMock.mock.invocationCallOrder[0] ?? 0,
    );
    expect(reloadMock).not.toHaveBeenCalled();
  });

  it("reloads integrations once when a rollback changed what is loadable", async () => {
    integrationsMock.mockResolvedValue(integrationOutcome({ rolledBack: ["intg-one"] }));
    repositoriesMock.mockResolvedValue({
      runtimeRecoveryNeeded: false,
      orphanedServiceIds: [],
      restartServiceIds: [],
    });

    await recovery.recoverInterruptedExtensionChanges();

    expect(reloadMock).toHaveBeenCalledTimes(1);
  });

  it("runs startup recovery without a job, so it only observes", async () => {
    integrationsMock.mockResolvedValue(integrationOutcome());
    repositoriesMock.mockResolvedValue({
      runtimeRecoveryNeeded: false,
      orphanedServiceIds: [],
      restartServiceIds: [],
    });

    await recovery.recoverInterruptedExtensionChanges();

    expect(integrationsMock).toHaveBeenCalledTimes(1);
    expect(integrationsMock.mock.calls[0]?.[0]).toMatchObject({ ctx: undefined });
  });

  it("hands the running job to integration recovery so it can settle", async () => {
    integrationsMock.mockResolvedValue(integrationOutcome());
    repositoriesMock.mockResolvedValue({
      runtimeRecoveryNeeded: false,
      orphanedServiceIds: [],
      restartServiceIds: [],
    });
    const ctx = { jobId: "job-1" } as unknown as JobContext;

    await recovery.recoverInterruptedExtensionChanges(undefined, { ctx });

    expect(integrationsMock.mock.calls[0]?.[0]).toMatchObject({ ctx });
  });

  it("leaves the reload to startup when the integration host is not loaded yet", async () => {
    integrationsMock.mockResolvedValue(integrationOutcome({ rolledBack: ["intg-one"] }));
    repositoriesMock.mockResolvedValue({
      runtimeRecoveryNeeded: false,
      orphanedServiceIds: [],
      restartServiceIds: [],
    });
    initializedMock.mockReturnValue(false);

    await recovery.recoverInterruptedExtensionChanges();

    expect(reloadMock).not.toHaveBeenCalled();
  });

  it("does not reconcile repositories when integration transactions cannot be settled", async () => {
    integrationsMock.mockRejectedValue(new Error("agent unavailable"));

    await expect(recovery.recoverInterruptedExtensionChanges()).rejects.toThrow(
      "agent unavailable",
    );
    expect(repositoriesMock).not.toHaveBeenCalled();
  });
});
