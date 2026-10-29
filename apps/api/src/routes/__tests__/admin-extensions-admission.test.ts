import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { createApiClient } from "@openmapx/core";
import * as sdk from "@openmapx/core/api-admin-sdk";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { uniformErrorHandler } from "../../server-wiring";
import { mockAdminSession } from "../../test/auth";
import { storeInstallLimit } from "../../utils/rate-limit";
import { administrationSdkFetch } from "./helpers/administration-sdk-fetch";
import { extensionPreviewFixture } from "./helpers/extension-admin-fixtures";

const ports = vi.hoisted(() => ({
  provider: vi.fn(),
  enqueue: vi.fn(),
  preview: vi.fn(),
  persist: vi.fn(),
  session: vi.fn(),
  audit: vi.fn(),
  logs: [] as string[],
  cache: new Map<string, string>(),
}));
vi.mock("../../db", () => ({ db: {} }));
vi.mock("../../redis", () => ({
  redis: {
    get: async (key: string) => ports.cache.get(key) ?? null,
    setex: async () => "OK",
    eval: (...args: unknown[]) => ports.persist(...args),
  },
}));
vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));
vi.mock("@openmapx/core/server", async (original) => {
  const actual = await original<typeof import("@openmapx/core/server")>();
  return {
    ...actual,
    safeFetchJson: <T>(url: string, options = {}) =>
      actual.safeFetchJson<T>(url, { ...options, fetchImplementation: ports.provider }),
    safeFetchText: (url: string, options = {}) =>
      actual.safeFetchText(url, { ...options, fetchImplementation: ports.provider }),
  };
});
vi.mock("../../auth", () => ({ auth: { api: { getSession: () => ports.session() } } }));
vi.mock("../../services/extension-installer", () => ({
  previewExtensionInstall: (...a: unknown[]) => ports.preview(...a),
}));
vi.mock("../../services/job-runner", () => ({
  jobRunner: { enqueue: (...a: unknown[]) => ports.enqueue(...a) },
}));
vi.mock("../../utils/audit-log", () => ({ writeAuditLog: (...a: unknown[]) => ports.audit(...a) }));
vi.mock("../../services/service-registry", () => ({ getServiceRegistry: () => null }));

const manifest = {
  id: "safe-extension",
  name: "Safe extension",
  version: "2.0",
  integrations: [
    { id: "safe-integration", artifact: "https://example.test/a.tar.gz", sha256: "a".repeat(64) },
  ],
};
const url = "https://example.test/extension.json";
const sensitive =
  "https://sentinel-user:sentinel-password@example.test/sentinel-path?token=sentinel-query /sentinel-local/file";
let app: FastifyInstance;
let advisory: {
  removed?: { id: string; reason: string }[];
  critical?: { id: string; reason: string; maxVersion?: string }[];
};
function catalog(overrides = {}) {
  ports.cache.set(
    "extstore:catalog",
    JSON.stringify({
      entries: [{ ...manifest, manifest: url, trust: "community", ...overrides }],
      killSwitch: { removed: [], critical: [] },
    }),
  );
}
function options(peer = "198.51.100.31") {
  vi.stubGlobal("fetch", administrationSdkFetch(app, { remoteAddress: peer }));
  return { client: createApiClient({ baseUrl: "https://app.test" }) };
}
async function resetLimits() {
  storeInstallLimit.reset();
  // Dynamic lookup permits the RED run before the new bucket exists.
  const limits = await import("../../utils/rate-limit");
  if ("extensionPreviewLimit" in limits)
    (limits.extensionPreviewLimit as typeof storeInstallLimit).reset();
}
beforeEach(async () => {
  vi.resetAllMocks();
  ports.logs.length = 0;
  ports.cache.clear();
  advisory = {};
  vi.mocked(lookup).mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as never);
  ports.provider.mockImplementation(
    async (input: string) =>
      new Response(JSON.stringify(input === url ? manifest : advisory), {
        headers: { "content-type": "application/json" },
      }),
  );
  ports.enqueue.mockResolvedValue("synthetic-job");
  ports.preview.mockResolvedValue({
    ...extensionPreviewFixture,
    extension: { id: manifest.id, name: manifest.name, version: manifest.version },
  });
  ports.session.mockResolvedValue(mockAdminSession());
  catalog();
  await resetLimits();
  app = Fastify({
    logger: {
      stream: {
        write: (line: string) => {
          ports.logs.push(line);
        },
      },
    },
  });
  app.setErrorHandler(uniformErrorHandler);
  const { adminExtensionsRoute } = await import("../admin-extensions");
  await app.register(adminExtensionsRoute, { prefix: "/api" });
  await app.ready();
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await app.close();
});

