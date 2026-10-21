import { QueryClientProvider } from "@tanstack/react-query";
import type { PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { job } from "@/components/admin/activity/__tests__/fixtures";
import { AdminJobEffectsProvider } from "@/lib/admin/adminJobEffects";
import { act, cleanup, createTestQueryClient, renderHook, waitFor } from "@/test";
import { deferred } from "@/test/extensionAdmin";
import {
  useAddExtensionSource,
  useExtensionCatalog,
  useExtensionSources,
  useInstallExtension,
  useInstalledExtensions,
  usePreviewExtensionInstall,
  useRefreshExtensionCatalog,
  useRemoveExtension,
  useRemoveExtensionSource,
  useUpdateExtension,
} from "./useExtensions";

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
beforeEach(() => {
  apiUrl = "http://admin.test";
});
afterEach(() => {
  cleanup();
  for (const qc of caches.splice(0)) qc.clear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe("extension browser acquisition through the real generated SDK", () => {
  it.each(["", "http://admin.test/", "https://remote.test"])(
    "resolves %s transport but retains the configured identity and all filters",
    async (base) => {
      apiUrl = base;
      const calls: { url: string; init: RequestInit }[] = [];
      vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return Response.json({ entries: [], total: 0, revocationDataStale: true });
      });
      const { result, qc } = mount(() =>
        useExtensionCatalog({
          q: "a & b",
          category: "travel",
          trust: "community",
          type: "service",
          sort: "updated",
        }),
      );
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      const url = new URL(calls[0].url);
      expect(url.origin).toBe(base ? new URL(base).origin : window.location.origin);
      expect(Object.fromEntries(url.searchParams)).toEqual({
        q: "a & b",
        category: "travel",
        trust: "community",
        type: "service",
        sort: "updated",
      });
      expect(calls[0].init).toMatchObject({
        credentials: "include",
        signal: expect.any(AbortSignal),
      });
      expect(qc.getQueryCache().getAll()[0].queryKey).toEqual([
        "admin",
        "extensions",
        base,
        "catalog",
        { q: "a & b", category: "travel", trust: "community", type: "service", sort: "updated" },
      ]);
      expect(result.current.data).toMatchObject({ revocationDataStale: true });
    },
  );
  it.each(["catalog", "installed", "sources"] as const)(
    "rejects malformed %s success instead of rendering empty success",
    async (kind) => {
      vi.stubGlobal("fetch", () => Response.json({ error: "not a list" }));
      const { result } = mount(
        () =>
          ({
            catalog: useExtensionCatalog({}),
            installed: useInstalledExtensions(),
            sources: useExtensionSources(),
          })[kind],
      );
      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(result.current.data).toBeUndefined();
    },
  );
  it("cancels acquisition when the query loses its last observer", async () => {
    let signal: AbortSignal | undefined | null;
    vi.stubGlobal("fetch", (_url: string, init: RequestInit) => {
      signal = init.signal;
      return new Promise((_resolve, reject) =>
        init.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        ),
      );
    });
    const { unmount } = mount(() => useInstalledExtensions());
    await waitFor(() => expect(signal).toBeDefined());
    unmount();
    expect(signal?.aborted).toBe(true);
  });
  it("expires a stalled body at the finite 30 second read deadline", async () => {
    vi.useFakeTimers();
    let bodySignal: AbortSignal | undefined | null;
    vi.stubGlobal("fetch", (_url: string, init: RequestInit) => {
      bodySignal = init.signal;
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode('{"extensions":['));
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    });
    const { result } = mount(() => useInstalledExtensions());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_001);
    });
    expect(bodySignal?.aborted).toBe(true);
    expect(result.current.isError).toBe(true);
  });
  it("does not retry ambiguous destructive acknowledgements under retrying defaults", async () => {
    const fetch = vi.fn(() => Promise.reject(new Error("private transport detail")));
    vi.stubGlobal("fetch", fetch);
    const { result } = mount(useRemoveExtension);
    await act(async () => {
      await expect(result.current.mutateAsync("x/y")).rejects.toThrow("Extension request failed");
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe("http://admin.test/api/admin/extensions/x%2Fy");
  });
  it("refreshes installed badges and inactive catalog data on synchronous refresh, only at the executing origin", async () => {
    vi.stubGlobal("fetch", () => Response.json({ entries: 0 }));
    const { result, qc } = mount(useRefreshExtensionCatalog);
    const keys = [
      ["admin", "extensions", apiUrl, "catalog", {}],
      ["admin", "extensions", apiUrl, "installed"],
      ["admin", "extensions", "http://second.test", "installed"],
    ];
    for (const key of keys) qc.setQueryData(key, {});
    await act(() => result.current.mutateAsync());
    expect(keys.map((key) => qc.getQueryState(key)?.isInvalidated)).toEqual([true, true, false]);
  });
  it.each(["preview", "install", "update", "refresh"] as const)(
    "allows %s resolution beyond read time, expires at 180s and explains ambiguity without retry",
    async (kind) => {
      vi.useFakeTimers();
      let signal: AbortSignal | undefined | null;
      let attempts = 0;
      const fetch = (_url: string, init: RequestInit) => {
        attempts++;
        signal = init.signal;
        return new Promise((_resolve, reject) =>
          init.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          ),
        );
      };
      vi.stubGlobal("fetch", fetch);
      const { result } = mount(() => ({
        preview: usePreviewExtensionInstall(),
        install: useInstallExtension(),
        update: useUpdateExtension(),
        refresh: useRefreshExtensionCatalog(),
      }));
      let work!: Promise<unknown>;
      act(() => {
        work =
          kind === "refresh"
            ? result.current.refresh.mutateAsync()
            : result.current[kind].mutateAsync({ id: "demo" });
        work.catch(() => {});
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_001);
      });
      expect(signal?.aborted).toBe(false);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(150_000);
        await expect(work).rejects.toThrow(/may still|unknown|not cancel/);
      });
      expect(attempts).toBe(1);
    },
  );
  it.each(["install", "update", "remove", "preview", "add", "removeSource", "refresh"] as const)(
    "never retries declared %s errors and preserves request encoding/body absence",
    async (kind) => {
      const calls: { url: string; init: RequestInit }[] = [];
      vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return Response.json(
          { error: "Try deliberately later", retryAfter: 30 },
          { status: 429, headers: { "retry-after": "30" } },
        );
      });
      const { result } = mount(() => ({
        install: useInstallExtension(),
        update: useUpdateExtension(),
        remove: useRemoveExtension(),
        preview: usePreviewExtensionInstall(),
        add: useAddExtensionSource(),
        removeSource: useRemoveExtensionSource(),
        refresh: useRefreshExtensionCatalog(),
      }));
      const run = () =>
        ({
          install: () => result.current.install.mutateAsync({ id: "x/y" }),
          update: () => result.current.update.mutateAsync({ id: "x/y" }),
          remove: () => result.current.remove.mutateAsync("x/y"),
          preview: () =>
            result.current.preview.mutateAsync({ manifestUrl: "https://manifest.test/ext.json" }),
          add: () =>
            result.current.add.mutateAsync({ url: "https://catalog.test", label: "Catalog" }),
          removeSource: () => result.current.removeSource.mutateAsync("https://catalog.test"),
          refresh: () => result.current.refresh.mutateAsync(),
        })[kind]();
      await act(async () => {
        await expect(run()).rejects.toThrow("Try deliberately later");
      });
      expect(calls).toHaveLength(1);
      if (["update", "remove", "refresh"].includes(kind)) {
        expect(calls[0].init.body).toBeUndefined();
        expect(new Headers(calls[0].init.headers).has("content-type")).toBe(false);
      }
      if (kind === "removeSource")
        expect(JSON.parse(String(calls[0].init.body))).toEqual({ url: "https://catalog.test" });
      if (kind === "update") expect(calls[0].url).toContain("update/x%2Fy");
    },
  );
  it.each(["installed", "sources"] as const)(
    "isolates %s snapshots on origin replacement",
    async (kind) => {
      vi.stubGlobal("fetch", () =>
        Response.json(kind === "installed" ? { extensions: [] } : { sources: [] }),
      );
      const useRead = kind === "installed" ? useInstalledExtensions : useExtensionSources;
      const { qc, rerender, result } = mount<
        ReturnType<typeof useInstalledExtensions> | ReturnType<typeof useExtensionSources>
      >(useRead);
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      apiUrl = "https://remote.test/";
      rerender();
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(
        qc
          .getQueryCache()
          .getAll()
          .map((q) => q.queryKey),
      ).toEqual([
        ["admin", "extensions", "http://admin.test", kind],
        ["admin", "extensions", "https://remote.test/", kind],
      ]);
    },
  );
});

