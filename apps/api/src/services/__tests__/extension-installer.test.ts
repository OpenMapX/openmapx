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

vi.mock("@openmapx/integration-framework/installer", () => ({
  backupInstalledIntegration: vi.fn(() => ({
    id: "intg-one",
    backupDirectory: "/safe/mock-integration-backup",
  })),
  discardInstalledIntegrationBackup: vi.fn(),
  installIntegration: vi.fn(async (opts: { source: string }) => ({
    // The installer asserts the artifact reports the declared component id.
    id: /intg-[a-z0-9-]+/.exec(opts.source)?.[0] ?? "intg-one",
    directory: "/safe/mock-integration",
    replaced: false,
  })),
  removeIntegration: vi.fn(),
  restoreInstalledIntegration: vi.fn(),
}));

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

vi.mock("../extension-install-journal", () => ({
  createExtensionInstallJournal: vi.fn((_root, extensionId, targetManifest) => ({
    path: "/safe/mock-extension-journal.json",
    data: { schemaVersion: 1, extensionId, targetManifest, integrations: [] },
  })),
  appendIntegrationJournalEntry: vi.fn(),
  markIntegrationJournalEntryInstalled: vi.fn(),
  markExtensionInstallJournalRestoring: vi.fn(),
  reconcileExtensionInstallJournal: vi.fn().mockResolvedValue(undefined),
}));

const applyEnabledIds = vi.fn();
vi.mock("../service-registry", () => ({
  getServiceRegistry: vi.fn(() => ({
    list: () => [SVC_DEF, SVC_TWO_DEF],
    get: (id: string) => (id === "svc-one" ? SVC_DEF : id === "svc-two" ? SVC_TWO_DEF : undefined),
    applyEnabledIds,
  })),
  initServiceRegistry: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../service-repositories", () => ({
  backupRepo: vi.fn((snapshot, options) => ({
    snapshot,
    backupDir: "/safe/mock-backup",
    selectionBefore: options?.selectionBefore,
  })),
  discardRepoBackup: vi.fn(),
  discardRepoPreparation: vi.fn(),
  hashUrl: vi.fn((u: string) => `hash-${u}`),
  stageRepo: vi.fn().mockResolvedValue({ id: "staged-service-repository" }),
  publishStagedRepo: vi.fn().mockResolvedValue({
    hash: "h1",
    url: "https://git.example/repo.git",
    displayName: "Bundle X",
    lastFetchedAt: new Date("2026-08-02T00:00:00Z"),
    lastSha: "d".repeat(40),
    pinnedRef: null,
    managedByExtension: "bundle-x",
    preparationJournal: "/safe/mock-preparation.json",
  }),
  discardStagedRepo: vi.fn(),
  registerRepo: vi.fn().mockResolvedValue({ hash: "h1" }),
  removeRepo: vi.fn().mockResolvedValue(undefined),
  restoreRepo: vi.fn().mockResolvedValue(undefined),
}));

import {
  backupInstalledIntegration,
  discardInstalledIntegrationBackup,
  installIntegration,
  removeIntegration,
  restoreInstalledIntegration,
} from "@openmapx/integration-framework/installer";
import { reloadIntegrations } from "../../integration-host";
import { dockerComposeAction } from "../../utils/docker-compose";
import { getServiceSelectionSummary } from "../admin-cli";
import { renderAndPersistCompose, serviceStart } from "../admin-ops";
import {
  createExtensionInstallJournal,
  markExtensionInstallJournalRestoring,
  reconcileExtensionInstallJournal,
} from "../extension-install-journal";
import type { JobContext } from "../job-runner.js";
import { getServiceRegistry, initServiceRegistry } from "../service-registry";
import {
  backupRepo,
  discardRepoBackup,
  discardRepoPreparation,
  discardStagedRepo,
  publishStagedRepo,
  registerRepo,
  removeRepo,
  restoreRepo,
  stageRepo,
} from "../service-repositories";
import { applyTrustedConfiguration } from "../trusted-config-operations";

