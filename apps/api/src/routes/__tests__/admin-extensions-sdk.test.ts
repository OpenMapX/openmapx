import { createApiClient } from "@openmapx/core";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeRateLimitTierHook, uniformErrorHandler } from "../../server-wiring";
import { mockAdminSession } from "../../test/auth";
import { makeCsrfGuardHook } from "../../utils/csrf";
import { extensionPreviewLimit, RateLimiter, storeInstallLimit } from "../../utils/rate-limit";
import { administrationSdkFetch } from "./helpers/administration-sdk-fetch";
import {
  extensionCatalogFixture as entry,
  extensionInstalledFixture as installed,
  extensionOperationInventory as inventory,
  extensionManifestFixture as manifest,
  extensionPreviewFixture as preview,
  extensionRatingFixture as rating,
  extensionServiceFixture as service,
  extensionSourcesFixture as sources,
} from "./helpers/extension-admin-fixtures";

const session = mockAdminSession();
const getSession = vi.fn();
vi.mock("../../auth", () => ({
  auth: { api: { getSession: (...args: unknown[]) => getSession(...args) } },
}));
const catalog = vi.fn();
const detail = vi.fn();
const resolve = vi.fn();
const kill = vi.fn();
const listInstalled = vi.fn();
const listSources = vi.fn();
const addSource = vi.fn();
const removeSource = vi.fn();
vi.mock("../../services/extension-store", () => ({
  getExtensionCatalog: (...a: unknown[]) => catalog(...a),
  getExtensionCatalogEntry: (...a: unknown[]) => detail(...a),
  resolveExtensionManifest: (...a: unknown[]) => resolve(...a),
  getKillSwitch: (...a: unknown[]) => kill(...a),
  listInstalledExtensions: (...a: unknown[]) => listInstalled(...a),
  listExtensionSources: (...a: unknown[]) => listSources(...a),
  addExtensionSource: (...a: unknown[]) => addSource(...a),
  removeExtensionSource: (...a: unknown[]) => removeSource(...a),
  normalizeExtensionLocator: (url: string) => url,
  isExtensionCompatible: () => true,
  PLATFORM_VERSION: "1.0",
}));
const inspect = vi.fn();
vi.mock("../../services/extension-installer", () => ({
  previewExtensionInstall: (...a: unknown[]) => inspect(...a),
}));
const enqueue = vi.fn();
const audit = vi.fn();
vi.mock("../../services/job-runner", () => ({
  jobRunner: { enqueue: (...a: unknown[]) => enqueue(...a) },
}));
vi.mock("../../utils/audit-log", () => ({ writeAuditLog: (...a: unknown[]) => audit(...a) }));
const registry = vi.fn();
vi.mock("../../services/service-registry", () => ({ getServiceRegistry: () => registry() }));
let app: FastifyInstance;
let floor: RateLimiter;
const recorded: { method: string; url: string; body: unknown; media: unknown }[] = [];
const registered: { method: unknown; url: string; id?: string }[] = [];
beforeEach(async () => {
  vi.resetAllMocks();
  storeInstallLimit.reset();
  extensionPreviewLimit.reset();
  recorded.length = 0;
  registered.length = 0;
  getSession.mockResolvedValue(session);
  catalog.mockResolvedValue([entry]);
  detail.mockResolvedValue(entry);
  resolve.mockResolvedValue(manifest);
  kill.mockResolvedValue({ removed: new Map(), critical: new Map(), stale: false });
  listInstalled.mockResolvedValue([installed]);
  listSources.mockResolvedValue(sources);
  addSource.mockResolvedValue(undefined);
  removeSource.mockResolvedValue(undefined);
  inspect.mockResolvedValue(preview);
  enqueue.mockResolvedValue("job-synthetic-202");
  audit.mockResolvedValue(undefined);
  registry.mockReturnValue({
    get: (id: string) => (id === "synthetic" ? { enabled: true, manifest: service } : undefined),
  });
  app = Fastify({ bodyLimit: 4096 });
  floor = new RateLimiter({ max: 100, windowMs: 60_000 });
  app.setErrorHandler(uniformErrorHandler);
  app.addHook("onRoute", (route) => {
    if (route.method !== "HEAD")
      registered.push({ method: route.method, url: route.url, id: route.schema?.operationId });
  });
  app.addHook("onRequest", makeCsrfGuardHook(["https://app.test"]));
  const unexpected = async () => {
    throw Error("Unexpected tier");
  };
  app.addHook(
    "onRequest",
    makeRateLimitTierHook({
      auth: unexpected,
      tile: unexpected,
      expensive: unexpected,
      integrationIngress: unexpected,
      status: unexpected,
      public: (req, reply) => floor.preHandler()(req, reply),
    }),
  );
  app.addHook("preHandler", async (request) => {
    recorded.push({
      method: request.method,
      url: request.url,
      body: request.body,
      media: request.headers["content-type"],
    });
  });
  const { adminExtensionsRoute } = await import("../admin-extensions");
  await app.register(adminExtensionsRoute, { prefix: "/api" });
  await app.ready();
});
afterEach(async () => {
  vi.unstubAllGlobals();
  floor.destroy();
  storeInstallLimit.reset();
  extensionPreviewLimit.reset();
  await app.close();
});
function client(headers: Record<string, string> = {}) {
  vi.stubGlobal("fetch", administrationSdkFetch(app, { remoteAddress: "198.51.100.12" }));
  return createApiClient({
    baseUrl: "https://app.test",
    credentials: "include",
    headerInterceptor: () => headers,
  });
}
const path = (suffix: string) => `/api/admin/extensions${suffix}`;

