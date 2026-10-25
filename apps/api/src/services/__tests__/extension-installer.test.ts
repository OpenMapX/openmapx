import { getKillSwitch } from "../extension-store";
import { TrustedConfigurationApplyError } from "../trusted-config-outcome";
/**
 * Characterization + regression tests for the extension bundle install
 * pipeline (`installExtension`). These pin the observable behavior of the
 * orchestrated install/rollback flow and the bookkeeping writes so the
 * transaction-wrapping fix can prove it preserved them.
 *
 * Only the public `installExtension` is exercised; every host mutation
 * (docker/compose/filesystem/registry) and the db client are mocked.
 */

import type { services as coreServices } from "@openmapx/core/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDbMock, type DbMock } from "../../test/db.js";

const dbMock: DbMock = createDbMock();

vi.mock("../../db/index.js", () => ({ db: dbMock.db }));

vi.mock("../extension-component-ownership", () => ({
  assertComponentOwnership: vi.fn().mockResolvedValue(undefined),
  ExtensionComponentOwnershipError: class extends Error {},
}));

vi.mock("../extension-store", () => ({
  getKillSwitch: vi.fn().mockResolvedValue({
    removed: new Map(),
    critical: new Map(),
    stale: false,
  }),
}));

vi.mock("../../integration-host", () => ({
  reloadIntegrations: vi.fn().mockResolvedValue({ message: "ok", reloaded: 1, enabled: 1 }),
}));

vi.mock("../../utils/docker-compose", () => ({
  dockerComposeAction: vi.fn().mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" }),
}));

vi.mock("../admin-cli", () => ({
  getServiceSelectionSummary: vi.fn().mockReturnValue({ selectedRoots: [] }),
}));

vi.mock("../trusted-config-operations", () => ({
  applyTrustedConfiguration: vi.fn().mockResolvedValue({ revisionId: "revision_1" }),
}));

vi.mock("../admin-ops", () => ({
  renderAndPersistCompose: vi.fn().mockResolvedValue(undefined),
  serviceStart: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../agent-integrations", () => ({
  adoptIntegration: vi.fn(),
  publishIntegration: vi.fn(),
  readInstalledIntegrations: vi.fn(),
  removeIntegration: vi.fn(),
  settleIntegration: vi.fn(),
}));

const applyEnabledIds = vi.fn();
vi.mock("../service-registry", () => ({
  getServiceRegistry: vi.fn(() => ({
    list: () => [SVC_DEF, SVC_TWO_DEF],
    get: (id: string) => (id === "svc-one" ? SVC_DEF : id === "svc-two" ? SVC_TWO_DEF : undefined),
    applyEnabledIds,
  })),
  initServiceRegistry: vi.fn().mockResolvedValue(undefined),
  communityServiceRepository: vi.fn((id: string) =>
    id === "svc-one" ? REPO_ONE : id === "svc-two" ? REPO_TWO : undefined,
  ),
}));

vi.mock("../community-repositories", () => ({
  inspectServiceRepository: vi.fn(),
  publishServiceRepository: vi.fn(),
  readCommunityServices: vi.fn(),
  settleServiceRepository: vi.fn(),
  removeServiceRepository: vi.fn(),
}));

vi.mock("../extension-recovery", () => ({
  withExtensionChangeLock: vi.fn((work: () => Promise<unknown>) => work()),
  recoverInterruptedExtensionChanges: vi.fn().mockResolvedValue(undefined),
}));

import { reloadIntegrations } from "../../integration-host";
import { dockerComposeAction } from "../../utils/docker-compose";
import { getServiceSelectionSummary } from "../admin-cli";
import { renderAndPersistCompose, serviceStart } from "../admin-ops";
import {
  adoptIntegration,
  publishIntegration,
  readInstalledIntegrations,
  removeIntegration,
  settleIntegration,
} from "../agent-integrations";
import {
  inspectServiceRepository,
  publishServiceRepository,
  readCommunityServices,
  removeServiceRepository,
  settleServiceRepository,
} from "../community-repositories";
import { recoverInterruptedExtensionChanges, withExtensionChangeLock } from "../extension-recovery";
import type { JobContext } from "../job-runner.js";
import { getServiceRegistry, initServiceRegistry } from "../service-registry";
import { applyTrustedConfiguration } from "../trusted-config-operations";

// The SUT is imported dynamically (after the mocks are wired) so the db mock
// factory reads `dbMock.db` only once `dbMock` is initialized — a static import
// hoists above the const and hits the temporal dead zone.
let installExtension: typeof import("../extension-installer.js").installExtension;
let previewExtensionInstall: typeof import("../extension-installer.js").previewExtensionInstall;
let removeExtension: typeof import("../extension-installer.js").removeExtension;
// A cold full-suite run can spend over 10s transforming this API import graph
// under worker saturation. Keep the larger budget local to this setup hook.
beforeAll(async () => {
  ({ installExtension, previewExtensionInstall, removeExtension } = await import(
    "../extension-installer.js"
  ));
}, 30_000);

type ExtensionManifest = coreServices.ExtensionManifest;

// Minimal service registry entry — `expandServiceSelection` (run un-mocked
// inside applySelectionRoots) reads `svc.manifest.id`; the manifest's service
// id must be present or it reports the selection missing and throws.
const SVC_DEF = {
  manifest: { id: "svc-one", container: { digest: `sha256:${"b".repeat(64)}` } },
  isBuiltIn: false,
  enabled: false,
} as never;

const SVC_TWO_DEF = {
  manifest: { id: "svc-two", container: { digest: `sha256:${"c".repeat(64)}` } },
  isBuiltIn: false,
  enabled: false,
} as never;

function makeCtx(): JobContext {
  return {
    jobId: "job-1",
    payload: {},
    signal: new AbortController().signal,
    log: vi.fn().mockResolvedValue(undefined),
    setProgress: vi.fn().mockResolvedValue(undefined),
    checkpoint: vi.fn().mockResolvedValue(undefined),
  };
}

const MANIFEST = {
  id: "bundle-x",
  name: "Bundle X",
  version: "1.2.3",
  services: [{ repo: "https://github.com/example/repo.git", service: "svc-one" }],
  integrations: [
    { artifact: "https://ex.example/intg-one.tar.gz", id: "intg-one", sha256: "a".repeat(64) },
  ],
} satisfies ExtensionManifest;