describe("real resolver through extension routes and final SDK", () => {
  it("resolves an ordinary direct manifest by actual identity with community trust", async () => {
    const opts = options();
    expect(await sdk.previewAdminExtensionInstall({ manifestUrl: url }, opts)).toMatchObject({
      status: 200,
      data: { extension: { id: manifest.id }, sourceTrust: "community" },
    });
    const result = await sdk.installAdminExtension({ manifestUrl: url }, opts);
    expect(result).toMatchObject({ status: 202, data: { jobId: "synthetic-job" } });
    expect(ports.enqueue).toHaveBeenCalledWith(
      "extension.install",
      expect.objectContaining({ manifest, sourceUrl: url, sourceTrust: "community" }),
      expect.any(String),
    );
  });
  it("canonicalizes a direct manifest locator before fetch and enqueue", async () => {
    const supplied = "https://EXAMPLE.test:443/releases/../extension.json";
    const result = await sdk.installAdminExtension({ manifestUrl: supplied }, options());
    expect(result.status).toBe(202);
    expect(ports.provider.mock.calls[0]?.[0]).toBe(url);
    expect(ports.enqueue).toHaveBeenCalledWith(
      "extension.install",
      expect.objectContaining({ sourceUrl: url }),
      expect.any(String),
    );
  });
  it.each(["install", "update"])(
    "preview leaves immediate deliberate %s admission available",
    async (operation) => {
      vi.spyOn(Date, "now").mockReturnValue(1_000_000);
      const opts = options();
      expect((await sdk.previewAdminExtensionInstall({ id: manifest.id }, opts)).status).toBe(200);
      const previewAgain = await sdk.previewAdminExtensionInstall({ id: manifest.id }, opts);
      expect(previewAgain).toMatchObject({ status: 429, data: { retryAfter: 30 } });
      expect(previewAgain.headers.get("retry-after")).toBe("30");
      const accepted =
        operation === "install"
          ? await sdk.installAdminExtension({ id: manifest.id }, opts)
          : await sdk.updateAdminExtension(manifest.id, undefined, opts);
      expect(accepted.status).toBe(202);
      const limited = await sdk.updateAdminExtension(manifest.id, undefined, opts);
      expect(limited).toMatchObject({ status: 429, data: { retryAfter: 30 } });
      expect(limited.headers.get("retry-after")).toBe("30");
      expect(
        (await sdk.installAdminExtension({ id: manifest.id }, options("198.51.100.32"))).status,
      ).toBe(202);
      expect(
        (await sdk.previewAdminExtensionInstall({ id: manifest.id }, options("198.51.100.32")))
          .status,
      ).toBe(200);
      expect(ports.enqueue).toHaveBeenCalledTimes(2);
    },
  );
  it.each([undefined, "1.0", "2.0", "3.0", "10.0", "arbitrary-release"])(
    "blocks every critical entry regardless of maxVersion %s",
    async (maxVersion) => {
      advisory = {
        critical: [{ id: manifest.id, reason: sensitive, ...(maxVersion ? { maxVersion } : {}) }],
      };
      const opts = options();
      for (const selector of [{ id: manifest.id }, { manifestUrl: url }]) {
        await resetLimits();
        expect(await sdk.previewAdminExtensionInstall(selector, opts)).toMatchObject({
          status: 400,
          data: { error: "Extension flagged critical" },
        });
        await resetLimits();
        expect(await sdk.installAdminExtension(selector, opts)).toMatchObject({
          status: 400,
          data: { error: "Extension flagged critical" },
        });
      }
      await resetLimits();
      expect((await sdk.updateAdminExtension(manifest.id, undefined, opts)).status).toBe(400);
      expect(ports.enqueue).not.toHaveBeenCalled();
      expect(ports.preview).not.toHaveBeenCalled();
      expect((await sdk.removeAdminExtension(manifest.id, undefined, opts)).status).toBe(202);
      advisory = {};
      await resetLimits();
      expect((await sdk.updateAdminExtension(manifest.id, undefined, opts)).status).toBe(202);
    },
  );
  it("retains cached denials with stale feed data and permits a known clear stale snapshot", async () => {
    ports.cache.set(
      "extstore:revocations",
      JSON.stringify({
        removed: [],
        critical: [[manifest.id, { reason: "Synthetic cached advisory", maxVersion: "0" }]],
        fetchedAtMs: 1,
      }),
    );
    ports.provider.mockImplementation(async (input: string) => {
      if (input !== url) throw new Error("Synthetic feed unavailable");
      return new Response(JSON.stringify(manifest), {
        headers: { "content-type": "application/json" },
      });
    });
    const opts = options();
    expect(await sdk.updateAdminExtension(manifest.id, undefined, opts)).toMatchObject({
      status: 400,
      data: { error: "Extension flagged critical" },
    });
    expect(ports.enqueue).not.toHaveBeenCalled();
    ports.cache.set(
      "extstore:revocations",
      JSON.stringify({ removed: [], critical: [], fetchedAtMs: 1 }),
    );
    await resetLimits();
    expect((await sdk.updateAdminExtension(manifest.id, undefined, opts)).status).toBe(202);
  });
  it.each([
    "http://example.test/catalog",
    "https://user:password@example.test/catalog",
    "https://example.test/catalog?token=secret",
    "https://example.test/catalog#secret",
    "https://127.0.0.1/catalog",
  ])("keeps source URL admission safe: %s", async (sourceUrl) => {
    expect(
      await sdk.addAdminExtensionSource({ url: sourceUrl, label: "Synthetic" }, options()),
    ).toMatchObject({
      status: 400,
      data: { error: "Catalog source must use a public HTTPS URL without credentials" },
    });
    expect(ports.persist).not.toHaveBeenCalled();
    expect(ports.audit).not.toHaveBeenCalled();
  });
  it.each([
    "https://user@example.test/extension.json",
    "https://user:password@example.test/extension.json",
    "https://example.test/extension.json?token=secret",
    "https://example.test/extension.json#secret",
  ])("rejects a non-portable direct manifest locator before fetching: %s", async (manifestUrl) => {
    expect(await sdk.installAdminExtension({ manifestUrl }, options())).toMatchObject({
      status: 400,
      data: { error: "Invalid extension.json" },
    });
    expect(ports.provider).not.toHaveBeenCalled();
    expect(ports.enqueue).not.toHaveBeenCalled();
  });
  it.each(["https://evil.example.test/org/repo.git", "https://github.com:8443/org/repo.git"])(
    "rejects a service repository outside the Git allowlist: %s",
    async (repo) => {
      ports.provider.mockImplementation(
        async (input: string) =>
          new Response(
            JSON.stringify(
              input === url
                ? {
                    id: manifest.id,
                    name: manifest.name,
                    version: manifest.version,
                    services: [{ repo, service: "safe-service" }],
                  }
                : advisory,
            ),
            { headers: { "content-type": "application/json" } },
          ),
      );
      expect(await sdk.installAdminExtension({ manifestUrl: url }, options())).toMatchObject({
        status: 400,
        data: { error: "Invalid extension.json" },
      });
      expect(ports.enqueue).not.toHaveBeenCalled();
    },
  );
  it("rejects an unsafe catalog manifest locator before fetch or cache publication", async () => {
    const unsafeManifest = "https://example.test/extension.json?token=secret";
    ports.provider.mockResolvedValue(
      new Response(
        JSON.stringify({
          extensions: [{ id: manifest.id, name: manifest.name, manifest: unsafeManifest }],
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );

    expect(await sdk.refreshAdminExtensionCatalog(undefined, options())).toMatchObject({
      status: 500,
      data: { error: "Internal Server Error" },
    });
    expect(ports.provider.mock.calls.some(([input]) => input === unsafeManifest)).toBe(false);
    expect(ports.persist).not.toHaveBeenCalled();
    expect(ports.enqueue).not.toHaveBeenCalled();
  });
  it.each(["private", "redirect", "oversize", "invalid-manifest"])(
    "retains safe direct acquisition and validation for %s",
    async (kind) => {
      if (kind === "private")
        vi.mocked(lookup).mockResolvedValue([{ address: "10.0.0.1", family: 4 }] as never);
      if (kind === "redirect")
        ports.provider.mockResolvedValue(
          new Response(null, {
            status: 302,
            headers: { location: "http://169.254.169.254/metadata" },
          }),
        );
      if (kind === "oversize")
        ports.provider.mockResolvedValue(
          new Response("{}", {
            headers: { "content-length": "10000000000", "content-type": "application/json" },
          }),
        );
      if (kind === "invalid-manifest")
        ports.provider.mockResolvedValue(
          new Response(JSON.stringify({ ...manifest, id: "_direct" }), {
            headers: { "content-type": "application/json" },
          }),
        );
      expect((await sdk.installAdminExtension({ manifestUrl: url }, options())).status).toBe(400);
      expect(ports.enqueue).not.toHaveBeenCalled();
      if (kind === "private") expect(ports.provider).not.toHaveBeenCalled();
    },
  );
  it("keeps ID precedence and safe known missing, delisted and platform failures", async () => {
    const opts = options();
    expect(
      await sdk.installAdminExtension({ id: "missing", manifestUrl: url }, opts),
    ).toMatchObject({ status: 404, data: { error: "Extension not found" } });
    await resetLimits();
    expect(await sdk.updateAdminExtension("missing", undefined, opts)).toMatchObject({
      status: 400,
      data: { error: "Extension is not in any catalog source" },
    });
    advisory = { removed: [{ id: manifest.id, reason: sensitive }] };
    await resetLimits();
    expect(await sdk.installAdminExtension({ manifestUrl: url }, opts)).toMatchObject({
      status: 400,
      data: { error: "Extension delisted" },
    });
    advisory = {};
    catalog({ minPlatform: "9999.0" });
    await resetLimits();
    expect(await sdk.updateAdminExtension(manifest.id, undefined, opts)).toMatchObject({
      status: 400,
      data: { error: expect.stringContaining("platform") },
    });
    expect(ports.enqueue).not.toHaveBeenCalled();
    expect(ports.logs.join("")).not.toContain("sentinel-");
  });
  it.each(["id", "version", "digest", "verified-without-digest"])(
    "retains catalog %s binding",
    async (kind) => {
      catalog(
        kind === "id"
          ? { id: "different-id" }
          : kind === "version"
            ? { version: "wrong" }
            : kind === "digest"
              ? { manifestSha256: "b".repeat(64) }
              : { trust: "verified" },
      );
      expect(
        (
          await sdk.installAdminExtension(
            { id: kind === "id" ? "different-id" : manifest.id },
            options(),
          )
        ).status,
      ).toBe(400);
      expect(ports.enqueue).not.toHaveBeenCalled();
    },
  );
  it("keeps digest-bound verified admission and rejects direct self-declared trust", async () => {
    ports.provider.mockImplementation(
      async (input: string) =>
        new Response(
          JSON.stringify(input === url ? { ...manifest, trust: "verified" } : advisory),
          { headers: { "content-type": "application/json" } },
        ),
    );
    expect((await sdk.installAdminExtension({ manifestUrl: url }, options())).status).toBe(400);
    expect(ports.enqueue).not.toHaveBeenCalled();
    await resetLimits();
    const raw = manifest;
    ports.provider.mockImplementation(
      async (input: string) =>
        new Response(JSON.stringify(input === url ? raw : advisory), {
          headers: { "content-type": "application/json" },
        }),
    );
    expect((await sdk.installAdminExtension({ manifestUrl: url }, options())).status).toBe(202);
    expect(ports.enqueue.mock.calls[0][1].sourceTrust).toBe("community");
    await resetLimits();
    catalog({
      trust: "verified",
      manifestSha256: createHash("sha256").update(JSON.stringify(raw)).digest("hex"),
    });
    expect((await sdk.installAdminExtension({ id: manifest.id }, options())).status).toBe(202);
    expect(ports.enqueue.mock.calls[1][1].sourceTrust).toBe("verified");
  });
  it.each(["provider", "JSON", "staging", "Redis"])(
    "bounds %s failures and logs without reflecting dependency data",
    async (kind) => {
      if (kind === "provider") ports.provider.mockRejectedValue(new Error(sensitive));
      if (kind === "JSON")
        ports.provider.mockImplementation(
          async (input: string) =>
            new Response(input === url ? sensitive : "{}", {
              headers: { "content-type": "application/json" },
            }),
        );
      if (kind === "staging") ports.preview.mockRejectedValue(new Error(sensitive));
      if (kind === "Redis") ports.persist.mockRejectedValue(new Error(sensitive));
      const opts = options();
      const results = [];
      if (kind === "Redis")
        results.push(await sdk.addAdminExtensionSource({ url, label: "Synthetic" }, opts));
      else {
        results.push(await sdk.previewAdminExtensionInstall({ id: manifest.id }, opts));
        await resetLimits();
        results.push(await sdk.installAdminExtension({ id: manifest.id }, opts));
        await resetLimits();
        results.push(await sdk.updateAdminExtension(manifest.id, undefined, opts));
      }
      for (const result of results) {
        // Staging is only reached by preview; install can still queue.
        if (kind === "staging" && result.status === 202) continue;
        expect(result.status).toBe(400);
        expect(JSON.stringify(result.data)).not.toMatch(/sentinel-|example\.test|\/file/);
      }
      if (kind !== "Redis" && kind !== "staging") {
        expect(await sdk.getAdminExtensionCatalogEntry(manifest.id, opts)).toMatchObject({
          status: 200,
          data: { componentList: [] },
        });
      }
      expect(ports.logs.join("")).not.toMatch(/sentinel-|\/file/);
      expect(ports.logs.join("")).toContain("errorClass");
    },
  );
  it.each(["acquisition", "publication", "conflict"])(
    "failed catalog %s returns a safe SDK error without success audit",
    async (failure) => {
      const before = ports.cache.get("extstore:catalog");
      if (failure === "acquisition") ports.provider.mockRejectedValue(new Error(sensitive));
      else if (failure === "publication") ports.persist.mockRejectedValue(new Error(sensitive));
      else ports.persist.mockResolvedValue(0);
      const result = await sdk.refreshAdminExtensionCatalog(undefined, options());
      expect(result.status).toBe(500);
      expect(JSON.stringify(result.data)).not.toMatch(/sentinel-|example\.test|\/file/);
      expect(ports.cache.get("extstore:catalog")).toBe(before);
      expect(ports.audit).not.toHaveBeenCalled();
      expect(ports.persist).toHaveBeenCalledTimes(failure === "acquisition" ? 0 : 1);
    },
  );
  it.each([
    ["invalid JSON", "{"],
    ["scalar", "42"],
    ["null", "null"],
    ["wrong extensions", '{"extensions":"invalid"}'],
    ["false extensions", '{"extensions":false}'],
    ["null removed", '{"removed":null}'],
    ["empty critical", '{"critical":""}'],
    ["invalid control item", '{"critical":[{"id":"old","reason":42}]}'],
  ])(
    "malformed %s catalog cannot publish or audit refresh success through the final SDK",
    async (_name, body) => {
      const denied = JSON.stringify({
        entries: [{ id: "old", name: "Old" }],
        killSwitch: { removed: [["old", "delisted"]], critical: [["old", { reason: "security" }]] },
      });
      ports.provider.mockImplementation(
        async () => new Response(body, { headers: { "content-type": "application/json" } }),
      );
      // If malformed acquisition reaches the real helper's EVAL boundary, permit
      // publication so this regression fails on false success, not a fake error.
      ports.persist.mockImplementation(
        async (
          _script,
          _count,
          _sources,
          catalogKey,
          _sourcePresent,
          _sourceRaw,
          _catalogPresent,
          _catalogRaw,
          next,
        ) => {
          ports.cache.set(catalogKey, next);
          return 1;
        },
      );
      for (const cached of [true, false]) {
        if (cached) ports.cache.set("extstore:catalog", denied);
        else ports.cache.delete("extstore:catalog");
        const result = await sdk.refreshAdminExtensionCatalog(undefined, options());
        expect(result.status).toBe(500);
        expect(result.data).toEqual({ error: "Internal Server Error" });
        expect(ports.cache.get("extstore:catalog")).toBe(cached ? denied : undefined);
      }
      expect(ports.persist).not.toHaveBeenCalled();
      expect(ports.audit).not.toHaveBeenCalled();
      expect(ports.provider).toHaveBeenCalledTimes(2);
    },
  );
});