type RemovalHook =
  | ReturnType<typeof useRemoveExtension>
  | ReturnType<typeof useRemoveExtensionSource>;

let removalJobSequence = 0;
function removalReply(kind: "extension" | "source", id = `removal-job-${++removalJobSequence}`) {
  return kind === "extension"
    ? Response.json({ jobId: id }, { status: 202 })
    : Response.json({ ok: true });
}
describe("removal execution ownership beyond a view observer", () => {
  it.each(["extension", "source"] as const)(
    "atomically excludes overlapping %s observers for one target while another target executes",
    async (kind) => {
      const first = deferred<Response>();
      const deletes: string[] = [];
      vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
        if (init.method !== "DELETE")
          return Response.json(job({ id: new URL(url).pathname.split("/").at(-1) ?? "missing" }));
        const target =
          kind === "extension"
            ? decodeURIComponent(new URL(url).pathname.split("/").at(-1) ?? "")
            : JSON.parse(String(init.body)).url;
        deletes.push(target);
        if (target === "target-A" && deletes.filter((t) => t === target).length === 1)
          return first.promise;
        if (target === "target-A")
          return Response.json({ error: "Duplicate reached transport" }, { status: 400 });
        return removalReply(kind);
      });
      const useRemoval = kind === "extension" ? useRemoveExtension : useRemoveExtensionSource;
      const { result } = mount(() => ({ first: useRemoval(), second: useRemoval() }));
      let work!: Promise<unknown>;
      let duplicate!: Promise<unknown>;
      // Both calls use one render, before either observer can learn new UI pending state.
      act(() => {
        work = result.current.first.mutateAsync("target-A");
        work.catch(() => {});
        duplicate = result.current.second.mutateAsync("target-A");
        duplicate.catch(() => {});
      });
      try {
        await act(async () => {
          await expect(duplicate).rejects.toThrow("Removal already pending for this target");
        });
        expect(deletes).toEqual(["target-A"]);
        await act(async () => {
          await result.current.second.mutateAsync("target-B");
        });
        expect(deletes).toEqual(["target-A", "target-B"]);
        await waitFor(() => expect(result.current.second.isPendingFor("target-A")).toBe(true));
        expect(result.current.second.isPendingFor("target-B")).toBe(false);
        await act(async () => {
          await expect(result.current.second.mutateAsync("target-A")).rejects.toThrow(
            "Removal already pending for this target",
          );
        });
        expect(deletes).toEqual(["target-A", "target-B"]);
      } finally {
        await act(async () => {
          first.resolve(removalReply(kind));
          await work;
        });
      }
    },
  );
  it.each(["extension", "source"] as const)(
    "releases %s ownership after success and error without retrying",
    async (kind) => {
      const first = deferred<Response>();
      let attempts = 0;
      vi.stubGlobal("fetch", (url: string, init: RequestInit) =>
        init.method === "DELETE"
          ? ++attempts === 1
            ? first.promise
            : attempts === 2
              ? Response.json({ error: "Deliberate rejection" }, { status: 400 })
              : removalReply(kind)
          : Response.json(job({ id: new URL(url).pathname.split("/").at(-1) ?? "missing" })),
      );
      const useRemoval = kind === "extension" ? useRemoveExtension : useRemoveExtensionSource;
      const { result } = mount<RemovalHook>(useRemoval);
      let work!: Promise<unknown>;
      act(() => {
        work = result.current.mutateAsync("same-target");
      });
      await waitFor(() => expect(attempts).toBe(1));
      await act(async () => {
        first.resolve(removalReply(kind));
        await work;
      });
      expect(attempts).toBe(1);
      await act(async () => {
        await expect(result.current.mutateAsync("same-target")).rejects.toThrow(
          "Deliberate rejection",
        );
      });
      expect(attempts).toBe(2);
      await act(async () => {
        await result.current.mutateAsync("same-target");
      });
      expect(attempts).toBe(3);
    },
  );
  it.each(["extension", "source"] as const)(
    "keeps %s exclusions scoped to QueryClient",
    async (kind) => {
      const responses = [deferred<Response>(), deferred<Response>()];
      let attempts = 0;
      vi.stubGlobal("fetch", (url: string, init: RequestInit) =>
        init.method === "DELETE"
          ? responses[attempts++].promise
          : Response.json(job({ id: new URL(url).pathname.split("/").at(-1) ?? "missing" })),
      );
      const useRemoval = kind === "extension" ? useRemoveExtension : useRemoveExtensionSource;
      const a = mount<RemovalHook>(useRemoval);
      const b = mount<RemovalHook>(useRemoval);
      let workA!: Promise<unknown>;
      let workB!: Promise<unknown>;
      act(() => {
        workA = a.result.current.mutateAsync("same-target");
        workB = b.result.current.mutateAsync("same-target");
      });
      await waitFor(() => expect(attempts).toBe(2));
      await act(async () => {
        responses[0].resolve(removalReply(kind));
        responses[1].resolve(removalReply(kind));
        await Promise.all([workA, workB]);
      });
    },
  );
  it.each(["extension", "source"] as const)(
    "distinguishes raw %s origins and retains the original scope on origin ABA",
    async (kind) => {
      const responses = [deferred<Response>(), deferred<Response>()];
      const origins: string[] = [];
      vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
        if (init.method !== "DELETE")
          return Response.json(job({ id: new URL(url).pathname.split("/").at(-1) ?? "missing" }));
        origins.push(new URL(url).origin);
        return origins.length <= 2
          ? responses[origins.length - 1].promise
          : Response.json({ error: "Duplicate reached transport" }, { status: 400 });
      });
      const useRemoval = kind === "extension" ? useRemoveExtension : useRemoveExtensionSource;
      const { result, rerender } = mount<RemovalHook>(useRemoval);
      let workA!: Promise<unknown>;
      let workB!: Promise<unknown>;
      act(() => {
        workA = result.current.mutateAsync("same-target");
      });
      await waitFor(() => expect(origins).toHaveLength(1));
      await waitFor(() => expect(result.current.isPendingFor("same-target")).toBe(true));
      apiUrl = "http://admin.test/";
      rerender();
      expect(result.current.isPendingFor("same-target")).toBe(false);
      act(() => {
        workB = result.current.mutateAsync("same-target");
      });
      await waitFor(() => expect(origins).toHaveLength(2));
      apiUrl = "http://admin.test";
      rerender();
      expect(result.current.isPendingFor("same-target")).toBe(true);
      try {
        await act(async () => {
          await expect(result.current.mutateAsync("same-target")).rejects.toThrow(
            "Removal already pending for this target",
          );
        });
        expect(origins).toEqual(["http://admin.test", "http://admin.test"]);
      } finally {
        await act(async () => {
          responses[0].resolve(removalReply(kind));
          responses[1].resolve(removalReply(kind));
          await Promise.all([workA, workB]);
        });
      }
    },
  );
  it("keeps extension removal and source removal independent even for equal target strings", async () => {
    const replies = [deferred<Response>(), deferred<Response>()];
    const paths: string[] = [];
    vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
      if (init.method !== "DELETE")
        return Response.json(job({ id: new URL(url).pathname.split("/").at(-1) ?? "missing" }));
      paths.push(new URL(url).pathname);
      return replies[paths.length - 1].promise;
    });
    const { result } = mount(() => ({
      extension: useRemoveExtension(),
      source: useRemoveExtensionSource(),
    }));
    let a!: Promise<unknown>;
    let b!: Promise<unknown>;
    act(() => {
      a = result.current.extension.mutateAsync("same-target");
      b = result.current.source.mutateAsync("same-target");
    });
    await waitFor(() =>
      expect(paths).toEqual(["/api/admin/extensions/same-target", "/api/admin/extensions/sources"]),
    );
    await act(async () => {
      replies[0].resolve(removalReply("extension"));
      replies[1].resolve(removalReply("source"));
      await Promise.all([a, b]);
    });
  });
  it.each(["extension", "source"] as const)(
    "releases %s exclusion on observed timeout, preserving ambiguity and no automatic retry",
    async (kind) => {
      vi.useFakeTimers();
      let attempts = 0;
      vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
        if (init.method !== "DELETE")
          return Response.json(job({ id: new URL(url).pathname.split("/").at(-1) ?? "missing" }));
        if (++attempts > 1) return removalReply(kind);
        return new Promise((_resolve, reject) =>
          init.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          ),
        );
      });
      const useRemoval = kind === "extension" ? useRemoveExtension : useRemoveExtensionSource;
      const { result } = mount<RemovalHook>(useRemoval);
      let work!: Promise<unknown>;
      act(() => {
        work = result.current.mutateAsync("same-target");
        work.catch(() => {});
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(180_001);
        await expect(work).rejects.toThrow(
          "Extension request ended without a confirmed result. Work may still be running; this does not cancel a host job. Check Activity before deliberately retrying.",
        );
      });
      expect(attempts).toBe(1);
      await act(async () => {
        await result.current.mutateAsync("same-target");
      });
      expect(attempts).toBe(2);
    },
  );
});
