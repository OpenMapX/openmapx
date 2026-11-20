import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindAdminOperation, bindAdminStreamOperation } from "./admin-sdk-transport";
import { createApiClient } from "./client";
import { ApiContractError } from "./sdk-transport";

const client = createApiClient({ baseUrl: "https://app.example", credentials: "include" });
beforeEach(() =>
  vi.stubGlobal("fetch", () => {
    throw new Error("Unexpected network");
  }),
);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe("administration registry binding", () => {
  it("binds extension acceptance to 202 and preserves absent optional update bodies", async () => {
    const acquire = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.body).toBeUndefined();
      expect(new Headers(init.headers).has("content-type")).toBe(false);
      return Response.json({ jobId: "extension-job" }, { status: 202 });
    });
    vi.stubGlobal("fetch", acquire);
    const update = bindAdminOperation("updateAdminExtension");
    await expect(
      update("/api/admin/extensions/update/a%2Fb", {
        client,
        method: "POST",
        headers: { "content-type": "application/json" },
      }),
    ).resolves.toMatchObject({ status: 202, data: { jobId: "extension-job" } });
    for (const response of [
      Response.json({ jobId: "extension-job" }),
      Response.json({ jobId: "" }, { status: 202 }),
      Response.json({ jobId: "extension-job", ok: true }, { status: 202 }),
    ]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
      await expect(
        update("/api/admin/extensions/update/a%2Fb", { client, method: "POST" }),
      ).rejects.toBeInstanceOf(ApiContractError);
    }
    expect(acquire).toHaveBeenCalledTimes(1);
  });
});