describe("actual extension producers", () => {
  it("characterizes full current wire projections and real auth before adoption", async () => {
    const list = await app.inject(path("/catalog"));
    expect(list.statusCode).toBe(200);
    expect(list.json().entries[0]).toMatchObject({
      ...entry,
      installed: true,
      hasUpdate: true,
      status: "community",
    });
    const result = await app.inject(path("/installed"));
    expect(result.json().extensions[0]).toEqual({
      id: entry.id,
      name: entry.name,
      sourceTrust: "community",
      installedVersion: "1.0",
      sourceUrl: null,
      installedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-02-01T00:00:00.000Z",
      components: [
        {
          kind: "service",
          componentId: "synthetic",
          enabled: true,
          securityRating: rating,
        },
        { kind: "integration", componentId: "synthetic" },
      ],
      hasUpdate: true,
      latestVersion: "2.0",
    });
    getSession.mockResolvedValue(null);
    expect(
      (await app.inject({ method: "POST", url: path("/install"), payload: { wrong: true } }))
        .statusCode,
    ).toBe(401);
    expect(enqueue).not.toHaveBeenCalled();
  });
  it("adopts exactly eleven operation identities on the actual plugin", () => {
    expect(registered.map((r) => [r.method, r.url, r.id]).sort()).toEqual(
      inventory.map(([method, suffix, id]) => [method, path(suffix), id]).sort(),
    );
  });
  it("round trips all eleven actual producers through final generated SDK and real ApiClient", async () => {
    const sdk = await import("@openmapx/core/api-admin-sdk");
    const options = { client: client() };
    const list = await sdk.listAdminExtensionCatalog(
      { q: "Synthetic", sort: "fallback", type: "unknown" },
      options,
    );
    expect(list.status).toBe(200);
    if (list.status !== 200) throw Error("catalog");
    expect(list.data.entries[0]).toEqual({
      ...entry,
      components: { services: 1, integrations: 1 },
      compatible: true,
      platformVersion: "1.0",
      installed: true,
      installedVersion: "1.0",
      hasUpdate: true,
      removed: null,
      critical: null,
      status: "community",
    });
    const found = await sdk.getAdminExtensionCatalogEntry(entry.id, options);
    expect(found.status).toBe(200);
    if (found.status !== 200) throw Error("detail");
    expect(found.data).toEqual({
      ...entry,
      componentList: [
        { kind: "service", id: "synthetic" },
        { kind: "integration", id: "synthetic-integration" },
      ],
      compatible: true,
      platformVersion: "1.0",
      removed: null,
      critical: null,
    });
    expect(detail).toHaveBeenLastCalledWith(entry.id);
    const installedResult = await sdk.listAdminInstalledExtensions(options);
    expect(installedResult.status).toBe(200);
    if (installedResult.status !== 200) throw Error("installed");
    expect(installedResult.data.extensions[0].components[0].securityRating).toEqual(rating);
    expect(installedResult.data.extensions[0].installedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(installedResult.data.extensions[0]).not.toHaveProperty("manifest");
    expect(
      await sdk.previewAdminExtensionInstall(
        { id: entry.id, manifestUrl: "https://ignored.test", hostPortConfirmation: "opaque" },
        options,
      ),
    ).toMatchObject({ status: 200, data: preview });
    expect(resolve).toHaveBeenLastCalledWith(entry);
    storeInstallLimit.reset();
    extensionPreviewLimit.reset();
    expect(
      await sdk.installAdminExtension(
        { id: entry.id, hostPortConfirmation: preview.confirmation },
        options,
      ),
    ).toMatchObject({ status: 202, data: { jobId: "job-synthetic-202" } });
    expect(enqueue).toHaveBeenLastCalledWith(
      "extension.install",
      {
        manifest,
        sourceUrl: entry.manifest,
        sourceTrust: "community",
        actorId: session.user.id,
        hostPortConfirmation: preview.confirmation,
      },
      session.user.id,
    );
    storeInstallLimit.reset();
    extensionPreviewLimit.reset();
    expect(await sdk.updateAdminExtension(entry.id, undefined, options)).toMatchObject({
      status: 202,
      data: { jobId: "job-synthetic-202" },
    });
    expect(await sdk.removeAdminExtension(entry.id, undefined, options)).toMatchObject({
      status: 202,
      data: { jobId: "job-synthetic-202" },
    });
    expect(enqueue).toHaveBeenLastCalledWith(
      "extension.remove",
      { id: entry.id, actorId: session.user.id },
      session.user.id,
    );
    expect(await sdk.listAdminExtensionSources(options)).toMatchObject({
      status: 200,
      data: { sources },
    });
    expect(
      await sdk.addAdminExtensionSource(
        { url: " https://example.test/custom ", label: " Custom " },
        options,
      ),
    ).toMatchObject({ status: 200, data: { ok: true } });
    expect(addSource).toHaveBeenCalledWith(" https://example.test/custom ", " Custom ");
    expect(
      await sdk.removeAdminExtensionSource({ url: " https://example.test/custom " }, options),
    ).toMatchObject({ status: 200, data: { ok: true } });
    expect(removeSource).toHaveBeenCalledWith(" https://example.test/custom ");
    expect(await sdk.refreshAdminExtensionCatalog(undefined, options)).toMatchObject({
      status: 200,
      data: { entries: 1 },
    });
    expect(catalog).toHaveBeenLastCalledWith(true);
    expect(
      recorded.map((r) => `${r.method} ${new URL(r.url, "https://app.test").pathname}`).sort(),
    ).toEqual(
      inventory
        .map(
          ([method, suffix]) =>
            `${method} ${path(suffix.replace(":id", encodeURIComponent(entry.id)))}`,
        )
        .sort(),
    );
    for (const r of recorded.filter(
      (r) =>
        r.url.includes("/update/") ||
        (r.method === "DELETE" && !r.url.endsWith("sources")) ||
        r.url.endsWith("refresh-catalog"),
    )) {
      expect(r.body == null).toBe(true);
      expect(r.media).toBeUndefined();
    }
    for (const r of recorded.filter((r) => r.body != null))
      expect(r.media).toBe("application/json");
    expect(enqueue).toHaveBeenCalledTimes(3);
    expect(audit).toHaveBeenCalledTimes(6);
  });
});

describe("extension contract boundaries", () => {
  it("rejects malformed known producer fields instead of returning truncated success", async () => {
    for (const bad of [
      { ...entry, unfamiliar: JSON.parse('{"nested":{"__proto__":{"invalid":true}}}') },
      { ...entry, name: 4 },
      { ...entry, services: [{ ...entry.services[0], ref: 4 }] },
    ]) {
      catalog.mockResolvedValueOnce([bad]);
      const response = await app.inject(path("/catalog"));
      expect(response.statusCode).toBe(500);
      expect(response.json()).not.toHaveProperty("entries");
    }
    inspect.mockResolvedValueOnce({
      ...preview,
      services: [{ ...preview.services[0], securityRating: { score: 4 } }],
    });
    const response = await app.inject({
      method: "POST",
      url: path("/install-preview"),
      payload: { id: entry.id },
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).not.toHaveProperty("services");
  });
  it("rejects malformed installed, source and accepted-job producer output", async () => {
    for (const bad of [
      { ...installed, sourceTrust: "invented" },
      { ...installed, components: [{ kind: "invented", componentId: "x" }] },
    ]) {
      listInstalled.mockResolvedValueOnce([bad]);
      expect((await app.inject(path("/installed"))).statusCode).toBe(500);
    }
    listSources.mockResolvedValueOnce([{ ...sources[0], isDefault: "true" }]);
    expect((await app.inject(path("/sources"))).statusCode).toBe(500);
    enqueue.mockResolvedValueOnce("");
    const sdk = await import("@openmapx/core/api-admin-sdk");
    expect(await sdk.removeAdminExtension(entry.id, undefined, { client: client() })).toMatchObject(
      { status: 500 },
    );
    expect(enqueue).toHaveBeenCalledTimes(1);
  });
  it("checks final SDK status, media, error body/header and input boundaries without hidden writes", async () => {
    const sdk = await import("@openmapx/core/api-admin-sdk");
    const options = { client: client() };
    const acquire = vi.fn();
    vi.stubGlobal("fetch", acquire);
    for (const response of [
      new Response(JSON.stringify({ sources }), { headers: { "content-type": "text/plain" } }),
      Response.json({ sources }, { status: 201 }),
      Response.json({ sources: [{ url: "x", label: "x", isDefault: 1 }] }),
      Response.json({ error: "Limited", retryAfter: 1 }, { status: 429 }),
      Response.json(
        { error: "Limited", retryAfter: 1 },
        { status: 429, headers: { "retry-after": "tomorrow" } },
      ),
      Response.json({ arbitrary: "bad error" }, { status: 400 }),
    ]) {
      acquire.mockResolvedValueOnce(response);
      await expect(sdk.listAdminExtensionSources(options)).rejects.toThrow(/contract/i);
    }
    // Body structure is validated by the actual producer; the bound transport
    // owns method/path/headers and validates the response. Null must stay null.
    const realOptions = { client: client() };
    expect(await sdk.updateAdminExtension(entry.id, JSON.parse("null"), realOptions)).toMatchObject(
      { status: 400 },
    );
    storeInstallLimit.reset();
    extensionPreviewLimit.reset();
    expect(await sdk.installAdminExtension({ id: "" }, realOptions)).toMatchObject({ status: 400 });
    expect(enqueue).not.toHaveBeenCalled();
    expect(recorded.find((r) => r.url.includes("/update/"))).toMatchObject({
      body: null,
      media: "application/json",
    });
  });
  it("retains sparse unknown versions, unenriched components and detail fallback", async () => {
    const sdk = await import("@openmapx/core/api-admin-sdk");
    const options = { client: client() };
    const sparse = { id: entry.id, name: "Sparse" };
    catalog.mockResolvedValue([sparse]);
    detail.mockResolvedValue(sparse);
    registry.mockImplementation(() => {
      throw Error("No registry");
    });
    resolve.mockRejectedValue(Error("Manifest unavailable"));
    const list = await sdk.listAdminExtensionCatalog(undefined, options);
    expect(list.status).toBe(200);
    if (list.status !== 200) throw Error("list");
    expect(list.data.entries[0]).not.toHaveProperty("version");
    expect(list.data.entries[0].hasUpdate).toBe(false);
    const found = await sdk.getAdminExtensionCatalogEntry(entry.id, options);
    expect(found.status).toBe(200);
    if (found.status !== 200) throw Error("detail");
    expect(found.data.componentList).toEqual([]);
    expect(found.data).not.toHaveProperty("version");
    expect(found.data).not.toHaveProperty("installed");
    const result = await sdk.listAdminInstalledExtensions(options);
    expect(result.status).toBe(200);
    if (result.status !== 200) throw Error("installed");
    expect(result.data.extensions[0]).toMatchObject({
      latestVersion: null,
      sourceUrl: null,
      hasUpdate: null,
      components: installed.components,
    });
    expect(result.data.extensions[0].components[0]).not.toHaveProperty("securityRating");
    for (const [removed, critical, stale, status] of [
      [new Map(), new Map(), false, "community"],
      [new Map([[entry.id, "Delisted"]]), new Map(), false, "revoked"],
      [
        new Map(),
        new Map([[entry.id, { reason: "Critical", maxVersion: "anything" }]]),
        false,
        "revoked",
      ],
      [new Map(), new Map(), true, "stale-revocation-data"],
    ] as const) {
      kill.mockResolvedValue({ removed, critical, stale });
      const response = await sdk.listAdminExtensionCatalog(undefined, options);
      expect(response).toMatchObject({
        status: 200,
        data: { entries: [{ status }], revocationDataStale: stale },
      });
    }
    catalog.mockResolvedValue([{ ...sparse, trust: "verified" }]);
    kill.mockResolvedValue({ removed: new Map(), critical: new Map(), stale: false });
    expect(await sdk.listAdminExtensionCatalog(undefined, options)).toMatchObject({
      data: { entries: [{ status: "verified" }] },
    });
  });
  it("preserves domain 404/400 distinctions and safe transport errors without mutation retry", async () => {
    const sdk = await import("@openmapx/core/api-admin-sdk");
    const options = { client: client() };
    detail.mockResolvedValue(null);
    expect(await sdk.getAdminExtensionCatalogEntry("missing", options)).toMatchObject({
      status: 404,
      data: { error: "Not found" },
    });
    expect(await sdk.previewAdminExtensionInstall({ id: "missing" }, options)).toMatchObject({
      status: 404,
    });
    storeInstallLimit.reset();
    extensionPreviewLimit.reset();
    expect(await sdk.installAdminExtension({ id: "missing" }, options)).toMatchObject({
      status: 404,
    });
    storeInstallLimit.reset();
    extensionPreviewLimit.reset();
    expect(await sdk.updateAdminExtension("missing", undefined, options)).toMatchObject({
      status: 400,
      data: { error: "Extension is not in any catalog source" },
    });
    expect(enqueue).not.toHaveBeenCalled();
    detail.mockResolvedValue(entry);
    storeInstallLimit.reset();
    extensionPreviewLimit.reset();
    enqueue.mockRejectedValue(Error("synthetic dependency"));
    expect(await sdk.installAdminExtension({ id: entry.id }, options)).toMatchObject({
      status: 500,
    });
    expect(enqueue).toHaveBeenCalledTimes(1);
    // Ambiguous transport failure cannot replay a mutation.
    const requests = vi.fn(async () => {
      throw Error("Synthetic disconnect");
    });
    vi.stubGlobal("fetch", requests);
    await expect(sdk.removeAdminExtension(entry.id, undefined, options)).rejects.toThrow();
    expect(requests).toHaveBeenCalledTimes(1);
  });
  it.each(["install", "install-preview"])(
    "keeps real admin, JSON parser, CSRF, floor and %s limiter precedence",
    async (operation) => {
      const invoke = (payload: unknown, headers = {}) =>
        app.inject({
          method: "POST",
          url: path(`/${operation}`),
          payload: JSON.stringify(payload),
          headers: { "content-type": "application/json", ...headers },
          remoteAddress: "198.51.100.12",
        });
      getSession.mockResolvedValue(null);
      expect((await invoke({ wrong: true })).statusCode).toBe(401);
      getSession.mockResolvedValue({ ...session, user: { ...session.user, role: "user" } });
      expect((await invoke({ wrong: true })).statusCode).toBe(403);
      getSession.mockResolvedValue(session);
      expect((await invoke({ wrong: true })).statusCode).toBe(400); // admitted invalid input spends original bucket
      const limited = await invoke({ id: entry.id });
      expect(limited.statusCode).toBe(429);
      expect(limited.headers["retry-after"]).toMatch(/^\d+$/);
      expect(limited.json()).toMatchObject({
        error: "Too many requests",
        retryAfter: expect.any(Number),
      });
      expect(resolve).not.toHaveBeenCalled();
      getSession.mockResolvedValue(null);
      expect((await invoke({ id: entry.id })).statusCode).toBe(401);
      getSession.mockResolvedValue(session);
      expect(
        (
          await app.inject({
            method: "POST",
            url: path("/install"),
            payload: "{",
            headers: { "content-type": "application/json" },
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await app.inject({
            method: "POST",
            url: path("/install"),
            payload: "{",
            headers: {
              cookie: "synthetic=1",
              origin: "https://evil.test",
              "content-type": "application/json",
            },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            method: "POST",
            url: path("/install"),
            payload: "x",
            headers: { "content-type": "application/x-synthetic" },
          })
        ).statusCode,
      ).toBe(415);
      expect((await invoke({ id: "x".repeat(5000) })).statusCode).toBe(413);
      floor.destroy();
      floor = new RateLimiter({ max: 1, windowMs: 60_000 });
      expect(
        (await app.inject({ url: path("/sources"), remoteAddress: "198.51.100.12" })).statusCode,
      ).toBe(200);
      getSession.mockResolvedValue(null);
      expect(
        (
          await app.inject({
            method: "POST",
            url: path("/install"),
            payload: "{",
            remoteAddress: "198.51.100.12",
            headers: { "content-type": "application/json" },
          })
        ).statusCode,
      ).toBe(429);
      expect(enqueue).not.toHaveBeenCalled();
    },
  );
  it("validates strict HTTP inputs and preserves optional absence/empty object while rejecting null", async () => {
    for (const [method, suffix, body] of [
      ["POST", "/install", {}],
      ["POST", "/install-preview", { id: "", manifestUrl: "" }],
      ["POST", "/install", { id: 1 }],
      ["POST", "/install", { id: entry.id, unknown: true }],
      ["POST", "/update/id", null],
      ["POST", "/update/id", { hostPortConfirmation: 1 }],
      ["DELETE", "/id", null],
      ["DELETE", "/id", { ignored: 1 }],
      ["POST", "/refresh-catalog", null],
      ["POST", "/sources", { url: "x", label: 1 }],
      ["DELETE", "/sources", { url: "x", ignored: 1 }],
    ] as const) {
      storeInstallLimit.reset();
      extensionPreviewLimit.reset();
      const response = await app.inject({
        method,
        url: path(suffix),
        payload: JSON.stringify(body),
        headers: { "content-type": "application/json" },
      });
      expect(response.statusCode, `${method} ${suffix} ${JSON.stringify(body)}`).toBe(400);
    }
    expect((await app.inject(path("/catalog?q=a&q=b"))).statusCode).toBe(400);
    expect((await app.inject(path("/catalog?ignored=1"))).statusCode).toBe(400);
    expect(enqueue).not.toHaveBeenCalled();
    for (const [method, suffix, status] of [
      ["POST", "/update/id", 202],
      ["DELETE", "/id", 202],
      ["POST", "/refresh-catalog", 200],
    ] as const) {
      for (const payload of [undefined, "{}"]) {
        storeInstallLimit.reset();
        extensionPreviewLimit.reset();
        expect(
          (
            await app.inject({
              method,
              url: path(suffix),
              ...(payload ? { payload, headers: { "content-type": "application/json" } } : {}),
            })
          ).statusCode,
        ).toBe(status);
      }
    }
  });
  it("passes real 401/403/429 envelopes through final SDK including retry headers", async () => {
    const sdk = await import("@openmapx/core/api-admin-sdk");
    const options = { client: client() };
    getSession.mockResolvedValue(null);
    expect(await sdk.listAdminExtensionSources(options)).toMatchObject({ status: 401 });
    getSession.mockResolvedValue({ ...session, user: { ...session.user, role: "user" } });
    expect(await sdk.listAdminExtensionSources(options)).toMatchObject({ status: 403 });
    getSession.mockResolvedValue(session);
    expect(await sdk.previewAdminExtensionInstall({ id: entry.id }, options)).toMatchObject({
      status: 200,
    });
    expect((await sdk.installAdminExtension({ id: entry.id }, options)).status).toBe(202);
    const limited = await sdk.installAdminExtension({ id: entry.id }, options);
    expect(limited).toMatchObject({
      status: 429,
      data: { error: "Too many requests", retryAfter: expect.any(Number) },
    });
    expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });
});