const TWO_REPO_MANIFEST = {
  ...MANIFEST,
  services: [
    { repo: "https://github.com/example/repo.git", service: "svc-one" },
    { repo: "https://github.com/example/other.git", service: "svc-two" },
  ],
  integrations: [],
} satisfies ExtensionManifest;

const INTEGRATION_ONLY = {
  id: "bundle-x",
  name: "Bundle X",
  version: "1.2.3",
  integrations: [
    { artifact: "https://ex.example/intg-one.tar.gz", id: "intg-one", sha256: "a".repeat(64) },
  ],
} satisfies ExtensionManifest;

const REPO_URL = "https://github.com/example/repo.git";
const REPO_ONE = "1111111111111111";
const REPO_TWO = "2222222222222222";
const COMMIT = "d".repeat(40);

function communityManifest(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: id === "svc-one" ? "Service One" : "Service Two",
    version: "1.0.0",
    quality: "community",
    container: {
      image: `registry.example.test/${id}`,
      tag: "1.0.0",
      digest: `sha256:${"b".repeat(64)}`,
    },
    ...overrides,
  };
}

function inspection(url: string, overrides: Record<string, unknown> = {}) {
  const repository = url === REPO_URL ? REPO_ONE : REPO_TWO;
  return {
    url,
    repository,
    commit: COMMIT,
    valid: true,
    problems: [],
    services: [
      { manifest: communityManifest("svc-one"), path: "svc-one" },
      { manifest: communityManifest("svc-two"), path: "svc-two" },
    ],
    ...overrides,
  };
}

function transactionFor(repository: string): string {
  return `txn1_${repository.slice(0, 1).repeat(24)}`;
}

const RECOVERY = {
  selectionBefore: [],
  touchedServiceIds: ["svc-one"],
  previouslyEnabledServiceIds: [],
};

const publishIntegrationMock = vi.mocked(publishIntegration);
const settleIntegrationMock = vi.mocked(settleIntegration);
const removeIntegrationMock = vi.mocked(removeIntegration);
const adoptIntegrationMock = vi.mocked(adoptIntegration);
const readInstalledMock = vi.mocked(readInstalledIntegrations);
const reloadMock = vi.mocked(reloadIntegrations);
const composeMock = vi.mocked(dockerComposeAction);
const inspectMock = vi.mocked(inspectServiceRepository);
const publishMock = vi.mocked(publishServiceRepository);
const settleMock = vi.mocked(settleServiceRepository);
const removeRepositoryMock = vi.mocked(removeServiceRepository);
const readCommunityMock = vi.mocked(readCommunityServices);
const recoverMock = vi.mocked(recoverInterruptedExtensionChanges);
const lockMock = vi.mocked(withExtensionChangeLock);
const serviceStartMock = vi.mocked(serviceStart);
const renderMock = vi.mocked(renderAndPersistCompose);
const writeSelectionMock = vi.mocked(applyTrustedConfiguration);
const initRegistryMock = vi.mocked(initServiceRegistry);

const INTEGRATION_TRANSACTION = `itx1_${"e".repeat(24)}`;

function installedSnapshot(
  integrations: Array<{ integrationId: string; extensionId: string | null }>,
  unrecorded: string[] = [],
) {
  return {
    integrations: integrations.map((entry) => ({
      ...entry,
      status: "ok" as const,
      reason: null,
      source: null,
      files: [],
      pending: null,
    })),
    unrecorded,
  };
}

afterEach(() => {
  // clearAllMocks resets call history but preserves mockReturnValue /
  // mockResolvedValue implementations (see integration-host.test.ts:135-139).
  vi.clearAllMocks();
  vi.mocked(getKillSwitch).mockResolvedValue({
    removed: new Map(),
    critical: new Map(),
    stale: false,
  });
  // Re-prime implementations cleared history relies on but that must persist.
  reloadMock.mockResolvedValue({ message: "ok", reloaded: 1, enabled: 1 });
  composeMock.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
  inspectMock.mockImplementation(async (url) => inspection(url) as never);
  publishMock.mockImplementation(async (request) => {
    const repository = request.url === REPO_URL ? REPO_ONE : REPO_TWO;
    return {
      repository,
      commit: request.commit,
      transactionId: transactionFor(repository),
      serviceIds: ["svc-one", "svc-two"],
    };
  });
  settleMock.mockImplementation(async (request) => ({
    repository: request.repository,
    outcome: request.outcome,
    changed: true,
  }));
  removeRepositoryMock.mockImplementation(async (request) => ({
    repository: request.repository,
    removed: true,
  }));
  readCommunityMock.mockResolvedValue({
    revisionId: `cfg1_${"d".repeat(43)}`,
    repositories: [],
    services: [],
    problems: ["svc-one was rejected"],
    reportedServiceIds: ["svc-one"],
  } as never);
  publishIntegrationMock.mockImplementation(async (request) => ({
    integrationId: request.integrationId,
    transactionId: INTEGRATION_TRANSACTION,
    manifestSha256: "f".repeat(64),
  }));
  settleIntegrationMock.mockImplementation(async (request) => ({
    integrationId: request.integrationId,
    outcome: request.outcome,
    changed: true,
  }));
  removeIntegrationMock.mockImplementation(async (request) => ({
    integrationId: request.integrationId,
    removed: true,
  }));
  adoptIntegrationMock.mockImplementation(async (request) => ({
    integrationId: request.integrationId,
    status: "needs_reinstall",
    reason: "Nothing records the archive it was installed from.",
  }));
  readInstalledMock.mockResolvedValue(
    installedSnapshot([{ integrationId: "intg-one", extensionId: "bundle-x" }]),
  );
  recoverMock.mockResolvedValue(undefined);
  lockMock.mockImplementation((work) => work());
  vi.mocked(getServiceSelectionSummary).mockReturnValue({ selectedRoots: [] } as never);
});

