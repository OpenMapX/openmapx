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
  installIntegration: vi.fn().mockResolvedValue(undefined),
  removeIntegration: vi.fn(),
}));

vi.mock("../../integration-host", () => ({
  reloadIntegrations: vi.fn().mockResolvedValue({ message: "ok", reloaded: 1, enabled: 1 }),
}));

vi.mock("../../utils/docker-compose", () => ({
  dockerComposeAction: vi.fn().mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" }),
}));

vi.mock("../admin-cli", () => ({
  getServiceSelectionSummary: vi.fn().mockReturnValue({ selectedRoots: [] }),
  writeServiceSelection: vi.fn(),
}));

vi.mock("../admin-ops", () => ({
  renderAndPersistCompose: vi.fn().mockResolvedValue(undefined),
  serviceStart: vi.fn().mockResolvedValue(undefined),
}));

const applyEnabledIds = vi.fn();
vi.mock("../service-registry", () => ({
  getServiceRegistry: vi.fn(() => ({ list: () => [SVC_DEF], applyEnabledIds })),
  initServiceRegistry: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../service-repositories", () => ({
  hashUrl: vi.fn((u: string) => `hash-${u}`),
  registerRepo: vi.fn().mockResolvedValue({ hash: "h1" }),
  removeRepo: vi.fn().mockResolvedValue(undefined),
}));

import { installIntegration, removeIntegration } from "@openmapx/integration-framework/installer";
import { reloadIntegrations } from "../../integration-host";
import { dockerComposeAction } from "../../utils/docker-compose";
import { getServiceSelectionSummary, writeServiceSelection } from "../admin-cli";
import { renderAndPersistCompose, serviceStart } from "../admin-ops";
import type { JobContext } from "../job-runner.js";
import { initServiceRegistry } from "../service-registry";
import { registerRepo, removeRepo } from "../service-repositories";

// The SUT is imported dynamically (after the mocks are wired) so the db mock
// factory reads `dbMock.db` only once `dbMock` is initialized — a static import
// hoists above the const and hits the temporal dead zone.
let installExtension: typeof import("../extension-installer.js").installExtension;
beforeAll(async () => {
  ({ installExtension } = await import("../extension-installer.js"));
});

type ExtensionManifest = coreServices.ExtensionManifest;

// Minimal service registry entry — `expandServiceSelection` (run un-mocked
// inside applySelectionRoots) reads `svc.manifest.id`; the manifest's service
// id must be present or it reports the selection missing and throws.
const SVC_DEF = { manifest: { id: "svc-one", container: {} } } as never;

function makeCtx(): JobContext {
  return {
    jobId: "job-1",
    payload: {},
    signal: new AbortController().signal,
    log: vi.fn().mockResolvedValue(undefined),
    setProgress: vi.fn().mockResolvedValue(undefined),
  };
}

const MANIFEST = {
  id: "bundle-x",
  name: "Bundle X",
  version: "1.2.3",
  services: [{ repo: "https://git.example/repo.git", service: "svc-one" }],
  integrations: [{ artifact: "https://ex.example/intg-one.tar.gz", id: "intg-one" }],
} satisfies ExtensionManifest;

const INTEGRATION_ONLY = {
  id: "bundle-x",
  name: "Bundle X",
  version: "1.2.3",
  integrations: [{ artifact: "https://ex.example/intg-one.tar.gz", id: "intg-one" }],
} satisfies ExtensionManifest;

const dbInstallMock = vi.mocked(installIntegration);
const dbRemoveMock = vi.mocked(removeIntegration);
const reloadMock = vi.mocked(reloadIntegrations);
const composeMock = vi.mocked(dockerComposeAction);
const registerRepoMock = vi.mocked(registerRepo);
const removeRepoMock = vi.mocked(removeRepo);
const serviceStartMock = vi.mocked(serviceStart);
const renderMock = vi.mocked(renderAndPersistCompose);
const writeSelectionMock = vi.mocked(writeServiceSelection);
const initRegistryMock = vi.mocked(initServiceRegistry);

afterEach(() => {
  // clearAllMocks resets call history but preserves mockReturnValue /
  // mockResolvedValue implementations (see integration-host.test.ts:135-139).
  vi.clearAllMocks();
  // Re-prime implementations cleared history relies on but that must persist.
  reloadMock.mockResolvedValue({ message: "ok", reloaded: 1, enabled: 1 });
  composeMock.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
  registerRepoMock.mockResolvedValue({ hash: "h1" } as never);
  vi.mocked(getServiceSelectionSummary).mockReturnValue({ selectedRoots: [] } as never);
});

describe("installExtension", () => {
  it("happy path installs a service + integration and records all bookkeeping", async () => {
    dbMock.queueSelect([]); // service repo not registered
    dbMock.queueSelect([]); // integration not installed

    const result = await installExtension(makeCtx(), {
      manifest: MANIFEST,
      sourceTrust: "community",
    });

    expect(result).toEqual({ id: "bundle-x", components: 2 });

    expect(registerRepoMock).toHaveBeenCalledWith("https://git.example/repo.git", {
      ref: undefined,
      managedByExtension: "bundle-x",
    });
    expect(composeMock).toHaveBeenCalledWith("svc-one", "pull");
    expect(serviceStartMock).toHaveBeenCalledWith("svc-one", expect.anything());
    expect(dbInstallMock).toHaveBeenCalledTimes(1);
    expect(dbInstallMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceKind: "artifact",
        source: "https://ex.example/intg-one.tar.gz",
      }),
    );
    expect(reloadMock).toHaveBeenCalledTimes(1);

    // Three inserts: installedIntegration, installedExtension, installedExtensionComponent.
    expect(dbMock.db.insert).toHaveBeenCalledTimes(3);
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

  it("applies the selection-consistency invariant (memory + file), init once", async () => {
    dbMock.queueSelect([]);
    dbMock.queueSelect([]);

    await installExtension(makeCtx(), { manifest: MANIFEST, sourceTrust: "community" });

    expect(writeSelectionMock).toHaveBeenCalledWith(["svc-one"]);
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
    expect(composeMock).toHaveBeenCalledWith("svc-one", "remove");
    expect(removeRepoMock).toHaveBeenCalledWith("h1");
    expect(renderMock).toHaveBeenCalled();
    // No integration was installed this run, and no bookkeeping was written.
    expect(dbRemoveMock).not.toHaveBeenCalled();
    expect(dbMock.db.insert).not.toHaveBeenCalled();
    expect(reloadMock).not.toHaveBeenCalled();
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

  it("update/re-install re-writes the component links (delete + insert)", async () => {
    dbMock.queueSelect([{ id: "intg-one" }]); // integration already installed → ledger empty

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
    const manifest = { ...INTEGRATION_ONLY, platform: "9999.0.0" } satisfies ExtensionManifest;

    await expect(
      installExtension(makeCtx(), { manifest, sourceTrust: "community" }),
    ).rejects.toThrow(/requires platform/);

    expect(registerRepoMock).not.toHaveBeenCalled();
    expect(dbInstallMock).not.toHaveBeenCalled();
    expect(dbMock.db.insert).not.toHaveBeenCalled();
  });
});
