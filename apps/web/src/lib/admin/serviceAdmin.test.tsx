import { createApiClient } from "@openmapx/core";
import { useQuery } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, createTestQueryClient, renderHookWithQuery, waitFor } from "@/test";
import { invalidateServiceAdministration, serviceAdminQueries } from "./serviceAdmin";

let apiUrl = "http://admin.test";
vi.mock("@/integration-api/runtime/EnvProvider", () => ({ useEnv: () => ({ apiUrl }) }));
const clients: ReturnType<typeof createTestQueryClient>[] = [];
function cache() {
  const qc = createTestQueryClient();
  clients.push(qc);
  return qc;
}
function queries(origin = apiUrl) {
  return serviceAdminQueries(createApiClient({ baseUrl: origin, credentials: "include" }), origin);
}
const reads = [
  "list",
  "detail",
  "config",
  "credentials",
  "selection",
  "backups",
  "data",
  "policy",
  "operations",
  "compose",
  "deployment",
  "dawarich",
] as const;
function read(q: ReturnType<typeof queries>, name: (typeof reads)[number]) {
  switch (name) {
    case "detail":
      return q.detail("selection /id");
    case "config":
      return q.config("selection /id");
    case "credentials":
      return q.credentials("selection /id");
    default:
      return q[name]();
  }
}
beforeEach(() => {
  apiUrl = "http://admin.test";
});
afterEach(() => {
  cleanup();
  for (const qc of clients.splice(0)) qc.clear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe("service administration query acquisition", () => {
  it.each(reads)(
    "bounds %s body acquisition to 30 seconds and cancels the reader",
    async (name) => {
      vi.useFakeTimers();
      let canceled = false;
      let signal: AbortSignal | undefined;
      vi.stubGlobal("fetch", (_url: string, init: RequestInit) => {
        signal = init.signal ?? undefined;
        expect(init.credentials).toBe("include");
        return new Response(
          new ReadableStream({
            cancel() {
              canceled = true;
            },
          }),
          { headers: { "content-type": name === "compose" ? "text/yaml" : "application/json" } },
        );
      });
      const qc = cache();
      // Heterogeneous query result types do not affect execution.
      const options = read(queries(), name);
      if (!options.queryFn) throw new Error("Missing query function");
      const pending = options.queryFn({
        signal: new AbortController().signal,
        queryKey: options.queryKey,
        client: qc,
        meta: undefined,
      });
      const rejected = expect(pending).rejects.toThrow("Service request failed");
      await vi.advanceTimersByTimeAsync(29_999);
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await rejected;
      expect(signal?.aborted).toBe(true);
      expect(canceled).toBe(true);
    },
  );
  it("separates every resource by origin, and reserved service IDs from subresources", async () => {
    const first = queries();
    const second = queries("http://second.test");
    for (const name of reads)
      expect(read(first, name).queryKey).not.toEqual(read(second, name).queryKey);
    const keys = [
      first.list(),
      first.selection(),
      first.data(),
      first.backups(),
      first.detail("selection"),
      first.detail("data"),
      first.detail("backups"),
      first.config("selection"),
      first.credentials("selection"),
    ].map((q) => JSON.stringify(q.queryKey));
    expect(new Set(keys).size).toBe(keys.length);
    vi.stubGlobal("fetch", (url: string) =>
      Response.json({
        services: [],
        summary: { running: 0, stopped: 0, total: url.startsWith(apiUrl) ? 1 : 2 },
      }),
    );
    const qc = cache();
    expect((await qc.fetchQuery(first.list())).summary.total).toBe(1);
    expect((await qc.fetchQuery(second.list())).summary.total).toBe(2);
    expect(qc.getQueryData(first.list().queryKey)).not.toEqual(
      qc.getQueryData(second.list().queryKey),
    );
  });
  it("forwards query disposal through body cancellation and rejects malformed wire data safely", async () => {
    let canceled = false;
    vi.stubGlobal(
      "fetch",
      () =>
        new Response(
          new ReadableStream({
            cancel() {
              canceled = true;
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    const qc = cache();
    const { unmount } = renderHookWithQuery(() => useQuery(queries().list()), { queryClient: qc });
    await waitFor(() => expect(qc.isFetching()).toBe(1));
    unmount();
    await waitFor(() => expect(canceled).toBe(true));
    vi.stubGlobal("fetch", () => Response.json({ services: [], secret: "synthetic-private" }));
    await expect(qc.fetchQuery(queries().list())).rejects.toThrow("Service request failed");
    expect(qc.getQueryData(queries().list().queryKey)).toBeUndefined();
  });
  it("keeps actual detail, config and credential payloads separate for two origins and reserved IDs", async () => {
    const manifest = {
      id: "selection",
      name: "Reserved ID",
      version: "1.0.0",
      quality: "built-in",
      container: { image: "example.invalid/demo", tag: "1", future: { intact: true } },
      provides: [{ capability: "routing", metadata: { raw: [false] } }],
      future: { retained: true },
    };
    vi.stubGlobal("fetch", (url: string) => {
      const u = new URL(url);
      const marker = u.origin === apiUrl ? "FIRST_" : "SECOND_";
      if (u.pathname.endsWith("/config"))
        return Response.json({
          schema: null,
          resolvedConfig: { marker: { value: marker, source: "database" } },
          envPrefix: marker,
        });
      if (u.pathname.endsWith("/credentials"))
        return Response.json({
          serviceId: "selection",
          secretsConfigured: true,
          credentials: [{ key: "TOKEN", title: marker, source: "missing", updatedBy: null }],
        });
      expect(u.pathname).toBe("/api/admin/services/selection");
      return Response.json({
        manifest: { ...manifest, name: marker },
        directory: "/synthetic",
        isBuiltIn: true,
        enabled: true,
        status: "running",
      });
    });
    const qc = cache();
    const first = queries();
    const second = queries("http://second.test");
    expect((await qc.fetchQuery(first.detail("selection"))).manifest.name).toBe("FIRST_");
    expect((await qc.fetchQuery(second.detail("selection"))).manifest.name).toBe("SECOND_");
    expect((await qc.fetchQuery(first.config("selection"))).envPrefix).toBe("FIRST_");
    expect((await qc.fetchQuery(second.config("selection"))).envPrefix).toBe("SECOND_");
    expect((await qc.fetchQuery(first.credentials("selection"))).credentials[0].title).toBe(
      "FIRST_",
    );
    expect((await qc.fetchQuery(second.credentials("selection"))).credentials[0].title).toBe(
      "SECOND_",
    );
    expect(qc.getQueryData(first.detail("selection").queryKey)?.manifest).toEqual({
      ...manifest,
      name: "FIRST_",
    });
  });

  it("refreshes feature-owned runtime query keys with the recorded service effect", async () => {
    const qc = cache();
    const extra = ["admin", "synthetic-operation-status", apiUrl];
    const replacement = ["admin", "synthetic-operation-status", "http://second.test"];
    qc.setQueryData(extra, { revision: 1 });
    qc.setQueryData(replacement, { revision: 2 });
    await invalidateServiceAdministration(qc, apiUrl, { kind: "operations", refreshKeys: [extra] });
    expect(qc.getQueryState(extra)?.isInvalidated).toBe(true);
    expect(qc.getQueryState(replacement)?.isInvalidated).toBe(false);
  });
});
