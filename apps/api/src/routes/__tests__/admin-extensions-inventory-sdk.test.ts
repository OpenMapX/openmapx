import { createApiClient } from "@openmapx/core";
import * as sdk from "@openmapx/core/api-admin-sdk";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installedExtension } from "../../db/schema";
import { uniformErrorHandler } from "../../server-wiring";
import { addExtensionSource, getKillSwitch } from "../../services/extension-store";
import {
  EDIT_EXTENSION_SOURCES,
  PUBLISH_EXTENSION_CATALOG,
} from "../../services/extension-store-cache";
import { mockAdminSession } from "../../test/auth";
import { extensionPreviewLimit, storeInstallLimit } from "../../utils/rate-limit";
import { administrationSdkFetch } from "./helpers/administration-sdk-fetch";
import { extensionInstalledFixture as installed } from "./helpers/extension-admin-fixtures";

const ports = vi.hoisted(() => ({
  values: new Map<string, string>(),
  get: vi.fn(),
  eval: vi.fn(),
  fetch: vi.fn(),
  from: vi.fn(),
  audit: vi.fn(),
  enqueue: vi.fn(),
  log: vi.fn(),
  warning: vi.fn(),
  available: true,
}));
vi.mock("../../db", () => ({ db: { select: () => ({ from: ports.from }) } }));
vi.mock("../../redis", () => ({
  get redis() {
    return ports.available ? { get: ports.get, eval: ports.eval } : null;
  },
}));
vi.mock("@openmapx/core/server", async (original) => ({
  ...(await original<typeof import("@openmapx/core/server")>()),
  safeFetchJson: (...args: unknown[]) => ports.fetch(...args),
}));
vi.mock("../../auth", () => ({ auth: { api: { getSession: async () => mockAdminSession() } } }));
vi.mock("../../services/extension-installer", () => ({ previewExtensionInstall: vi.fn() }));
vi.mock("../../services/service-registry", () => ({
  getServiceRegistry: () => ({ get: () => undefined }),
}));
vi.mock("../../services/job-runner", () => ({
  jobRunner: { enqueue: (...args: unknown[]) => ports.enqueue(...args) },
}));
vi.mock("../../utils/audit-log", () => ({
  writeAuditLog: (...args: unknown[]) => ports.audit(...args),
}));
vi.mock("../../services/app-logger", () => ({
  appLogger: { add: (...args: unknown[]) => ports.log(...args) },
}));
const sourceKey = "extstore:extra_sources";
const catalogKey = "extstore:catalog";
const old = JSON.stringify({
  entries: [{ id: installed.id, name: "Catalog", version: "2.0" }],
  killSwitch: {
    removed: [["removed", "delisted"]],
    critical: [[installed.id, { reason: "blocked" }]],
  },
});
let app: FastifyInstance;
let options: { client: ReturnType<typeof createApiClient> };
beforeEach(async () => {
  vi.resetAllMocks();
  ports.values.clear();
  ports.available = true;
  ports.from.mockImplementation(async (table) =>
    table === installedExtension
      ? [installed]
      : installed.components.map((c) => ({ ...c, extensionId: installed.id })),
  );
  ports.get.mockImplementation(async (key: string) => ports.values.get(key) ?? null);
  // Synthetic atomic storage port; actual cache helpers choose scripts/keys/arguments.
  ports.eval.mockImplementation(async (script: string, count: number, ...args: string[]) => {
    expect(count).toBe(2);
    const [sources, catalog, sourcePresent, observedSource, ...rest] = args;
    const matches = (key: string, present: string, value: string) =>
      present === "0" ? !ports.values.has(key) : ports.values.get(key) === value;
    if (!matches(sources, sourcePresent, observedSource)) return 0;
    if (script === EDIT_EXTENSION_SOURCES) {
      ports.values.delete(catalog);
      ports.values.set(sources, rest[0]);
    } else {
      expect(script).toBe(PUBLISH_EXTENSION_CATALOG);
      const [present, observed, next] = rest;
      if (!matches(catalog, present, observed)) return 0;
      ports.values.set(catalog, next);
    }
    return 1;
  });
  ports.fetch.mockResolvedValue([{ id: installed.id, name: "Catalog", version: "2.0" }]);
  ports.enqueue.mockResolvedValue("synthetic-remove-job");
  extensionPreviewLimit.reset();
  storeInstallLimit.reset();
  app = Fastify();
  app.setErrorHandler(uniformErrorHandler);
  app.addHook("onRequest", async (request) => {
    request.log.warn = ports.warning;
  });
  const { adminExtensionsRoute } = await import("../admin-extensions");
  await app.register(adminExtensionsRoute, { prefix: "/api" });
  await app.ready();
  vi.stubGlobal("fetch", administrationSdkFetch(app, { remoteAddress: "198.51.100.12" }));
  options = { client: createApiClient({ baseUrl: "https://app.test" }) };
});
afterEach(async () => {
  await app.close();
  vi.unstubAllGlobals();
  extensionPreviewLimit.reset();
  storeInstallLimit.reset();
});
async function expectInventory(hasUpdate: boolean | null, latestVersion: string | null) {
  const result = await sdk.listAdminInstalledExtensions(options);
  expect(result.status).toBe(200);
  if (result.status !== 200) throw Error("inventory failed");
  expect(result.data.extensions).toHaveLength(1);
  expect(result.data.extensions[0]).toMatchObject({
    id: installed.id,
    installedVersion: installed.installedVersion,
    sourceTrust: installed.sourceTrust,
    components: installed.components,
    hasUpdate,
    latestVersion,
  });
  expect(result.data.extensions[0]).not.toHaveProperty("manifest");
}
describe("authoritative inventory through real store, route and generated SDK", () => {
  it.each(["cold", "source-invalidated"])(
    "retains local inventory after %s cache provider failure without publication",
    async (state) => {
      if (state === "source-invalidated") {
        ports.values.set(catalogKey, old);
        await addExtensionSource("https://extra.test/catalog.json", "Extra");
        ports.eval.mockClear();
      }
      ports.fetch.mockRejectedValue({ name: "SECRET_SENTINEL", message: "SECRET_SENTINEL" });
      await expectInventory(null, null);
      expect(ports.values.has(catalogKey)).toBe(false);
      expect(ports.eval).not.toHaveBeenCalled();
      expect(ports.audit).not.toHaveBeenCalled();
      expect(JSON.stringify(ports.log.mock.calls)).not.toContain("SECRET_SENTINEL");
      expect(ports.warning).toHaveBeenCalledWith(
        { errorClass: "Error" },
        "Installed extension update comparison unavailable",
      );
      expect(await sdk.refreshAdminExtensionCatalog(undefined, options)).toMatchObject({
        status: 500,
      });
      expect(ports.audit).not.toHaveBeenCalled();
      expect(ports.eval).not.toHaveBeenCalled();
      expect(await sdk.removeAdminExtension(installed.id, undefined, options)).toMatchObject({
        status: 202,
      });
    },
  );
  it.each(["unavailable", "source-read", "catalog-read", "publication", "conflict"])(
    "retains inventory across optional %s failure",
    async (failure) => {
      if (failure === "unavailable") {
        ports.available = false;
        ports.fetch.mockRejectedValue(Error("SECRET_SENTINEL"));
      }
      if (failure === "source-read" || failure === "catalog-read")
        ports.get.mockImplementation(async (key) => {
          if (key === (failure === "source-read" ? sourceKey : catalogKey))
            throw { name: "SECRET_SENTINEL" };
          return null;
        });
      if (failure === "publication") ports.eval.mockRejectedValue({ name: "SECRET_SENTINEL" });
      if (failure === "conflict") ports.eval.mockResolvedValue(0);
      await expectInventory(null, null);
      expect(ports.values.has(catalogKey)).toBe(false);
      expect(ports.audit).not.toHaveBeenCalled();
      expect(await sdk.refreshAdminExtensionCatalog(undefined, options)).toMatchObject({
        status: 500,
      });
      expect(ports.values.has(catalogKey)).toBe(false);
      expect(ports.audit).not.toHaveBeenCalled();
      expect(JSON.stringify(ports.warning.mock.calls)).not.toContain("SECRET_SENTINEL");
      expect(await sdk.removeAdminExtension(installed.id, undefined, options)).toMatchObject({
        status: 202,
      });
    },
  );
  it.each([
    ["2.0", true],
    ["1.0", false],
    [undefined, null],
  ] as const)("compares matching version %s truthfully", async (version, expected) => {
    ports.fetch.mockResolvedValue([
      { id: installed.id, name: "Catalog", ...(version ? { version } : {}) },
    ]);
    await expectInventory(expected, version ?? null);
  });
  it("uses unknown when no matching catalog entry exists", async () => {
    ports.fetch.mockResolvedValue([]);
    await expectInventory(null, null);
    expect(JSON.parse(ports.values.get(catalogKey) ?? "null")).toEqual({
      entries: [],
      killSwitch: { removed: [], critical: [] },
    });
  });
  it("keeps failed forced refresh fail-closed without changing cached entries or denials", async () => {
    ports.values.set(catalogKey, old);
    ports.fetch.mockRejectedValue(Error("SECRET_SENTINEL"));
    expect(await sdk.refreshAdminExtensionCatalog(undefined, options)).toMatchObject({
      status: 500,
    });
    expect(ports.values.get(catalogKey)).toBe(old);
    expect(ports.eval).not.toHaveBeenCalled();
    expect(ports.audit).not.toHaveBeenCalled();
    const denial = await getKillSwitch();
    expect(denial.critical.has(installed.id)).toBe(true);
    expect(denial.removed.has("removed")).toBe(true);
  });
  it.each(["inventory", "components"])(
    "does not swallow authoritative DB %s failure",
    async (failure) => {
      ports.from.mockImplementation(async (table) => {
        if ((table === installedExtension) === (failure === "inventory"))
          throw Error("SECRET_SENTINEL");
        return [installed];
      });
      expect(await sdk.listAdminInstalledExtensions(options)).toMatchObject({ status: 500 });
      expect(ports.fetch).not.toHaveBeenCalled();
    },
  );
  it("does not treat malformed response output as optional enrichment failure", async () => {
    ports.values.set(
      catalogKey,
      JSON.stringify({
        entries: [{ id: installed.id, name: "Catalog", version: 42 }],
        killSwitch: { removed: [], critical: [] },
      }),
    );
    expect(await sdk.listAdminInstalledExtensions(options)).toMatchObject({ status: 500 });
  });
});