// The SUT is imported dynamically (after the mocks are wired) so the db mock
// factory reads `dbMock.db` only once `dbMock` is initialized — a static import
// hoists above the const and hits the temporal dead zone.
let installExtension: typeof import("../extension-installer.js").installExtension;
let removeExtension: typeof import("../extension-installer.js").removeExtension;
// A cold full-suite run can spend over 10s transforming this API import graph
// under worker saturation. Keep the larger budget local to this setup hook.
beforeAll(async () => {
  ({ installExtension, removeExtension } = await import("../extension-installer.js"));
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
  services: [{ repo: "https://git.example/repo.git", service: "svc-one" }],
  integrations: [
    { artifact: "https://ex.example/intg-one.tar.gz", id: "intg-one", sha256: "a".repeat(64) },
  ],
} satisfies ExtensionManifest;

const TWO_REPO_MANIFEST = {
  ...MANIFEST,
  services: [
    { repo: "https://git.example/repo.git", service: "svc-one" },
    { repo: "https://git.example/other.git", service: "svc-two" },
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

const dbInstallMock = vi.mocked(installIntegration);
const dbRemoveMock = vi.mocked(removeIntegration);
const integrationBackupMock = vi.mocked(backupInstalledIntegration);
const integrationBackupDiscardMock = vi.mocked(discardInstalledIntegrationBackup);
const integrationRestoreMock = vi.mocked(restoreInstalledIntegration);
const reloadMock = vi.mocked(reloadIntegrations);
const composeMock = vi.mocked(dockerComposeAction);
const registerRepoMock = vi.mocked(registerRepo);
const stageRepoMock = vi.mocked(stageRepo);
const publishStagedRepoMock = vi.mocked(publishStagedRepo);
const discardStagedRepoMock = vi.mocked(discardStagedRepo);
const removeRepoMock = vi.mocked(removeRepo);
const restoreRepoMock = vi.mocked(restoreRepo);
const backupRepoMock = vi.mocked(backupRepo);
const discardRepoBackupMock = vi.mocked(discardRepoBackup);
const discardRepoPreparationMock = vi.mocked(discardRepoPreparation);
const serviceStartMock = vi.mocked(serviceStart);
const renderMock = vi.mocked(renderAndPersistCompose);
const writeSelectionMock = vi.mocked(applyTrustedConfiguration);
const initRegistryMock = vi.mocked(initServiceRegistry);
const createInstallJournalMock = vi.mocked(createExtensionInstallJournal);
const markInstallJournalRestoringMock = vi.mocked(markExtensionInstallJournalRestoring);
const reconcileInstallJournalMock = vi.mocked(reconcileExtensionInstallJournal);

afterEach(() => {
  // clearAllMocks resets call history but preserves mockReturnValue /
  // mockResolvedValue implementations (see integration-host.test.ts:135-139).
  vi.clearAllMocks();
  // Re-prime implementations cleared history relies on but that must persist.
  reloadMock.mockResolvedValue({ message: "ok", reloaded: 1, enabled: 1 });
  composeMock.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
  registerRepoMock.mockResolvedValue({ hash: "h1" } as never);
  stageRepoMock.mockResolvedValue({ id: "staged-service-repository" } as never);
  publishStagedRepoMock.mockResolvedValue({
    hash: "h1",
    url: "https://git.example/repo.git",
    displayName: "Bundle X",
    lastFetchedAt: new Date("2026-08-02T00:00:00Z"),
    lastSha: "d".repeat(40),
    pinnedRef: null,
    managedByExtension: "bundle-x",
    preparationJournal: "/safe/mock-preparation.json",
  } as never);
  vi.mocked(getServiceSelectionSummary).mockReturnValue({ selectedRoots: [] } as never);
});

describe("installExtension", () => {
  it("publishes an existing-repository update from its exact validated stage", async () => {
    const previous = {
      hash: "hash-https://git.example/repo.git",
      url: "https://git.example/repo.git",
      displayName: "Bundle X old",
      lastFetchedAt: new Date("2026-08-01T00:00:00Z"),
      lastSha: "c".repeat(40),
      autoUpdate: false,
      pinnedRef: "v1.0.0",
      managedByExtension: "bundle-x",
      createdAt: new Date("2026-08-01T00:00:00Z"),
    };
    const staged = { id: "exact-validated-stage" } as never;
    dbMock.queueSelect([previous]);
    dbMock.queueSelect([]);
    stageRepoMock.mockResolvedValueOnce(staged);

    await installExtension(makeCtx(), { manifest: MANIFEST, sourceTrust: "community" });

    expect(stageRepoMock).toHaveBeenCalledTimes(1);
    expect(publishStagedRepoMock).toHaveBeenCalledWith(staged);
    expect(backupRepoMock.mock.invocationCallOrder[0]).toBeLessThan(
      publishStagedRepoMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("does not back up an existing repository when staging rejects its bind policy", async () => {
    const previous = {
      hash: "hash-https://git.example/repo.git",
      url: "https://git.example/repo.git",
      displayName: "Bundle X old",
      lastFetchedAt: new Date("2026-08-01T00:00:00Z"),
      lastSha: "c".repeat(40),
      autoUpdate: false,
      pinnedRef: "v1.0.0",
      managedByExtension: "bundle-x",
      createdAt: new Date("2026-08-01T00:00:00Z"),
    };
    dbMock.queueSelect([previous]);
    stageRepoMock.mockRejectedValueOnce(
      new Error(
        "community_bind_mount_forbidden: bindMounts are not allowed for community services",
      ),
    );

    await expect(
      installExtension(makeCtx(), { manifest: MANIFEST, sourceTrust: "community" }),
    ).rejects.toThrow("community_bind_mount_forbidden");

    expect(backupRepoMock).not.toHaveBeenCalled();
    expect(publishStagedRepoMock).not.toHaveBeenCalled();
  });

  it("cleans earlier stages when a later repository fails before publication", async () => {
    const firstStage = { id: "first-validated-stage" } as never;
    dbMock.queueSelect([]);
    dbMock.queueSelect([]);
    stageRepoMock
      .mockResolvedValueOnce(firstStage)
      .mockRejectedValueOnce(new Error("community_bind_mount_forbidden"));

    await expect(
      installExtension(makeCtx(), { manifest: TWO_REPO_MANIFEST, sourceTrust: "community" }),
    ).rejects.toThrow("community_bind_mount_forbidden");

    expect(discardStagedRepoMock).toHaveBeenCalledWith(firstStage);
    expect(backupRepoMock).not.toHaveBeenCalled();
    expect(publishStagedRepoMock).not.toHaveBeenCalled();
  });

  it("happy path installs a service + integration and records all bookkeeping", async () => {
    dbMock.queueSelect([]); // service repo not registered
    dbMock.queueSelect([]); // integration not installed

    const result = await installExtension(makeCtx(), {
      manifest: MANIFEST,
      sourceTrust: "community",
    });

    expect(result).toEqual({ id: "bundle-x", components: 2 });

    expect(stageRepoMock).toHaveBeenCalledWith("https://git.example/repo.git", {
      ref: undefined,
      managedByExtension: "bundle-x",
      journalNewInstall: true,
      selectionBefore: [],
      minimumLastFetchedAtExclusive: undefined,
      touchedServiceIds: ["svc-one"],
      previouslyEnabledServiceIds: [],
    });
    expect(publishStagedRepoMock).toHaveBeenCalledWith({ id: "staged-service-repository" });
    expect(registerRepoMock).not.toHaveBeenCalled();
    expect(discardRepoPreparationMock).toHaveBeenCalledWith("/safe/mock-preparation.json");
    expect(composeMock).toHaveBeenCalledWith("svc-one", "pull", expect.anything());
    expect(serviceStartMock).toHaveBeenCalledWith("svc-one", expect.anything());
    expect(dbInstallMock).toHaveBeenCalledTimes(1);
    expect(dbInstallMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceKind: "artifact",
        source: "https://ex.example/intg-one.tar.gz",
      }),
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

  it("commits service repository metadata in the extension bookkeeping transaction", async () => {
    dbMock.queueSelect([]);
    dbMock.queueSelect([]);

    await installExtension(makeCtx(), { manifest: MANIFEST, sourceTrust: "community" });

    expect(dbMock.db.transaction).toHaveBeenCalledTimes(1);
    const firstInsert = dbMock.db.insert.mock.results[0]?.value as {
      values: ReturnType<typeof vi.fn>;
    };
    expect(firstInsert.values).toHaveBeenCalledWith({
      hash: "h1",
      url: "https://git.example/repo.git",
      displayName: "Bundle X",
      lastFetchedAt: new Date("2026-08-02T00:00:00Z"),
      lastSha: "d".repeat(40),
      pinnedRef: null,
      managedByExtension: "bundle-x",
    });
    expect(registerRepoMock).not.toHaveBeenCalled();
  });

  it("does not roll back a committed install when final progress reporting fails", async () => {
    dbMock.queueSelect([]);
    const ctx = makeCtx();
    vi.mocked(ctx.setProgress).mockImplementation(async (progress) => {
      if (progress === 100) throw new Error("job store unavailable");
    });

    await expect(
      installExtension(ctx, { manifest: INTEGRATION_ONLY, sourceTrust: "community" }),
    ).resolves.toEqual({ id: "bundle-x", components: 1 });

    expect(dbMock.db.transaction).toHaveBeenCalledTimes(1);
    expect(dbRemoveMock).not.toHaveBeenCalled();
    expect(removeRepoMock).not.toHaveBeenCalled();
  });

  it("applies the selection-consistency invariant (memory + file), init once", async () => {
    dbMock.queueSelect([]);
    dbMock.queueSelect([]);

    await installExtension(makeCtx(), { manifest: MANIFEST, sourceTrust: "community" });

    expect(writeSelectionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "serviceSelection.apply",
        selectedRoots: ["svc-one"],
      }),
    );
    expect(applyEnabledIds).toHaveBeenCalled();
    // Registry inited exactly once — never re-inited from the stale baked env.
    expect(initRegistryMock).toHaveBeenCalledTimes(1);
  });

  it("rolls back via the ledger when serviceStart fails, writing no extension rows", async () => {
    dbMock.queueSelect([]); // repo check; integration check never reached
    serviceStartMock.mockRejectedValueOnce(new Error("boom"));

    await expect(
      installExtension(makeCtx(), { manifest: MANIFEST, sourceTrust: "community" }),
    ).rejects.toThrow(/boom/);

    // Rollback removed the freshly-added service + repo, re-rendered compose.
    expect(composeMock).toHaveBeenCalledWith("svc-one", "remove", expect.anything());
    expect(removeRepoMock).toHaveBeenCalledWith("h1");
    expect(discardRepoPreparationMock).toHaveBeenCalledWith("/safe/mock-preparation.json");
    expect(renderMock).toHaveBeenCalled();
    // No integration was installed this run, and no bookkeeping was written.
    expect(dbRemoveMock).not.toHaveBeenCalled();
    expect(dbMock.db.insert).not.toHaveBeenCalled();
    expect(reloadMock).not.toHaveBeenCalled();
  });

  it("still rolls back and preserves the install error when rollback logging fails", async () => {
    dbMock.queueSelect([]);
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

    expect(removeRepoMock).toHaveBeenCalledWith("h1");
    expect(discardRepoPreparationMock).toHaveBeenCalledWith("/safe/mock-preparation.json");
    expect(renderMock).toHaveBeenCalled();
  });

  it("retains the preparation journal when fresh-checkout removal fails", async () => {
    dbMock.queueSelect([]);
    serviceStartMock.mockRejectedValueOnce(new Error("start failed"));
    removeRepoMock.mockRejectedValueOnce(new Error("filesystem busy"));

    await expect(
      installExtension(makeCtx(), { manifest: MANIFEST, sourceTrust: "community" }),
    ).rejects.toThrow("start failed");

    expect(removeRepoMock).toHaveBeenCalledWith("h1");
    expect(discardRepoPreparationMock).not.toHaveBeenCalled();
  });

  it("retains every service recovery artifact when failed-install runtime removal fails", async () => {
    dbMock.queueSelect([]);
    dbMock.queueSelect([]);
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
    expect(removeRepoMock).not.toHaveBeenCalled();
    expect(discardRepoPreparationMock).not.toHaveBeenCalled();
    expect(restoreRepoMock).not.toHaveBeenCalled();
    expect(writeSelectionMock).toHaveBeenCalledTimes(1);
    expect(renderMock).toHaveBeenCalledTimes(1);
  });

  it("fails closed on a service image pull failure and records no requested version", async () => {
    dbMock.queueSelect([]); // repo was newly registered
    composeMock.mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "" });

    await expect(
      installExtension(makeCtx(), { manifest: MANIFEST, sourceTrust: "community" }),
    ).rejects.toThrow(/Failed to pull community service image svc-one/i);

    expect(serviceStartMock).not.toHaveBeenCalled();
    expect(removeRepoMock).toHaveBeenCalledWith("h1");
    expect(dbMock.db.transaction).not.toHaveBeenCalled();
  });

  it("restores an existing service repository when an update pull fails", async () => {
    const previous = {
      hash: "hash-https://git.example/repo.git",
      url: "https://git.example/repo.git",
      displayName: "Bundle X old",
      lastFetchedAt: new Date("2026-08-01T00:00:00Z"),
      lastSha: "c".repeat(40),
      autoUpdate: false,
      pinnedRef: "v1.0.0",
      managedByExtension: "bundle-x",
      createdAt: new Date("2026-08-01T00:00:00Z"),
    };
    dbMock.queueSelect([previous]);
    composeMock.mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "" });

    await expect(
      installExtension(makeCtx(), { manifest: MANIFEST, sourceTrust: "community" }),
    ).rejects.toThrow(/pull/i);

    expect(backupRepoMock).toHaveBeenCalledWith(previous, {
      selectionBefore: [],
      touchedServiceIds: ["svc-one"],
      previouslyEnabledServiceIds: [],
    });
    expect(stageRepoMock).toHaveBeenCalledWith(
      "https://git.example/repo.git",
      expect.objectContaining({ minimumLastFetchedAtExclusive: previous.lastFetchedAt }),
    );
    expect(publishStagedRepoMock).toHaveBeenCalledTimes(1);
    expect(restoreRepoMock).toHaveBeenCalledWith({
      snapshot: previous,
      backupDir: "/safe/mock-backup",
      selectionBefore: [],
    });
    expect(discardRepoBackupMock).not.toHaveBeenCalled();
    expect(removeRepoMock).not.toHaveBeenCalled();
    expect(dbMock.db.transaction).not.toHaveBeenCalled();
  });

  it("retains update rollback backup and selection when runtime removal fails", async () => {
    const previous = {
      hash: "hash-https://git.example/repo.git",
      url: "https://git.example/repo.git",
      displayName: "old",
      lastFetchedAt: new Date("2026-08-01T00:00:00Z"),
      lastSha: "c".repeat(40),
      autoUpdate: false,
      pinnedRef: "v1",
      managedByExtension: "bundle-x",
      createdAt: new Date("2026-08-01T00:00:00Z"),
    };
    dbMock.queueSelect([previous]);
    dbMock.queueSelect([{ ...previous, hash: "hash-https://git.example/other.git" }]);
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
    expect(restoreRepoMock).not.toHaveBeenCalled();
    expect(discardRepoBackupMock).not.toHaveBeenCalled();
    expect(discardRepoPreparationMock).not.toHaveBeenCalled();
    expect(writeSelectionMock).toHaveBeenCalledTimes(1);
  });

  it("discards an existing repository backup only after a successful update", async () => {
    const previous = {
      hash: "hash-https://git.example/repo.git",
      url: "https://git.example/repo.git",
      displayName: "Bundle X old",
      lastFetchedAt: new Date("2026-08-01T00:00:00Z"),
      lastSha: "c".repeat(40),
      autoUpdate: false,
      pinnedRef: "v1.0.0",
      managedByExtension: "bundle-x",
      createdAt: new Date("2026-08-01T00:00:00Z"),
    };
    dbMock.queueSelect([previous]);
    dbMock.queueSelect([]);

    await installExtension(makeCtx(), { manifest: MANIFEST, sourceTrust: "community" });

    expect(discardRepoBackupMock).toHaveBeenCalledWith({
      snapshot: previous,
      backupDir: "/safe/mock-backup",
      selectionBefore: [],
    });
    expect(restoreRepoMock).not.toHaveBeenCalled();
  });

  it("rejects an extension service whose image is not pinned by digest", async () => {
    dbMock.queueSelect([]);
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

    expect(composeMock).not.toHaveBeenCalledWith("svc-one", "pull");
    expect(removeRepoMock).toHaveBeenCalledWith("h1");
    expect(dbMock.db.transaction).not.toHaveBeenCalled();
  });

  it("does not mutate registry, filesystem, or Compose when community bind preflight rejects", async () => {
    dbMock.queueSelect([]);
    stageRepoMock.mockRejectedValueOnce(
      new Error(
        "community_bind_mount_forbidden: bindMounts are not allowed for community services",
      ),
    );

    await expect(
      installExtension(makeCtx(), { manifest: MANIFEST, sourceTrust: "community" }),
    ).rejects.toThrow("community_bind_mount_forbidden");

    expect(initRegistryMock).not.toHaveBeenCalled();
    expect(applyEnabledIds).not.toHaveBeenCalled();
    expect(removeRepoMock).not.toHaveBeenCalled();
    expect(restoreRepoMock).not.toHaveBeenCalled();
    expect(discardRepoPreparationMock).not.toHaveBeenCalled();
    expect(createInstallJournalMock).not.toHaveBeenCalled();
    expect(markInstallJournalRestoringMock).not.toHaveBeenCalled();
    expect(reconcileInstallJournalMock).not.toHaveBeenCalled();
    expect(renderMock).not.toHaveBeenCalled();
    expect(composeMock).not.toHaveBeenCalled();
    expect(serviceStartMock).not.toHaveBeenCalled();
    expect(reloadMock).not.toHaveBeenCalled();
    expect(dbMock.db.transaction).not.toHaveBeenCalled();
  });

  it("does not back up or roll back an existing repository when bind preflight rejects", async () => {
    const previous = {
      hash: "hash-https://git.example/repo.git",
      url: "https://git.example/repo.git",
      displayName: "Bundle X old",
      lastFetchedAt: new Date("2026-08-01T00:00:00Z"),
      lastSha: "c".repeat(40),
      autoUpdate: false,
      pinnedRef: "v1.0.0",
      managedByExtension: "bundle-x",
      createdAt: new Date("2026-08-01T00:00:00Z"),
    };
    dbMock.queueSelect([previous]);
    stageRepoMock.mockRejectedValueOnce(
      new Error(
        "community_bind_mount_forbidden: bindMounts are not allowed for community services",
      ),
    );

    await expect(
      installExtension(makeCtx(), { manifest: MANIFEST, sourceTrust: "community" }),
    ).rejects.toThrow("community_bind_mount_forbidden");

    expect(backupRepoMock).not.toHaveBeenCalled();
    expect(publishStagedRepoMock).not.toHaveBeenCalled();
    expect(restoreRepoMock).not.toHaveBeenCalled();
    expect(discardRepoBackupMock).not.toHaveBeenCalled();
    expect(initRegistryMock).not.toHaveBeenCalled();
    expect(applyEnabledIds).not.toHaveBeenCalled();
    expect(renderMock).not.toHaveBeenCalled();
    expect(composeMock).not.toHaveBeenCalled();
    expect(serviceStartMock).not.toHaveBeenCalled();
    expect(dbMock.db.transaction).not.toHaveBeenCalled();
    expect(dbMock.db.select).toHaveBeenCalledTimes(1);
  });

  it("rolls back the installed integration when the reload fails", async () => {
    dbMock.queueSelect([]); // integration not installed
    reloadMock.mockRejectedValueOnce(new Error("reload-fail"));

    await expect(
      installExtension(makeCtx(), { manifest: INTEGRATION_ONLY, sourceTrust: "community" }),
    ).rejects.toThrow(/reload-fail/);

    expect(dbRemoveMock).toHaveBeenCalledWith(
      expect.objectContaining({ rootDir: expect.any(String), id: "intg-one" }),
    );
    expect(dbMock.db.delete).toHaveBeenCalled(); // installedIntegration cleanup
    // Pipeline reload (threw) + rollback reload.
    expect(reloadMock).toHaveBeenCalledTimes(2);
    // The reload threw before the bookkeeping transaction, so no rows to leak.
    expect(dbMock.db.transaction).not.toHaveBeenCalled();
  });

  it("restores a pre-existing integration artifact when reload fails", async () => {
    dbMock.queueSelect([{ id: "intg-one" }]);
    reloadMock.mockRejectedValueOnce(new Error("reload-fail"));

    await expect(
      installExtension(makeCtx(), { manifest: INTEGRATION_ONLY, sourceTrust: "community" }),
    ).rejects.toThrow(/reload-fail/);

    expect(integrationBackupMock).toHaveBeenCalledWith(expect.any(String), "intg-one");
    expect(integrationRestoreMock).toHaveBeenCalledWith(expect.any(String), {
      id: "intg-one",
      backupDirectory: "/safe/mock-integration-backup",
    });
    expect(dbRemoveMock).not.toHaveBeenCalled();
    expect(integrationBackupDiscardMock).not.toHaveBeenCalled();
    expect(reloadMock).toHaveBeenCalledTimes(2);
  });

  it("update/re-install re-writes the component links (delete + insert)", async () => {
    dbMock.queueSelect([{ id: "intg-one" }]); // integration already installed → ledger empty

    const result = await installExtension(makeCtx(), {
      manifest: INTEGRATION_ONLY,
      sourceTrust: "community",
    });

    expect(result).toEqual({ id: "bundle-x", components: 1 });
    expect(integrationBackupDiscardMock).toHaveBeenCalledWith(expect.any(String), {
      id: "intg-one",
      backupDirectory: "/safe/mock-integration-backup",
    });
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
    const manifest = { ...INTEGRATION_ONLY, platform: "9999.0.0" } satisfies ExtensionManifest;

    await expect(
      installExtension(makeCtx(), { manifest, sourceTrust: "community" }),
    ).rejects.toThrow(/requires platform/);

    expect(registerRepoMock).not.toHaveBeenCalled();
    expect(dbInstallMock).not.toHaveBeenCalled();
    expect(dbMock.db.insert).not.toHaveBeenCalled();
  });
});

describe("removeExtension", () => {
  it("retains selection and repository ownership when community runtime removal fails", async () => {
    dbMock.queueSelect([{ id: "bundle-x" }]);
    dbMock.queueSelect([{ extensionId: "bundle-x", kind: "service", componentId: "svc-one" }]);
    composeMock.mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "" });

    await expect(removeExtension(makeCtx(), "bundle-x")).rejects.toThrow(
      "Failed to remove community service runtime svc-one",
    );

    expect(composeMock).toHaveBeenCalledWith("svc-one", "remove", expect.anything());
    expect(writeSelectionMock).not.toHaveBeenCalled();
    expect(removeRepoMock).not.toHaveBeenCalled();
    expect(renderMock).not.toHaveBeenCalled();
    expect(dbMock.db.delete).not.toHaveBeenCalled();
  });
});