describe("installExtension", () => {
  it.each([undefined, "0.0", "1.0.0", "2.0", "10.0", "arbitrary-release"])(
    "blocks critical preview and queued execution regardless of maxVersion %s",
    async (maxVersion) => {
      vi.mocked(getKillSwitch).mockResolvedValue({
        removed: new Map(),
        critical: new Map([[MANIFEST.id, { reason: "Synthetic advisory", maxVersion }]]),
        stale: false,
      });
      for (const version of ["0.1", "1.0.0", "2.0", "10.0", "arbitrary-version"]) {
        const opts = { manifest: { ...MANIFEST, version }, sourceTrust: "community" as const };
        await expect(previewExtensionInstall(opts)).rejects.toThrow(/critical/);
        await expect(installExtension(makeCtx(), opts)).rejects.toThrow(/critical/);
      }
      expect(inspectMock).not.toHaveBeenCalled();
      expect(writeSelectionMock).not.toHaveBeenCalled();
      expect(serviceStartMock).not.toHaveBeenCalled();
      expect(publishIntegrationMock).not.toHaveBeenCalled();
    },
  );
  it("rechecks revocation after preview while queued and permits flow once cleared", async () => {
    const opts = { manifest: MANIFEST, sourceTrust: "community" as const };
    await previewExtensionInstall(opts);
    inspectMock.mockClear();
    vi.mocked(getKillSwitch).mockResolvedValue({
      removed: new Map(),
      critical: new Map([[MANIFEST.id, { reason: "Arrived while queued", maxVersion: "0" }]]),
      stale: true,
    });
    await expect(installExtension(makeCtx(), opts)).rejects.toThrow(/critical/);
    expect(inspectMock).not.toHaveBeenCalled();
    expect(publishIntegrationMock).not.toHaveBeenCalled();
    vi.mocked(getKillSwitch).mockResolvedValue({
      removed: new Map(),
      critical: new Map(),
      stale: true,
    });
    await expect(installExtension(makeCtx(), opts)).resolves.toBeDefined();
  });
  it("requires confirmation bound to the exact host-port preview", async () => {
    inspectMock.mockImplementation(
      async (url) =>
        inspection(url, {
          services: [
            {
              manifest: communityManifest("svc-one", {
                exposure: { hostPorts: [{ host: 8080, container: 80 }] },
              }),
              path: "svc-one",
            },
          ],
        }) as never,
    );

    await expect(
      installExtension(makeCtx(), { manifest: MANIFEST, sourceTrust: "community" }),
    ).rejects.toThrow(/fresh security preview and explicit confirmation/);
    expect(publishMock).not.toHaveBeenCalled();

    const preview = await previewExtensionInstall({
      manifest: MANIFEST,
      sourceTrust: "community",
    });
    expect(preview).toMatchObject({
      requiresHostPortConfirmation: true,
      services: [
        {
          id: "svc-one",
          repositoryCommit: COMMIT,
          hostPorts: [{ bindAddress: "127.0.0.1", host: 8080, container: 80 }],
          securityRating: { hostPorts: 1 },
        },
      ],
    });

    await expect(
      installExtension(makeCtx(), {
        manifest: MANIFEST,
        sourceTrust: "community",
        hostPortConfirmation: preview.confirmation,
      }),
    ).resolves.toEqual({ id: "bundle-x", components: 2 });
  });

  it("installs the exact inspected commit with this run's recovery note", async () => {
    await installExtension(makeCtx(), { manifest: MANIFEST, sourceTrust: "community" });

    expect(inspectMock).toHaveBeenCalledTimes(1);
    expect(inspectMock).toHaveBeenCalledWith(
      REPO_URL,
      undefined,
      expect.objectContaining({ operationKey: expect.stringMatching(/^opk1_/) }),
    );
    expect(publishMock).toHaveBeenCalledWith(
      {
        url: REPO_URL,
        commit: COMMIT,
        ref: "HEAD",
        extensionId: "bundle-x",
        recovery: RECOVERY,
      },
      expect.objectContaining({ operationKey: expect.stringMatching(/^opk1_/) }),
    );
    expect(inspectMock.mock.invocationCallOrder[0]).toBeLessThan(
      publishMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("recovers interrupted changes under the extension change lock before installing", async () => {
    await installExtension(makeCtx(), { manifest: MANIFEST, sourceTrust: "community" });

    expect(lockMock).toHaveBeenCalledTimes(1);
    expect(recoverMock.mock.invocationCallOrder[0]).toBeLessThan(
      inspectMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("refuses a repository the agent rejects and installs nothing", async () => {
    inspectMock.mockImplementation(
      async (url) =>
        inspection(url, {
          valid: false,
          problems: [
            "service.json: community_bind_mount_forbidden: bindMounts are not allowed for community services",
          ],
          services: [],
        }) as never,
    );

    await expect(
      installExtension(makeCtx(), { manifest: MANIFEST, sourceTrust: "community" }),
    ).rejects.toThrow("community_bind_mount_forbidden");

    expect(publishMock).not.toHaveBeenCalled();
    expect(settleMock).not.toHaveBeenCalled();
    expect(initRegistryMock).not.toHaveBeenCalled();
    expect(applyEnabledIds).not.toHaveBeenCalled();
    expect(publishIntegrationMock).not.toHaveBeenCalled();
    expect(settleIntegrationMock).not.toHaveBeenCalled();
    expect(renderMock).not.toHaveBeenCalled();
    expect(composeMock).not.toHaveBeenCalled();
    expect(serviceStartMock).not.toHaveBeenCalled();
    expect(reloadMock).not.toHaveBeenCalled();
    expect(dbMock.db.select).not.toHaveBeenCalled();
    expect(dbMock.db.transaction).not.toHaveBeenCalled();
  });

  it("inspects every repository before installing any of them", async () => {
    inspectMock
      .mockImplementationOnce(async (url) => inspection(url) as never)
      .mockImplementationOnce(
        async (url) =>
          inspection(url, {
            valid: false,
            problems: ["community_bind_mount_forbidden"],
            services: [],
          }) as never,
      );

    await expect(
      installExtension(makeCtx(), { manifest: TWO_REPO_MANIFEST, sourceTrust: "community" }),
    ).rejects.toThrow("community_bind_mount_forbidden");

    expect(inspectMock).toHaveBeenCalledTimes(2);
    expect(publishMock).not.toHaveBeenCalled();
  });

  it("happy path installs a service + integration and records all bookkeeping", async () => {
    const result = await installExtension(makeCtx(), {
      manifest: MANIFEST,
      sourceTrust: "community",
    });

    expect(result).toEqual({ id: "bundle-x", components: 2 });

    expect(publishMock).toHaveBeenCalledTimes(1);
    expect(composeMock).toHaveBeenCalledWith("svc-one", "pull", expect.anything());
    expect(serviceStartMock).toHaveBeenCalledWith("svc-one", expect.anything());
    expect(publishIntegrationMock).toHaveBeenCalledTimes(1);
    expect(publishIntegrationMock).toHaveBeenCalledWith(
      {
        integrationId: "intg-one",
        source: {
          kind: "artifact",
          url: "https://ex.example/intg-one.tar.gz",
          sha256: "a".repeat(64),
        },
        extensionId: "bundle-x",
      },
      expect.objectContaining({ operationKey: expect.stringMatching(/^opk1_/) }),
    );
    expect(reloadMock).toHaveBeenCalledTimes(1);

    // Four inserts: serviceRepository, installedIntegration, installedExtension,
    // installedExtensionComponent.
    expect(dbMock.db.insert).toHaveBeenCalledTimes(4);
    expect(dbMock.db.delete).toHaveBeenCalledTimes(1);

    // The component delete happens before the (last) component insert.
    const deleteOrder = dbMock.db.delete.mock.invocationCallOrder[0];
    const lastInsertOrder = Math.max(...dbMock.db.insert.mock.invocationCallOrder);
    expect(deleteOrder).toBeLessThan(lastInsertOrder);

    // All bookkeeping writes run inside the single transaction.
    expect(dbMock.db.transaction).toHaveBeenCalledTimes(1);
    const txOrder = dbMock.db.transaction.mock.invocationCallOrder[0];
    const writeOrders = [
      ...dbMock.db.insert.mock.invocationCallOrder,
      ...dbMock.db.delete.mock.invocationCallOrder,
    ];
    for (const order of writeOrders) expect(order).toBeGreaterThan(txOrder);
  });

  it("canonicalizes every locator before host calls and durable bookkeeping", async () => {
    const manifest = {
      ...MANIFEST,
      services: [
        {
          repo: "https://GitHub.com:443/example/releases/../repo.git",
          service: "svc-one",
        },
      ],
      integrations: [
        {
          ...MANIFEST.integrations[0],
          artifact: "https://EX.example:443/releases/../intg-one.tar.gz",
        },
      ],
    } satisfies ExtensionManifest;
    const sourceUrl = "https://EX.example:443/releases/../extension.json";

    await installExtension(makeCtx(), { manifest, sourceUrl, sourceTrust: "community" });

    expect(inspectMock).toHaveBeenCalledWith(REPO_URL, undefined, expect.anything());
    expect(publishIntegrationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        source: expect.objectContaining({ url: "https://ex.example/intg-one.tar.gz" }),
      }),
      expect.anything(),
    );
    const integrationInsert = dbMock.db.insert.mock.results[1]?.value as {
      values: ReturnType<typeof vi.fn>;
    };
    expect(integrationInsert.values).toHaveBeenCalledWith(
      expect.objectContaining({ repository: "https://ex.example/extension.json" }),
    );
    const extensionInsert = dbMock.db.insert.mock.results[2]?.value as {
      values: ReturnType<typeof vi.fn>;
    };
    expect(extensionInsert.values).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceUrl: "https://ex.example/extension.json",
        manifest: expect.objectContaining({
          services: [expect.objectContaining({ repo: REPO_URL })],
          integrations: [
            expect.objectContaining({ artifact: "https://ex.example/intg-one.tar.gz" }),
          ],
        }),
      }),
    );
  });

  it("does not write repository, artifact, or source locators to job logs", async () => {
    const ctx = makeCtx();
    await installExtension(ctx, {
      manifest: MANIFEST,
      sourceUrl: "https://ex.example/extension.json",
      sourceTrust: "community",
    });

    expect(JSON.stringify(vi.mocked(ctx.log).mock.calls)).not.toContain(REPO_URL);
    expect(JSON.stringify(vi.mocked(ctx.log).mock.calls)).not.toContain(
      MANIFEST.integrations[0].artifact,
    );
    expect(JSON.stringify(vi.mocked(ctx.log).mock.calls)).not.toContain(
      "https://ex.example/extension.json",
    );
  });

  it("records the agent transaction with the repository in the bookkeeping transaction", async () => {
    await installExtension(makeCtx(), { manifest: MANIFEST, sourceTrust: "community" });

    expect(dbMock.db.transaction).toHaveBeenCalledTimes(1);
    const firstInsert = dbMock.db.insert.mock.results[0]?.value as {
      values: ReturnType<typeof vi.fn>;
    };
    expect(firstInsert.values).toHaveBeenCalledWith({
      hash: REPO_ONE,
      url: REPO_URL,
      lastSha: COMMIT,
      pinnedRef: null,
      managedByExtension: "bundle-x",
      lastTransactionId: transactionFor(REPO_ONE),
    });
  });

  it("takes over an earlier release's unverified install of this extension before replacing it", async () => {
    readInstalledMock.mockResolvedValue(installedSnapshot([], ["intg-one"]));
    dbMock.queueSelect([{ managedByExtension: "bundle-x" }]);

    await installExtension(makeCtx(), { manifest: MANIFEST, sourceTrust: "community" });

    expect(adoptIntegrationMock).toHaveBeenCalledWith(
      { integrationId: "intg-one", extensionId: "bundle-x" },
      expect.anything(),
    );
    expect(adoptIntegrationMock.mock.invocationCallOrder[0]).toBeLessThan(
      publishIntegrationMock.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("never takes over an unrecorded integration another owner installed", async () => {
    readInstalledMock.mockResolvedValue(installedSnapshot([], ["intg-one"]));
    dbMock.queueSelect([{ managedByExtension: "another-bundle" }]);

    await installExtension(makeCtx(), { manifest: MANIFEST, sourceTrust: "community" });

    expect(adoptIntegrationMock).not.toHaveBeenCalled();
  });

  it("records the integration's agent transaction on its row in the bookkeeping transaction", async () => {
    await installExtension(makeCtx(), { manifest: INTEGRATION_ONLY, sourceTrust: "community" });

    expect(dbMock.db.transaction).toHaveBeenCalledTimes(1);
    const integrationInsert = dbMock.db.insert.mock.results[0]?.value as {
      values: ReturnType<typeof vi.fn>;
      onConflictDoUpdate: ReturnType<typeof vi.fn>;
    };
    expect(integrationInsert.values).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "intg-one",
        managedByExtension: "bundle-x",
        lastTransactionId: INTEGRATION_TRANSACTION,
      }),
    );
    expect(integrationInsert.onConflictDoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        set: expect.objectContaining({ lastTransactionId: INTEGRATION_TRANSACTION }),
      }),
    );
  });

  it("commits the integration transaction only after the bookkeeping transaction", async () => {
    await installExtension(makeCtx(), { manifest: INTEGRATION_ONLY, sourceTrust: "community" });

    expect(settleIntegrationMock).toHaveBeenCalledTimes(1);
    expect(settleIntegrationMock).toHaveBeenCalledWith(
      { integrationId: "intg-one", transactionId: INTEGRATION_TRANSACTION, outcome: "commit" },
      expect.objectContaining({ operationKey: expect.stringMatching(/^opk1_/) }),
    );
    expect(settleIntegrationMock.mock.invocationCallOrder[0]).toBeGreaterThan(
      dbMock.db.transaction.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(publishIntegrationMock.mock.invocationCallOrder[0]).toBeLessThan(
      reloadMock.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("keeps a committed integration install when the agent cannot settle it yet", async () => {
    settleIntegrationMock.mockRejectedValueOnce(new Error("agent unavailable"));
    const ctx = makeCtx();

    await expect(
      installExtension(ctx, { manifest: INTEGRATION_ONLY, sourceTrust: "community" }),
    ).resolves.toEqual({ id: "bundle-x", components: 1 });

    // Recovery commits the pending transaction the row records.
    expect(settleIntegrationMock).toHaveBeenCalledTimes(1);
    expect(settleIntegrationMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "rollback" }),
      expect.anything(),
    );
    expect(ctx.log).toHaveBeenCalledWith(
      expect.stringContaining("could not settle integration intg-one"),
      "stderr",
    );
  });

  it("scrubs provider details from cleanup diagnostics", async () => {
    const secret =
      "https://sentinel-user:sentinel-password@example.test/private?token=sentinel-query";
    settleIntegrationMock.mockRejectedValueOnce(new Error(secret));
    const ctx = makeCtx();

    await installExtension(ctx, { manifest: INTEGRATION_ONLY, sourceTrust: "community" });

    expect(JSON.stringify(vi.mocked(ctx.log).mock.calls)).not.toMatch(
      /sentinel-|example\.test|\/private/,
    );
  });

  it("commits each repository transaction only after the bookkeeping transaction", async () => {
    await installExtension(makeCtx(), { manifest: TWO_REPO_MANIFEST, sourceTrust: "community" });

    expect(settleMock).toHaveBeenCalledTimes(2);
    expect(settleMock).toHaveBeenNthCalledWith(
      1,
      { repository: REPO_ONE, transactionId: transactionFor(REPO_ONE), outcome: "commit" },
      expect.anything(),
    );
    expect(settleMock).toHaveBeenNthCalledWith(
      2,
      { repository: REPO_TWO, transactionId: transactionFor(REPO_TWO), outcome: "commit" },
      expect.anything(),
    );
    const txOrder = dbMock.db.transaction.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY;
    for (const order of settleMock.mock.invocationCallOrder) {
      expect(order).toBeGreaterThan(txOrder);
    }
  });

  it("keeps a committed install when the agent cannot settle it yet", async () => {
    settleMock.mockRejectedValueOnce(new Error("agent unavailable"));

    await expect(
      installExtension(makeCtx(), { manifest: TWO_REPO_MANIFEST, sourceTrust: "community" }),
    ).resolves.toEqual({ id: "bundle-x", components: 2 });

    // Recovery commits a pending transaction the database records.
    expect(settleMock).toHaveBeenCalledTimes(2);
    expect(settleMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "rollback" }),
      expect.anything(),
    );
    expect(composeMock).not.toHaveBeenCalledWith("svc-one", "remove", expect.anything());
  });

  it("does not roll back a committed install when final progress reporting fails", async () => {
    const ctx = makeCtx();
    vi.mocked(ctx.setProgress).mockImplementation(async (progress) => {
      if (progress === 100) throw new Error("job store unavailable");
    });

    await expect(
      installExtension(ctx, { manifest: INTEGRATION_ONLY, sourceTrust: "community" }),
    ).resolves.toEqual({ id: "bundle-x", components: 1 });

    expect(dbMock.db.transaction).toHaveBeenCalledTimes(1);
    expect(settleIntegrationMock.mock.calls.map(([request]) => request.outcome)).toEqual([
      "commit",
    ]);
    expect(settleMock).not.toHaveBeenCalled();
  });

  it("makes the new service part of the operator's selection through one apply, init once", async () => {
    await installExtension(makeCtx(), { manifest: MANIFEST, sourceTrust: "community" });

    // The apply writes the selection file and moves the registry to what it applied.
    expect(writeSelectionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "serviceSelection.apply",
        selectedRoots: ["svc-one"],
      }),
    );
    expect(initRegistryMock).toHaveBeenCalledTimes(1);
  });

  it("refuses a service the agent did not install from its declared repository", async () => {
    publishMock.mockImplementationOnce(async (request) => ({
      repository: REPO_ONE,
      commit: request.commit,
      transactionId: transactionFor(REPO_ONE),
      serviceIds: ["svc-two"],
    }));

    await expect(
      installExtension(makeCtx(), { manifest: MANIFEST, sourceTrust: "community" }),
    ).rejects.toThrow(/was not installed from its declared repository/);

    expect(writeSelectionMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ selectedRoots: ["svc-one"] }),
    );
    expect(composeMock).not.toHaveBeenCalled();
    expect(settleMock).toHaveBeenCalledWith(
      { repository: REPO_ONE, transactionId: transactionFor(REPO_ONE), outcome: "rollback" },
      expect.anything(),
    );
    expect(dbMock.db.transaction).not.toHaveBeenCalled();
  });

  it.each(["unknown", "committed"] as const)(
    "leaves the transaction pending for recovery after a %s configuration failure",
    async (outcome) => {
      const error = new TrustedConfigurationApplyError(
        outcome === "unknown"
          ? {
              outcome,
              reason: "transport_or_result",
              publisherCleanupFailed: false,
              registryUpdateFailed: false,
            }
          : {
              outcome,
              revisionId: `cfg1_${"a".repeat(43)}`,
              enabledServiceIds: ["svc-one"],
              followUp: "failed",
              cleanupFailed: false,
              publisherCleanupFailed: false,
              registryUpdateFailed: false,
            },
      );
      writeSelectionMock.mockRejectedValueOnce(error);
      await expect(
        installExtension(makeCtx(), { manifest: MANIFEST, sourceTrust: "community" }),
      ).rejects.toBe(error);
      expect(settleMock).not.toHaveBeenCalled();
      expect(renderMock).not.toHaveBeenCalled();
      expect(dbMock.db.transaction).not.toHaveBeenCalled();
    },
  );

  it("rolls back via the ledger when serviceStart fails, writing no extension rows", async () => {
    serviceStartMock.mockRejectedValueOnce(new Error("boom"));

    await expect(
      installExtension(makeCtx(), { manifest: MANIFEST, sourceTrust: "community" }),
    ).rejects.toThrow(/boom/);

    // Rollback removed the freshly-added runtime, then had the agent undo the
    // repository change, then restored the selection and re-rendered compose.
    expect(composeMock).toHaveBeenCalledWith("svc-one", "remove", expect.anything());
    expect(settleMock).toHaveBeenCalledWith(
      { repository: REPO_ONE, transactionId: transactionFor(REPO_ONE), outcome: "rollback" },
      expect.anything(),
    );
    const removeOrder = composeMock.mock.invocationCallOrder.at(-1) ?? 0;
    expect(settleMock.mock.invocationCallOrder[0]).toBeGreaterThan(removeOrder);
    expect(renderMock).toHaveBeenCalled();
    // No integration was installed this run, and no bookkeeping was written.
    expect(publishIntegrationMock).not.toHaveBeenCalled();
    expect(settleIntegrationMock).not.toHaveBeenCalled();
    expect(dbMock.db.insert).not.toHaveBeenCalled();
    expect(reloadMock).not.toHaveBeenCalled();
  });

  it("still rolls back and preserves the install error when rollback logging fails", async () => {
    serviceStartMock.mockRejectedValueOnce(new Error("start failed"));
    const ctx = makeCtx();
    vi.mocked(ctx.log).mockImplementation(async (message) => {
      if (message.startsWith("Install failed") || message.startsWith("Rollback:")) {
        throw new Error("job log unavailable");
      }
    });

    await expect(
      installExtension(ctx, { manifest: MANIFEST, sourceTrust: "community" }),
    ).rejects.toThrow("start failed");

    expect(settleMock).toHaveBeenCalledWith(
      expect.objectContaining({ repository: REPO_ONE, outcome: "rollback" }),
      expect.anything(),
    );
    expect(renderMock).toHaveBeenCalled();
  });

  it("continues the rollback when the agent cannot undo a repository yet", async () => {
    serviceStartMock.mockRejectedValueOnce(new Error("start failed"));
    settleMock.mockRejectedValueOnce(new Error("agent unavailable"));

    await expect(
      installExtension(makeCtx(), { manifest: MANIFEST, sourceTrust: "community" }),
    ).rejects.toThrow("start failed");

    expect(settleMock).toHaveBeenCalledTimes(1);
    expect(writeSelectionMock).toHaveBeenCalledTimes(2);
    expect(renderMock).toHaveBeenCalledTimes(2);
  });

  it("rolls back repositories newest first", async () => {
    serviceStartMock
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("start failed"));

    await expect(
      installExtension(makeCtx(), { manifest: TWO_REPO_MANIFEST, sourceTrust: "community" }),
    ).rejects.toThrow("start failed");

    // Checkouts are restored newest first, then the selection, and only then
    // are the agent's recovery notes released.
    expect(settleMock.mock.calls.map(([request]) => request)).toEqual([
      { repository: REPO_TWO, transactionId: transactionFor(REPO_TWO), outcome: "rollback" },
      { repository: REPO_ONE, transactionId: transactionFor(REPO_ONE), outcome: "rollback" },
      { repository: REPO_TWO, transactionId: transactionFor(REPO_TWO), outcome: "release" },
      { repository: REPO_ONE, transactionId: transactionFor(REPO_ONE), outcome: "release" },
    ]);
    const restoreOrder = writeSelectionMock.mock.invocationCallOrder.at(-1) ?? 0;
    expect(settleMock.mock.invocationCallOrder[1]).toBeLessThan(restoreOrder);
    expect(settleMock.mock.invocationCallOrder[2]).toBeGreaterThan(restoreOrder);
  });

  it("keeps the recovery notes when restoring the selection fails", async () => {
    serviceStartMock.mockRejectedValueOnce(new Error("start failed"));
    writeSelectionMock
      .mockResolvedValueOnce({ revisionId: "revision_1" } as never)
      .mockRejectedValueOnce(new Error("selection unavailable"));

    await expect(
      installExtension(makeCtx(), { manifest: MANIFEST, sourceTrust: "community" }),
    ).rejects.toThrow("start failed");

    expect(settleMock.mock.calls.map(([request]) => request.outcome)).toEqual(["rollback"]);
  });

  it("leaves every repository transaction pending when failed-install runtime removal fails", async () => {
    serviceStartMock
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("start failed"));
    composeMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "" });

    await expect(
      installExtension(makeCtx(), { manifest: TWO_REPO_MANIFEST, sourceTrust: "community" }),
    ).rejects.toThrow("start failed");

    expect(composeMock).toHaveBeenCalledWith("svc-one", "remove", expect.anything());
    expect(composeMock).toHaveBeenCalledWith("svc-two", "remove", expect.anything());
    // Recovery repairs the runtimes, restores the selection, then rolls back.
    expect(settleMock).not.toHaveBeenCalled();
    expect(writeSelectionMock).toHaveBeenCalledTimes(1);
    expect(renderMock).toHaveBeenCalledTimes(1);
  });

  it("fails closed on a service image pull failure and records no requested version", async () => {
    composeMock.mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "" });

    await expect(
      installExtension(makeCtx(), { manifest: MANIFEST, sourceTrust: "community" }),
    ).rejects.toThrow(/Failed to pull community service image svc-one/i);

    expect(serviceStartMock).not.toHaveBeenCalled();
    expect(settleMock).toHaveBeenCalledWith(
      expect.objectContaining({ repository: REPO_ONE, outcome: "rollback" }),
      expect.anything(),
    );
    expect(dbMock.db.transaction).not.toHaveBeenCalled();
  });

  it("rejects an extension service whose image is not pinned by digest", async () => {
    vi.mocked(getServiceRegistry)
      .mockReturnValueOnce({
        list: () => [SVC_DEF],
        get: () => SVC_DEF,
        applyEnabledIds,
      } as never)
      .mockReturnValueOnce({
        list: () => [SVC_DEF],
        get: () => ({
          manifest: { id: "svc-one", container: {} },
          isBuiltIn: false,
          enabled: false,
        }),
        applyEnabledIds,
      } as never);

    await expect(
      installExtension(makeCtx(), { manifest: MANIFEST, sourceTrust: "community" }),
    ).rejects.toThrow(/must pin.*digest/i);

    expect(composeMock).not.toHaveBeenCalledWith("svc-one", "pull", expect.anything());
    expect(settleMock).toHaveBeenCalledWith(
      expect.objectContaining({ repository: REPO_ONE, outcome: "rollback" }),
      expect.anything(),
    );
    expect(dbMock.db.transaction).not.toHaveBeenCalled();
  });

  it("rolls back the installed integration when the reload fails", async () => {
    reloadMock.mockRejectedValueOnce(new Error("reload-fail"));

    await expect(
      installExtension(makeCtx(), { manifest: INTEGRATION_ONLY, sourceTrust: "community" }),
    ).rejects.toThrow(/reload-fail/);

    // The agent restores the previous copy, or removes a fresh install.
    expect(settleIntegrationMock.mock.calls.map(([request]) => request)).toEqual([
      { integrationId: "intg-one", transactionId: INTEGRATION_TRANSACTION, outcome: "rollback" },
    ]);
    // Pipeline reload (threw) + rollback reload.
    expect(reloadMock).toHaveBeenCalledTimes(2);
    expect(reloadMock.mock.invocationCallOrder[1]).toBeGreaterThan(
      settleIntegrationMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    // The reload threw before the bookkeeping transaction, so no rows to leak.
    expect(dbMock.db.transaction).not.toHaveBeenCalled();
    expect(dbMock.db.insert).not.toHaveBeenCalled();
  });

  it("rolls back an integration the agent reports under a different id", async () => {
    publishIntegrationMock.mockResolvedValueOnce({
      integrationId: "intg-other",
      transactionId: INTEGRATION_TRANSACTION,
      manifestSha256: "f".repeat(64),
    });

    await expect(
      installExtension(makeCtx(), { manifest: INTEGRATION_ONLY, sourceTrust: "community" }),
    ).rejects.toThrow(/installed "intg-other" but the manifest declared "intg-one"/);

    expect(settleIntegrationMock).toHaveBeenCalledWith(
      { integrationId: "intg-one", transactionId: INTEGRATION_TRANSACTION, outcome: "rollback" },
      expect.anything(),
    );
    expect(dbMock.db.transaction).not.toHaveBeenCalled();
  });

  it("rolls back integrations newest first, before the services", async () => {
    const manifest = {
      ...MANIFEST,
      integrations: [
        ...MANIFEST.integrations,
        { artifact: "https://ex.example/intg-two.tar.gz", id: "intg-two", sha256: "b".repeat(64) },
      ],
    } satisfies ExtensionManifest;
    publishIntegrationMock.mockImplementation(async (request) => ({
      integrationId: request.integrationId,
      transactionId: `itx1_${(request.integrationId === "intg-one" ? "1" : "2").repeat(24)}`,
      manifestSha256: "f".repeat(64),
    }));
    reloadMock.mockRejectedValueOnce(new Error("reload-fail"));

    await expect(
      installExtension(makeCtx(), { manifest, sourceTrust: "community" }),
    ).rejects.toThrow(/reload-fail/);

    expect(settleIntegrationMock.mock.calls.map(([request]) => request.integrationId)).toEqual([
      "intg-two",
      "intg-one",
    ]);
    expect(settleIntegrationMock.mock.invocationCallOrder.at(-1)).toBeLessThan(
      settleMock.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("keeps rolling back when the agent cannot undo an integration yet", async () => {
    reloadMock.mockRejectedValueOnce(new Error("reload-fail"));
    settleIntegrationMock.mockRejectedValueOnce(new Error("agent unavailable"));

    await expect(
      installExtension(makeCtx(), { manifest: MANIFEST, sourceTrust: "community" }),
    ).rejects.toThrow(/reload-fail/);

    // Recovery rolls the integration back later; the services are still undone.
    expect(settleMock).toHaveBeenCalledWith(
      expect.objectContaining({ repository: REPO_ONE, outcome: "rollback" }),
      expect.anything(),
    );
  });

  it("update/re-install re-writes the component links (delete + insert)", async () => {
    const result = await installExtension(makeCtx(), {
      manifest: INTEGRATION_ONLY,
      sourceTrust: "community",
    });

    expect(result).toEqual({ id: "bundle-x", components: 1 });
    expect(dbMock.db.delete).toHaveBeenCalledTimes(1);

    // Inserts: [0]=installedIntegration, [1]=installedExtension, [2]=component.
    const componentInsertChain = dbMock.db.insert.mock.results[2].value as {
      values: ReturnType<typeof vi.fn>;
    };
    expect(componentInsertChain.values).toHaveBeenCalledWith([
      { extensionId: "bundle-x", kind: "integration", componentId: "intg-one" },
    ]);
  });

  it("rejects on a platform version gate before touching any host or db state", async () => {
    const manifest = { ...INTEGRATION_ONLY, platform: "9999.0" } satisfies ExtensionManifest;

    await expect(
      installExtension(makeCtx(), { manifest, sourceTrust: "community" }),
    ).rejects.toThrow(/requires platform/);

    expect(inspectMock).not.toHaveBeenCalled();
    expect(publishMock).not.toHaveBeenCalled();
    expect(publishIntegrationMock).not.toHaveBeenCalled();
    expect(dbMock.db.insert).not.toHaveBeenCalled();
  });
});

describe("removeExtension", () => {
  it("has the agent remove the extension's repositories before deleting its records", async () => {
    dbMock.queueSelect([{ id: "bundle-x" }]);
    dbMock.queueSelect([{ extensionId: "bundle-x", kind: "service", componentId: "svc-one" }]);
    dbMock.queueSelect([{ hash: REPO_ONE, url: REPO_URL }]);

    await expect(removeExtension(makeCtx(), "bundle-x")).resolves.toEqual({
      id: "bundle-x",
      removed: 1,
    });

    expect(lockMock).toHaveBeenCalledTimes(1);
    expect(recoverMock).toHaveBeenCalledTimes(1);
    expect(composeMock).toHaveBeenCalledWith("svc-one", "remove", expect.anything());
    expect(writeSelectionMock).toHaveBeenCalledTimes(1);
    expect(removeRepositoryMock).toHaveBeenCalledWith(
      { repository: REPO_ONE, extensionId: "bundle-x" },
      expect.objectContaining({ operationKey: expect.stringMatching(/^opk1_/) }),
    );
    // The repository row, then the extension record.
    expect(dbMock.db.delete).toHaveBeenCalledTimes(2);
    expect(removeRepositoryMock.mock.invocationCallOrder[0]).toBeLessThan(
      dbMock.db.delete.mock.invocationCallOrder[0] ?? 0,
    );
    expect(renderMock).toHaveBeenCalledTimes(1);
  });

  it("does not repeat a legacy repository locator while removing it", async () => {
    const legacy =
      "https://sentinel-user:sentinel-password@example.test/private?token=sentinel-query";
    dbMock.queueSelect([{ id: "bundle-x" }]);
    dbMock.queueSelect([{ extensionId: "bundle-x", kind: "service", componentId: "svc-one" }]);
    dbMock.queueSelect([{ hash: REPO_ONE, url: legacy }]);
    const ctx = makeCtx();

    await removeExtension(ctx, "bundle-x");

    expect(JSON.stringify(vi.mocked(ctx.log).mock.calls)).not.toMatch(
      /sentinel-|example\.test|\/private/,
    );
  });

  it("keeps the extension record when the agent cannot remove its repository", async () => {
    dbMock.queueSelect([{ id: "bundle-x" }]);
    dbMock.queueSelect([{ extensionId: "bundle-x", kind: "service", componentId: "svc-one" }]);
    dbMock.queueSelect([{ hash: REPO_ONE, url: REPO_URL }]);
    removeRepositoryMock.mockRejectedValueOnce(new Error("busy"));

    await expect(removeExtension(makeCtx(), "bundle-x")).rejects.toThrow("busy");

    expect(dbMock.db.delete).not.toHaveBeenCalled();
    expect(renderMock).not.toHaveBeenCalled();
  });

  it("retries a removal whose repository the agent already deleted", async () => {
    dbMock.queueSelect([{ id: "bundle-x" }]);
    dbMock.queueSelect([{ extensionId: "bundle-x", kind: "service", componentId: "svc-one" }]);
    dbMock.queueSelect([{ hash: REPO_ONE, url: REPO_URL }]);
    readCommunityMock.mockResolvedValueOnce({
      revisionId: `cfg1_${"d".repeat(43)}`,
      repositories: [],
      services: [],
      problems: [],
      reportedServiceIds: [],
    } as never);
    removeRepositoryMock.mockResolvedValueOnce({ repository: REPO_ONE, removed: false });

    await expect(removeExtension(makeCtx(), "bundle-x")).resolves.toMatchObject({
      id: "bundle-x",
    });

    expect(composeMock).not.toHaveBeenCalled();
    expect(dbMock.db.delete).toHaveBeenCalledTimes(2);
  });

  it("has the agent remove the extension's integrations before deleting its records", async () => {
    dbMock.queueSelect([{ id: "bundle-x" }]);
    dbMock.queueSelect([{ extensionId: "bundle-x", kind: "integration", componentId: "intg-one" }]);

    await expect(removeExtension(makeCtx(), "bundle-x")).resolves.toEqual({
      id: "bundle-x",
      removed: 1,
    });

    expect(removeIntegrationMock).toHaveBeenCalledWith(
      { integrationId: "intg-one", extensionId: "bundle-x" },
      expect.objectContaining({ operationKey: expect.stringMatching(/^opk1_/) }),
    );
    expect(adoptIntegrationMock).not.toHaveBeenCalled();
    // The integration row, then the extension record.
    expect(dbMock.db.delete).toHaveBeenCalledTimes(2);
    expect(removeIntegrationMock.mock.invocationCallOrder[0]).toBeLessThan(
      dbMock.db.delete.mock.invocationCallOrder[0] ?? 0,
    );
    expect(reloadMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the extension record when the agent cannot remove its integration", async () => {
    dbMock.queueSelect([{ id: "bundle-x" }]);
    dbMock.queueSelect([{ extensionId: "bundle-x", kind: "integration", componentId: "intg-one" }]);
    removeIntegrationMock.mockRejectedValueOnce(new Error("busy"));

    await expect(removeExtension(makeCtx(), "bundle-x")).rejects.toThrow("busy");

    expect(dbMock.db.delete).not.toHaveBeenCalled();
  });

  it("records an integration an earlier release installed before removing it", async () => {
    dbMock.queueSelect([{ id: "bundle-x" }]);
    dbMock.queueSelect([{ extensionId: "bundle-x", kind: "integration", componentId: "intg-one" }]);
    readInstalledMock.mockResolvedValueOnce(installedSnapshot([], ["intg-one"]));

    await removeExtension(makeCtx(), "bundle-x");

    expect(adoptIntegrationMock).toHaveBeenCalledWith(
      { integrationId: "intg-one", extensionId: "bundle-x" },
      expect.anything(),
    );
    expect(removeIntegrationMock).toHaveBeenCalledWith(
      { integrationId: "intg-one", extensionId: "bundle-x" },
      expect.anything(),
    );
    expect(adoptIntegrationMock.mock.invocationCallOrder[0]).toBeLessThan(
      removeIntegrationMock.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("leaves an integration someone else now installs in place", async () => {
    dbMock.queueSelect([{ id: "bundle-x" }]);
    dbMock.queueSelect([{ extensionId: "bundle-x", kind: "integration", componentId: "intg-one" }]);
    readInstalledMock.mockResolvedValueOnce(
      installedSnapshot([{ integrationId: "intg-one", extensionId: null }]),
    );

    await expect(removeExtension(makeCtx(), "bundle-x")).resolves.toMatchObject({
      id: "bundle-x",
    });

    expect(removeIntegrationMock).not.toHaveBeenCalled();
    expect(dbMock.db.delete).toHaveBeenCalledTimes(2);
  });

  it("retains selection and repository ownership when community runtime removal fails", async () => {
    dbMock.queueSelect([{ id: "bundle-x" }]);
    dbMock.queueSelect([{ extensionId: "bundle-x", kind: "service", componentId: "svc-one" }]);
    composeMock.mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "" });

    await expect(removeExtension(makeCtx(), "bundle-x")).rejects.toThrow(
      "Failed to remove community service runtime svc-one",
    );

    expect(composeMock).toHaveBeenCalledWith("svc-one", "remove", expect.anything());
    expect(writeSelectionMock).not.toHaveBeenCalled();
    expect(removeRepositoryMock).not.toHaveBeenCalled();
    expect(renderMock).not.toHaveBeenCalled();
    expect(dbMock.db.delete).not.toHaveBeenCalled();
  });
});
