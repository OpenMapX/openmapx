import { ApiClientError, createApiClient } from "@openmapx/core";
import { useQuery } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { job } from "@/components/admin/activity/__tests__/fixtures";
import { act, cleanup, createTestQueryClient, renderHookWithQuery, waitFor } from "@/test";
import {
  integrationAdminQueries,
  useIntegrationAdmin,
  useIntegrationReload,
} from "./integrationAdmin";

let apiUrl = "http://admin.test";
vi.mock("@/integration-api/runtime/EnvProvider", () => ({ useEnv: () => ({ apiUrl }) }));
const clients: ReturnType<typeof createTestQueryClient>[] = [];
function client() {
  const result = createTestQueryClient();
  result.setDefaultOptions({ queries: { retry: false, gcTime: Infinity } });
  clients.push(result);
  return result;
}
function pending<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function fakeFetch(handler: (path: string, init: RequestInit) => Response | Promise<Response>) {
  const requests: { path: string; init: RequestInit }[] = [];
  vi.stubGlobal("fetch", (input: string, init: RequestInit) => {
    const url = new URL(input);
    if (!["http://admin.test", "http://second.test"].includes(url.origin))
      throw new Error("Public network denied");
    expect(init.credentials).toBe("include");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    requests.push({ path: url.pathname, init });
    return handler(url.pathname, init);
  });
  return requests;
}
const cachedKeys = (origin = apiUrl) => [
  ["admin", "integrations", origin, "detail", "demo"],
  ["admin", "credentials", origin],
  ["admin", "overview", origin],
  ["integrations", origin],
];
beforeEach(() => {
  apiUrl = "http://admin.test";
});
afterEach(() => {
  cleanup();
  for (const c of clients.splice(0)) c.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("integration query boundaries and reload observation", () => {
  it.each(["patch", "set", "delete", "enable", "disable", "import"] as const)(
    "sends the generated %s body and retained header in their actual positions",
    async (kind) => {
      const requests = fakeFetch(() =>
        Response.json({ error: "Request rejected" }, { status: 400 }),
      );
      const qc = client(),
        { result } = renderHookWithQuery(useIntegrationAdmin, { queryClient: qc });
      await act(async () => {
        const run = {
          patch: () => result.current.patchConfig("demo", { endpoint: "synthetic" }),
          set: () => result.current.setCredential("demo", "TOKEN", "synthetic-private"),
          delete: () => result.current.deleteCredential("demo", "TOKEN"),
          enable: () => result.current.toggle("demo", true),
          disable: () => result.current.toggle("demo", false),
          import: () =>
            result.current.importConfigs({
              integrations: [{ integrationId: "demo", config: { endpoint: "synthetic" } }],
            }),
        };
        await expect(run[kind]()).rejects.toThrow();
      });
      expect(requests).toHaveLength(1);
      const init = requests[0]!.init;
      expect(new Headers(init.headers).get("idempotency-key")).toMatch(
        /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/,
      );
      if (["patch", "set", "import"].includes(kind))
        expect(JSON.parse(String(init.body))).toEqual(
          kind === "patch"
            ? { endpoint: "synthetic" }
            : kind === "set"
              ? { value: "synthetic-private" }
              : { integrations: [{ integrationId: "demo", config: { endpoint: "synthetic" } }] },
        );
    },
  );
  it("keeps full raw manifest and canonical config values without response casts", async () => {
    const manifest = {
      id: "demo",
      domains: ["geocoding"],
      custom: { raw: [1, { future: true }] },
      configSchema: { type: "object", properties: { arbitrary: { future: [1, false] } } },
    };
    fakeFetch((path) => {
      expect(path).toBe("/api/admin/integrations/demo");
      return Response.json({
        id: "demo",
        name: "Demo",
        domains: ["geocoding"],
        quality: "built-in",
        isBuiltIn: true,
        blockedCode: false,
        enabled: true,
        configured: true,
        hasHealthCheck: false,
        health: null,
        dependencies: [],
        requires: [],
        infrastructure: null,
        manifest,
        dependencyStatus: [],
        credentialStatus: [],
        secretsConfigured: true,
        resolvedConfig: { endpoint: { source: "config.json", value: { nested: [false, 2] } } },
      });
    });
    const qc = client();
    const data = await qc.fetchQuery(
      integrationAdminQueries(
        createApiClient({ baseUrl: apiUrl, credentials: "include" }),
        apiUrl,
      ).detail("demo"),
    );
    expect(data.manifest).toEqual(manifest);
    expect(data.resolvedConfig.endpoint).toEqual({
      source: "config.json",
      value: { nested: [false, 2] },
    });
  });

  it.each([
    "list",
    "detail",
    "envVars",
    "bindings",
    "healthHistory",
    "health",
    "credentials",
    "overview",
    "exportConfigs",
  ] as const)("keeps the finite %s deadline through body consumption", async (read) => {
    vi.useFakeTimers();
    let canceled = false;
    const requests = fakeFetch(
      () =>
        new Response(
          new ReadableStream({
            cancel: () => {
              canceled = true;
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    const qc = client();
    const queries = integrationAdminQueries(
      createApiClient({ baseUrl: apiUrl, credentials: "include" }),
      apiUrl,
    );
    const runRead = () => {
      switch (read) {
        case "list":
          return qc.fetchQuery(queries.list());
        case "detail":
          return qc.fetchQuery(queries.detail("demo /id"));
        case "envVars":
          return qc.fetchQuery(queries.envVars());
        case "bindings":
          return qc.fetchQuery(queries.bindings("demo /id"));
        case "health":
          return qc.fetchQuery(queries.health("demo /id"));
        case "healthHistory":
          return qc.fetchQuery(queries.healthHistory("demo /id", 168));
        case "credentials":
          return qc.fetchQuery(queries.credentials());
        case "overview":
          return qc.fetchQuery(queries.overview());
        case "exportConfigs":
          return qc.fetchQuery(queries.exportConfigs());
      }
    };
    const pendingRead = runRead();
    const rejected = expect(pendingRead).rejects.toThrow("Integration request failed");
    await vi.advanceTimersByTimeAsync(29_999);
    expect(requests[0].init.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(requests[0].init.signal?.aborted).toBe(true);
    expect(canceled).toBe(true);
    if (["detail", "bindings", "healthHistory"].includes(read))
      expect(requests[0].path).toContain("demo%20%2Fid");
  });

  it("retains declared HTTP status and Retry-After evidence without serializing its body", async () => {
    fakeFetch((path) => {
      expect(path).toBe("/api/admin/overview");
      return Response.json(
        { error: "Too many requests", retryAfter: 7 },
        { status: 429, headers: { "Retry-After": "7" } },
      );
    });
    const qc = client();
    const failure = await qc
      .fetchQuery(
        integrationAdminQueries(
          createApiClient({ baseUrl: apiUrl, credentials: "include" }),
          apiUrl,
        ).overview(),
      )
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) throw new Error("Expected request failure");
    expect(failure.message).toBe("Too many requests");
    expect(failure.cause).toBeInstanceOf(ApiClientError);
    expect(failure.cause).toMatchObject({ status: 429, retryAfterSeconds: 7 });
    expect(JSON.stringify(failure)).not.toContain("Too many requests");
  });

  it("aborts an unmounted read during body consumption and rejects malformed payloads", async () => {
    let canceled = false;
    const requests = fakeFetch(
      () =>
        new Response(
          new ReadableStream({
            cancel: () => {
              canceled = true;
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    const qc = client();
    const { unmount } = renderHookWithQuery(
      () => {
        const admin = useIntegrationAdmin();
        return useQuery(admin.queries.list());
      },
      { queryClient: qc },
    );
    await waitFor(() => expect(requests).toHaveLength(1));
    unmount();
    await waitFor(() => expect(canceled).toBe(true));
    expect(requests[0].init.signal?.aborted).toBe(true);
    const malformedRequests = fakeFetch(() =>
      Response.json({ error: "synthetic-private-payload", integrations: [] }),
    );
    const malformed = await qc
      .fetchQuery(
        integrationAdminQueries(
          createApiClient({ baseUrl: apiUrl, credentials: "include" }),
          apiUrl,
        ).list(),
      )
      .catch((error: unknown) => error);
    expect(malformedRequests).toHaveLength(1);
    expect(malformed).toBeInstanceOf(Error);
    if (!(malformed instanceof Error)) throw new Error("Expected contract failure");
    expect(malformed.message).toBe("Integration request failed");
    expect(malformed.cause).toMatchObject({ name: "ApiContractError", status: 200 });
    expect(malformed.message).not.toContain("synthetic-private-payload");
    expect(qc.getQueryData(["admin", "integrations", apiUrl, "list"])).toBeUndefined();
  });

  it.each([403, 200])(
    "rejects failed/malformed reload acknowledgement HTTP %s without observing or retrying",
    async (status) => {
      const requests = fakeFetch((path) => {
        expect(path).toBe("/api/admin/integrations/reload");
        return Response.json(
          status === 403
            ? { error: "Reload denied" }
            : { ok: true, jobId: null, private: "hidden" },
          { status },
        );
      });
      const qc = client();
      qc.setDefaultOptions({ queries: { retry: false }, mutations: { retry: 2, retryDelay: 1 } });
      const { result } = renderHookWithQuery(() => useIntegrationReload(), { queryClient: qc });
      await act(async () => {
        await expect(result.current.mutateAsync()).rejects.toThrow(
          status === 403 ? "Reload denied" : "Integration request failed",
        );
      });
      expect(requests).toHaveLength(1);
      expect(qc.getQueryCache().findAll({ queryKey: ["admin", "jobs"] })).toHaveLength(0);
    },
  );

  it("polls through running and cancel_pending to a terminal result and stops", async () => {
    vi.useFakeTimers();
    let reads = 0;
    const requests = fakeFetch((path) => {
      if (path === "/api/admin/integrations/demo/reload")
        return Response.json({ ok: true, jobId: "job-1" });
      expect(path).toBe("/api/admin/jobs/job-1");
      reads += 1;
      return Response.json(
        job({
          status: reads === 1 ? "running" : reads === 2 ? "cancel_pending" : "canceled",
          cancelable: reads === 1,
        }),
      );
    });
    const qc = client();
    for (const key of cachedKeys()) qc.setQueryData(key, {});
    const { result } = renderHookWithQuery(() => useIntegrationReload("demo"), { queryClient: qc });
    await act(async () => {
      await result.current.mutateAsync();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(reads).toBe(1);
    for (const key of cachedKeys()) expect(qc.getQueryState(key)?.isInvalidated).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(reads).toBe(2);
    for (const key of cachedKeys()) expect(qc.getQueryState(key)?.isInvalidated).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    for (const key of cachedKeys()) expect(qc.getQueryState(key)?.isInvalidated).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(reads).toBe(3);
    expect(requests.every(({ init }) => init.method === "GET" || init.method === "POST")).toBe(
      true,
    );
  });

  it("does not refresh for a different job ID or malformed terminal payload", async () => {
    let malformed = false;
    fakeFetch((path) =>
      path.endsWith("/reload")
        ? Response.json({ ok: true, jobId: "job-1" })
        : Response.json(
            malformed
              ? { id: "job-1", status: "success" }
              : job({ id: "other-job", status: "success" }),
          ),
    );
    const qc = client();
    for (const key of cachedKeys()) qc.setQueryData(key, {});
    const { result } = renderHookWithQuery(() => useIntegrationReload(), { queryClient: qc });
    await act(async () => {
      await result.current.mutateAsync();
    });
    await waitFor(() =>
      expect(
        qc.getQueryState(["admin", "jobs", "detail", apiUrl, "application", "job-1"])?.status,
      ).toBe("error"),
    );
    for (const key of cachedKeys()) expect(qc.getQueryState(key)?.isInvalidated).toBe(false);
    malformed = true;
    await act(async () => {
      await qc.refetchQueries({ queryKey: ["admin", "jobs"] });
    });
    for (const key of cachedKeys()) expect(qc.getQueryState(key)?.isInvalidated).toBe(false);
  });

  it.each(["unmount", "origin"])(
    "ignores a late terminal response after %s without canceling the host",
    async (change) => {
      const response = pending<Response>();
      const requests = fakeFetch((path) => {
        if (path.endsWith("/reload")) return Response.json({ ok: true, jobId: "job-1" });
        expect(path).toBe("/api/admin/jobs/job-1");
        return response.promise;
      });
      const qc = client();
      for (const key of [...cachedKeys(), ...cachedKeys("http://second.test")])
        qc.setQueryData(key, {});
      const { result, unmount, rerender } = renderHookWithQuery(() => useIntegrationReload(), {
        queryClient: qc,
      });
      await act(async () => {
        await result.current.mutateAsync();
      });
      await waitFor(() => expect(requests).toHaveLength(2));
      if (change === "unmount") unmount();
      else {
        apiUrl = "http://second.test";
        rerender();
      }
      expect(requests[1].init.signal?.aborted).toBe(true);
      await act(async () => {
        response.resolve(Response.json(job({ status: "success", cancelable: false })));
      });
      for (const key of [...cachedKeys("http://admin.test"), ...cachedKeys("http://second.test")])
        expect(qc.getQueryState(key)?.isInvalidated).toBe(false);
      expect(requests).toHaveLength(2);
      expect(requests.some(({ path }) => path.includes("cancel"))).toBe(false);
    },
  );

  it("does not adopt a late reload acknowledgement into a replacement origin", async () => {
    const acknowledgement = pending<Response>();
    const requests = fakeFetch((path) => {
      if (path === "/api/admin/integrations/reload") return acknowledgement.promise;
      throw new Error(`Unexpected replacement-origin observation: ${path}`);
    });
    const qc = client();
    const { result, rerender } = renderHookWithQuery(() => useIntegrationReload(), {
      queryClient: qc,
    });
    let mutation!: Promise<unknown>;
    await act(async () => {
      mutation = result.current.mutateAsync();
    });
    await waitFor(() => expect(requests).toHaveLength(1));
    apiUrl = "http://second.test";
    rerender();
    await act(async () => {
      acknowledgement.resolve(Response.json({ ok: true, jobId: "job-old-origin" }));
      await mutation;
    });
    expect(requests).toHaveLength(1);
    expect(
      qc.getQueryState([
        "admin",
        "jobs",
        "detail",
        "http://second.test",
        "application",
        "job-old-origin",
      ]),
    ).toBeUndefined();
  });

  it("observes concurrent accepted jobs independently rather than replacing the older job", async () => {
    let accepted = 0;
    const responses = [pending<Response>(), pending<Response>()];
    const requests = fakeFetch((path) => {
      if (path.endsWith("/reload")) return Response.json({ ok: true, jobId: `job-${++accepted}` });
      if (path === "/api/admin/jobs/job-1") return responses[0].promise;
      if (path === "/api/admin/jobs/job-2") return responses[1].promise;
      throw new Error(`Unexpected request ${path}`);
    });
    const qc = client();
    const { result } = renderHookWithQuery(() => useIntegrationReload(), { queryClient: qc });
    await act(async () => {
      await result.current.mutateAsync();
    });
    await act(async () => {
      await result.current.mutateAsync();
    });
    await waitFor(() => expect(requests).toHaveLength(4));
    for (const key of cachedKeys()) qc.setQueryData(key, {});
    await act(async () => {
      responses[0].resolve(Response.json(job({ status: "failed", cancelable: false })));
    });
    await waitFor(() => expect(qc.getQueryState(cachedKeys()[0])?.isInvalidated).toBe(true));
    for (const key of cachedKeys()) qc.setQueryData(key, {});
    await act(async () => {
      responses[1].resolve(
        Response.json(job({ id: "job-2", status: "success", cancelable: false })),
      );
    });
    await waitFor(() => expect(qc.getQueryState(cachedKeys()[0])?.isInvalidated).toBe(true));
  });
});