describe("administration EventSource targets", () => {
  it("builds a typed SSE target from the exact generated path without fetching or JSON parsing", async () => {
    const path = "/api/admin/jobs/a%2Fb/events?source=application&cursor=2";
    await expect(
      bindAdminStreamOperation("streamAdminActivityJobEvents")(path, { client }),
    ).resolves.toEqual({
      url: "https://app.example/api/admin/jobs/a%2Fb/events?source=application&cursor=2",
      withCredentials: true,
    });
    await expect(
      bindAdminOperation("streamAdminActivityJobEvents")(path, { client }),
    ).rejects.toThrow(/stream/);
    for (const wrong of [
      "https://evil.test/api/admin/jobs/a/events",
      "//evil.test/api/admin/jobs/a/events",
      "/api/admin/jobs/a/cancel",
      "/api/admin/jobs/a/events?source=data-manager",
    ])
      await expect(
        bindAdminStreamOperation("streamAdminActivityJobEvents")(wrong, { client }),
      ).rejects.toThrow();
  });
  it("rejects finite request options instead of ignoring controls on an EventSource target", async () => {
    const operation = bindAdminStreamOperation("streamAdminActivityJobEvents");
    for (const unsupported of [
      { timeoutMs: 100 },
      { body: "secret payload" },
      { cache: "no-store" },
      { mode: "same-origin" },
      { credentials: "include" },
      { maxJsonBytes: 10 },
      { maxTextBytes: 10 },
      { maxErrorBytes: 10 },
      { onTextChunk: () => {} },
      { integrity: "secret integrity" },
      { keepalive: true },
      { referrer: "secret referrer" },
      { referrerPolicy: "no-referrer" },
      { redirect: "error" },
      { unknown: "secret option" },
    ]) {
      const error = await operation("/api/admin/jobs/a/events", {
        client,
        ...unsupported,
      } as never).catch((caught) => caught);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toMatch(/unsupported/i);
      expect(String(error)).not.toContain("secret");
      expect(JSON.stringify(error)).not.toContain("secret");
    }
  });
  it("uses the signal only to guard target construction and leaves browser lifetime ownership explicit", async () => {
    const operation = bindAdminStreamOperation("streamAdminActivityJobEvents");
    const abort = new AbortController();
    const target = await operation("/api/admin/jobs/a/events", {
      client,
      signal: abort.signal,
      method: "GET",
      headers: {},
    });
    abort.abort();
    expect(target).toEqual({
      url: "https://app.example/api/admin/jobs/a/events",
      withCredentials: true,
    });
    await expect(
      operation("/api/admin/jobs/a/events", { client, signal: abort.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
  it("rejects EventSource credential/header modes that native EventSource cannot honor", async () => {
    const operation = bindAdminStreamOperation("streamAdminActivityJobEvents");
    for (const unsupported of [
      createApiClient({ baseUrl: "https://app.example", credentials: "omit" }),
      createApiClient({
        baseUrl: "https://app.example",
        credentials: "include",
        headerInterceptor: () => ({ Authorization: "secret" }),
      }),
    ]) {
      const error = await operation("/api/admin/jobs/a/events", { client: unsupported }).catch(
        (e) => e,
      );
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain("secret");
    }
    await expect(
      operation("/api/admin/jobs/a/events", {
        client,
        headers: { Authorization: "secret" },
      } as never),
    ).rejects.toThrow(/headers/);
    await expect(
      operation("/api/admin/jobs/a/events", { client, method: "POST" } as never),
    ).rejects.toThrow(/bound operation/);
  });
});

describe("administration native download targets", () => {
  it("generated native targets validate UUID params and refuse unsupported headers without fetch", async () => {
    const { getDownloadAdminArtifactTransferContentTarget } = await import(
      "./generated/admin/service-admin.generated"
    );
    vi.stubGlobal("window", { location: { origin: "https://app.example" } });
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const client = createApiClient({ baseUrl: "https://app.example", credentials: "include" });
    const stageId = "91a78b3e-208b-4ba4-9ddf-870fbdf1da22";
    expect(await getDownloadAdminArtifactTransferContentTarget(stageId, { client })).toEqual({
      url: `https://app.example/api/admin/artifact-transfers/${stageId}/content`,
      ownership: "browser",
    });
    await expect(
      getDownloadAdminArtifactTransferContentTarget("invalid", { client }),
    ).rejects.toThrow();
    await expect(
      getDownloadAdminArtifactTransferContentTarget(stageId, {
        client,
        headers: { Authorization: "not-supported" } as never,
      }),
    ).rejects.toMatchObject({ reason: "headers" });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("pending integration family operation binding", () => {
  it("validates every declared integration operation through its bound wire path", async () => {
    const { integrationAdminOperations } = await import("./contracts/integration-admin");
    let calls = 0;
    for (const [id, operation] of Object.entries(integrationAdminOperations)) {
      const path = operation.path.replace(/:[^/]+/g, "sample");
      vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
        if (url !== `https://app.example${path}` || init.method !== operation.method)
          throw new Error("Unexpected network");
        calls++;
        return Response.json({ error: "Synthetic rejection" }, { status: 400 });
      });
      const result = await bindAdminOperation(id as keyof typeof integrationAdminOperations)(path, {
        client,
        method: operation.method,
        headers: { "idempotency-key": "synthetic-intent-0001" },
      });
      expect(result).toMatchObject({ status: 400, data: { error: "Synthetic rejection" } });
    }
    expect(calls).toBeGreaterThan(0);
    expect(calls).toBe(Object.keys(integrationAdminOperations).length);
  });
  it("retains domain errors and vault hints and requires Retry-After without exposing malformed bodies", async () => {
    const cases = [
      {
        id: "patchAdminIntegrationConfig",
        path: "/api/admin/integrations/sample/config",
        method: "PATCH",
        status: 400,
        data: { error: "Invalid configuration", errors: ["Invalid field"] },
      },
      {
        id: "setAdminIntegrationCredential",
        path: "/api/admin/credentials/sample/apiKey",
        method: "PUT",
        status: 503,
        data: { error: "Vault unavailable", hint: "Configure vault" },
      },
      {
        id: "runAdminIntegrationHealthChecks",
        path: "/api/admin/integrations/health/run",
        method: "POST",
        status: 429,
        data: { error: "Limited", retryAfter: 10 },
      },
    ] as const;
    for (const entry of cases) {
      vi.stubGlobal("fetch", async (url: string) => {
        if (url !== `https://app.example${entry.path}`) throw new Error("Unexpected network");
        return Response.json(entry.data, {
          status: entry.status,
          headers: entry.status === 429 ? { "retry-after": "10" } : {},
        });
      });
      expect(
        await bindAdminOperation(entry.id)(entry.path, {
          client,
          method: entry.method,
          headers: { "idempotency-key": "synthetic-intent-0001" },
        }),
      ).toMatchObject({ status: entry.status, data: entry.data });
    }
    vi.stubGlobal("fetch", async () =>
      Response.json({ error: "Limited", retryAfter: 10 }, { status: 429 }),
    );
    await expect(
      bindAdminOperation("runAdminIntegrationHealthChecks")("/api/admin/integrations/health/run", {
        client,
        method: "POST",
      }),
    ).rejects.toBeInstanceOf(ApiContractError);
    vi.stubGlobal("fetch", async () => Response.json({ value: "forbidden" }, { status: 503 }));
    const error = await bindAdminOperation("setAdminIntegrationCredential")(
      "/api/admin/credentials/sample/apiKey",
      { client, method: "PUT", headers: { "idempotency-key": "synthetic-intent-0001" } },
    ).catch((error) => error);
    expect(error).toBeInstanceOf(ApiContractError);
    expect(String(error)).not.toContain("forbidden");
  });
});
