import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

let recovery: typeof import("../extension-recovery.js");
beforeAll(async () => {
  recovery = await import("../extension-recovery.js");
}, 30_000);

const integrationsMock = vi.mocked(recoverAgentIntegrations);
const repositoriesMock = vi.mocked(reconcileCommunityRepositoryTransactions);
const reloadMock = vi.mocked(reloadIntegrations);
const initializedMock = vi.mocked(isIntegrationHostInitialized);

function integrationOutcome(overrides: { adopted?: string[]; rolledBack?: string[] } = {}) {
  return { committed: [], rolledBack: [], adopted: [], needsReinstall: [], ...overrides };
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

  it.each([{ adopted: ["intg-one"] }, { rolledBack: ["intg-one"] }])(
    "reloads integrations once when recovery changed what is loadable (%o)",
    async (changed) => {
      integrationsMock.mockResolvedValue(integrationOutcome(changed));
      repositoriesMock.mockResolvedValue({
        runtimeRecoveryNeeded: false,
        orphanedServiceIds: [],
        restartServiceIds: [],
      });

      await recovery.recoverInterruptedExtensionChanges();

      expect(reloadMock).toHaveBeenCalledTimes(1);
    },
  );

  it("leaves adoption to the background pass when asked to", async () => {
    integrationsMock.mockResolvedValue(integrationOutcome());
    repositoriesMock.mockResolvedValue({
      runtimeRecoveryNeeded: false,
      orphanedServiceIds: [],
      restartServiceIds: [],
    });

    await recovery.recoverInterruptedExtensionChanges(undefined, { adoptIntegrations: false });

    expect(integrationsMock).toHaveBeenCalledWith(expect.objectContaining({ adopt: false }));
  });

  it("leaves the reload to startup when the integration host is not loaded yet", async () => {
    integrationsMock.mockResolvedValue(integrationOutcome({ adopted: ["intg-one"] }));
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

describe("adoptUnrecordedIntegrations", () => {
  it("adopts, then reloads only when something was recorded", async () => {
    integrationsMock.mockResolvedValueOnce(integrationOutcome({ adopted: ["intg-one"] }));
    await recovery.adoptUnrecordedIntegrations();
    expect(integrationsMock).toHaveBeenCalledWith(expect.not.objectContaining({ adopt: false }));
    expect(reloadMock).toHaveBeenCalledTimes(1);

    integrationsMock.mockResolvedValueOnce(integrationOutcome());
    await recovery.adoptUnrecordedIntegrations();
    expect(reloadMock).toHaveBeenCalledTimes(1);
    expect(repositoriesMock).not.toHaveBeenCalled();
  });
});

describe("warnAboutLegacyInstallJournals", () => {
  it("warns about install journals an earlier release left, and nothing else", () => {
    const directory = mkdtempSync(join(tmpdir(), "omx-legacy-journal-"));
    try {
      writeFileSync(join(directory, `.extension-install-journal-${"a".repeat(24)}.json`), "{}");
      writeFileSync(join(directory, ".extension-install-journal-short.json"), "{}");
      const warn = vi.fn();

      recovery.warnAboutLegacyInstallJournals(directory, warn);

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("verifies the integrations"));
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(`.extension-install-journal-${"a".repeat(24)}.json`),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("is silent without journals and never throws for a missing directory", () => {
    const warn = vi.fn();
    recovery.warnAboutLegacyInstallJournals(join(tmpdir(), "omx-missing-directory-x"), warn);
    expect(warn).not.toHaveBeenCalled();
  });
});
