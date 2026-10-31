import { createApiClient } from "@openmapx/core";
import { QueryClientProvider } from "@tanstack/react-query";
import type { PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminJobEffectsProvider } from "@/lib/admin/adminJobEffects";
import { serviceAdminQueries } from "@/lib/admin/serviceAdmin";
import { act, cleanup, createTestQueryClient, renderHook, waitFor } from "@/test";
import {
  useDeleteServiceCredential,
  useServiceAction,
  useServiceConfigSave,
  useServiceHealthCheck,
  useServiceSelectionSave,
  useServicesBulkAction,
  useServicesList,
  useSetServiceCredential,
} from "./useServices";

let apiUrl = "http://admin.test";
vi.mock("@/integration-api/runtime/EnvProvider", () => ({ useEnv: () => ({ apiUrl }) }));
const caches: ReturnType<typeof createTestQueryClient>[] = [];
function mount<T>(fn: () => T) {
  const qc = createTestQueryClient();
  qc.setDefaultOptions({ queries: { retry: false }, mutations: { retry: 2, retryDelay: 1 } });
  caches.push(qc);
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={qc}>
      <AdminJobEffectsProvider>{children}</AdminJobEffectsProvider>
    </QueryClientProvider>
  );
  return { qc, ...renderHook(fn, { wrapper }) };
}
function pending<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { resolve, promise };
}
beforeEach(() => {
  apiUrl = "http://admin.test";
});
afterEach(() => {
  cleanup();
  for (const qc of caches.splice(0)) qc.clear();
  vi.unstubAllGlobals();
});
describe("service feature hooks use the generated SDK", () => {
  it("acquires list data and surfaces declared errors", async () => {
    const fetch = vi.fn(() =>
      Response.json({
        acquisition: { state: "available", reason: null },
        services: [],
        capabilityInventory: { recognized: [], unrecognized: [] },
        summary: { running: 2, stopped: 1, unknown: 0, total: 3 },
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const { result } = mount(useServicesList);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.summary.total).toBe(3);
    expect(fetch).toHaveBeenCalledWith(
      "http://admin.test/api/admin/services",
      expect.objectContaining({ credentials: "include", signal: expect.any(AbortSignal) }),
    );
  });
  it.each(["action", "config", "set", "delete", "check", "selection", "bulk"] as const)(
    "never retries failed %s under retrying mutation defaults",
    async (kind) => {
      const fetch = vi.fn(() =>
        Response.json(
          kind === "config"
            ? { errors: ["Invalid field", "Configuration rejected"] }
            : { error: "Request rejected" },
          { status: 400 },
        ),
      );
      vi.stubGlobal("fetch", fetch);
      const { result } = mount(() => ({
        action: useServiceAction("demo"),
        config: useServiceConfigSave("demo"),
        set: useSetServiceCredential("demo"),
        delete: useDeleteServiceCredential("demo"),
        check: useServiceHealthCheck(),
        selection: useServiceSelectionSave(),
        bulk: useServicesBulkAction(),
      }));
      await act(async () => {
        const calls = {
          action: () => result.current.action.mutateAsync("start"),
          config: () => result.current.config.mutateAsync({ count: 2 }),
          set: () =>
            result.current.set.mutateAsync({ key: "TOKEN /key", value: "synthetic-private" }),
          delete: () => result.current.delete.mutateAsync("TOKEN /key"),
          check: () => result.current.check.mutateAsync(),
          selection: () => result.current.selection.mutateAsync([]),
          bulk: () => result.current.bulk.mutateAsync({ action: "start", serviceIds: ["demo"] }),
        };
        await expect(calls[kind]()).rejects.toThrow(
          kind === "config" ? "Invalid field; Configuration rejected" : "Request rejected",
        );
      });
      expect(fetch).toHaveBeenCalledTimes(1);
      if (["config", "set", "delete", "selection"].includes(kind)) {
        const init = fetch.mock.calls[0]![1] as RequestInit;
        expect(new Headers(init.headers).get("idempotency-key")).toMatch(
          /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/,
        );
        if (kind !== "delete")
          expect(JSON.parse(String(init.body))).toEqual(
            kind === "config"
              ? { config: { count: 2 } }
              : kind === "set"
                ? { value: "synthetic-private" }
                : { selectedRoots: [] },
          );
      }
      if (kind === "set" || kind === "delete")
        expect(fetch.mock.calls[0][0]).toContain("TOKEN%20%2Fkey");
    },
  );
  it("refreshes only the executing origin when a save acknowledgement arrives after replacement", async () => {
    const deferred = pending<Response>();
    vi.stubGlobal("fetch", () => deferred.promise);
    const { qc, result, rerender } = mount(() => useServiceConfigSave("demo"));
    const first = serviceAdminQueries(createApiClient({ baseUrl: apiUrl }), apiUrl).config(
      "demo",
    ).queryKey;
    const second = serviceAdminQueries(
      createApiClient({ baseUrl: "http://second.test" }),
      "http://second.test",
    ).config("demo").queryKey;
    qc.setQueryData(first, { schema: null, resolvedConfig: {}, envPrefix: "FIRST_" });
    qc.setQueryData(second, { schema: null, resolvedConfig: {}, envPrefix: "SECOND_" });
    let work!: Promise<unknown>;
    act(() => {
      work = result.current.mutateAsync({ count: 2 });
    });
    await waitFor(() => expect(result.current.isPending).toBe(true));
    apiUrl = "http://second.test";
    rerender();
    await act(async () => {
      deferred.resolve(Response.json({ ok: true }));
      await work;
    });
    expect(qc.getQueryState(first)?.isInvalidated).toBe(true);
    expect(qc.getQueryState(second)?.isInvalidated).toBe(false);
  });
});
