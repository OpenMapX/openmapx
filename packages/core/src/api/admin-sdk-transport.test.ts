import { afterEach, describe, expect, it, vi } from "vitest";
import { adminErrorMessage, bindAdminOperation, unwrapAdminResponse } from "./admin-sdk-transport";
import { ApiClientError, createApiClient } from "./client";
import { ApiContractError } from "./sdk-transport";

const client = createApiClient({ baseUrl: "https://app.example", credentials: "include" });
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe("canonical administration SDK acquisition", () => {
  it("rejects malformed successes through the operation closure despite forged validator/status options", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetch);
    await expect(
      bindAdminOperation("getApiDataManagerTransitState")("/api/data-manager/transit/state", {
        client,
        operationId: "postApiAdminAmbientPlacesRollback",
        schema: { safeParse: () => ({ success: true, data: {} }) },
        declaredStatuses: [200],
        acceptedStatuses: [200],
      } as never),
    ).rejects.toBeInstanceOf(ApiContractError);
    expect(fetch.mock.calls[0]?.[1]).not.toHaveProperty("operationId");
    expect(fetch.mock.calls[0]?.[1]).not.toHaveProperty("schema");
  });
  it("preserves declared conflict and absence states, cookies and client scope", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ error: "absent" }, { status: 404 }))
      .mockResolvedValueOnce(
        Response.json({ ok: false, reason: "in-flight", existingJobId: "job" }, { status: 409 }),
      );
    vi.stubGlobal("fetch", fetch);
    const absent = await bindAdminOperation("getApiDataManagerSearchIndexStatus")<{
      status: 404;
      headers: Headers;
      data: { error: string };
    }>("/api/data-manager/search-index/status", { client });
    expect(absent.status).toBe(404);
    expect(fetch.mock.calls[0]?.[0]).toBe(
      "https://app.example/api/data-manager/search-index/status",
    );
    expect(fetch.mock.calls[0]?.[1].credentials).toBe("include");
    const conflict = await bindAdminOperation("postApiDataManagerTransitSync")<{
      status: 409;
      headers: Headers;
      data: unknown;
    }>("/api/data-manager/transit/sync", { client, method: "POST", body: "{}" });
    expect(conflict.status).toBe(409);
    expect(() => unwrapAdminResponse(conflict)).toThrow(ApiClientError);
  });
  it.each([
    Response.json({ secret: "never-log" }, { status: 409 }),
    new Response("never-log", { headers: { "content-type": "text/html" } }),
    Response.json({ ok: true }, { status: 201 }),
  ])(
    "rejects malformed errors, wrong media and undeclared success without leaking bodies",
    async (response) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
      const error = await bindAdminOperation("postApiDataManagerTransitSync")(
        "/api/data-manager/transit/sync",
        { client, method: "POST" },
      ).catch((error) => error);
      expect(error).toBeInstanceOf(ApiContractError);
      expect(String(error)).not.toContain("never-log");
      expect(JSON.stringify(error)).not.toContain("never-log");
    },
  );
  it("bounds declared error and success bodies and releases their readers", async () => {
    for (const status of [200, 404]) {
      let canceled = false;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"error":"too large"}'));
        },
        cancel() {
          canceled = true;
        },
      });
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue(
            new Response(body, { status, headers: { "content-type": "application/json" } }),
          ),
      );
      await expect(
        bindAdminOperation("getApiDataManagerSearchIndexStatus")(
          "/api/data-manager/search-index/status",
          { client, maxJsonBytes: 4, maxErrorBytes: 4 },
        ),
      ).rejects.toBeInstanceOf(ApiContractError);
      expect(canceled).toBe(true);
      expect(body.locked).toBe(false);
    }
  });
  it("returns safe structured HTTP errors and exposes messages only by deliberate display helper", () => {
    const response = {
      status: 429 as const,
      headers: new Headers({ "retry-after": "30" }),
      data: { error: "wait", retryAfter: 30 },
    };
    let failure: unknown;
    try {
      unwrapAdminResponse(response);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ status: 429, retryAfterSeconds: 30 });
    expect(JSON.stringify(failure)).not.toContain('"wait"');
    expect(adminErrorMessage(failure, "fallback")).toBe("wait");
    expect(adminErrorMessage(new Error("private detail"), "fallback")).toBe("fallback");
  });
  it.each(["timeout", "aborted"] as const)(
    "keeps %s active through actual SDK bounded body consumption",
    async (mode) => {
      vi.useFakeTimers();
      let canceled = false;
      const body = new ReadableStream<Uint8Array>({
        cancel() {
          canceled = true;
        },
      });
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue(
            new Response(body, { headers: { "content-type": "application/json" } }),
          ),
      );
      const observer = new AbortController();
      const outcome = bindAdminOperation("getApiDataManagerTransitState")(
        "/api/data-manager/transit/state",
        { client, signal: observer.signal, ...(mode === "timeout" ? { timeoutMs: 10 } : {}) },
      ).catch((error) => error);
      await vi.advanceTimersByTimeAsync(0);
      if (mode === "timeout") await vi.advanceTimersByTimeAsync(11);
      else observer.abort();
      expect(await outcome).toMatchObject({ name: "ApiRequestAbortedError", code: mode });
      expect(canceled).toBe(true);
      expect(body.locked).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it("rejects operation URL substitution and non-finite budgets before acquisition", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(
      bindAdminOperation("getApiDataManagerTransitState")("/api/data-manager/transit/jobs", {
        client,
      }),
    ).rejects.toThrow(/bound operation/);
    await expect(
      bindAdminOperation("getApiDataManagerTransitState")("/api/data-manager/transit/state", {
        client,
        maxJsonBytes: Number.POSITIVE_INFINITY,
      }),
    ).rejects.toThrow(/limits/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects unexpected error statuses without exposing an unvalidated display payload", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(Response.json({ error: "private upstream details" }, { status: 418 })),
    );
    const error = await bindAdminOperation("getApiDataManagerTransitState")(
      "/api/data-manager/transit/state",
      { client },
    ).catch((error) => error);
    expect(error).toBeInstanceOf(ApiContractError);
    expect(adminErrorMessage(error, "fallback")).toBe("fallback");
    expect(JSON.stringify(error)).not.toContain("private upstream");
  });
  it("rejects an undeclared status without waiting for its untrusted body", async () => {
    vi.useFakeTimers();
    let canceled = false;
    let close = () => {};
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        close = () => controller.close();
      },
      cancel() {
        canceled = true;
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(body, {
          status: 418,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const outcome = bindAdminOperation("getApiDataManagerTransitState")(
      "/api/data-manager/transit/state",
      { client, timeoutMs: 10 },
    ).catch((error) => error);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(canceled).toBe(true);
      expect(body.locked).toBe(false);
      expect(await outcome).toBeInstanceOf(ApiContractError);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      if (!canceled) close();
      await outcome;
    }
  });
});

describe("pending integration family operation binding", () => {
  it("validates all35canonical operation closures before final producer generation", async () => {
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
    expect(calls).toBe(35);
  });
  it("retains domain errors and vault hints and requires Retry-After without exposing malformed bodies", async () => {
    const cases = [
      {
        id: "patchAdminIntegrationConfig",
        path: "/api/admin/integrations/sample/config",
        method: "PATCH",
        status: 400,
        data: { errors: ["Invalid field"] },
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
