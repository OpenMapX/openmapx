import { createApiClient } from "@openmapx/core";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deferred } from "@/test/extensionAdmin";
import { browserAdminApiBase } from "./browserAdminApiBase";
import { extensionAdminQueries, invalidateExtensionAdministration } from "./extensionAdmin";

afterEach(() => vi.unstubAllGlobals());
describe("extension administration query graph", () => {
  it("keeps distinct list/detail projections and encoded detail identity", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", (url: string) => {
      calls.push(url);
      return Response.json({
        id: "x/y",
        name: "Detail",
        compatible: true,
        platformVersion: "1",
        removed: null,
        critical: null,
        componentList: [{ kind: "service", id: "svc" }],
        future: { inert: [null, 1, true] },
      });
    });
    const qc = new QueryClient();
    try {
      const queries = extensionAdminQueries(
        createApiClient({ baseUrl: "http://admin.test" }),
        "http://admin.test/",
      );
      const result = await qc.fetchQuery(queries.detail("x/y"));
      expect(calls).toEqual(["http://admin.test/api/admin/extensions/catalog/x%2Fy"]);
      expect(result).toMatchObject({
        componentList: [{ kind: "service", id: "svc" }],
        future: { inert: [null, 1, true] },
      });
      expect(result).not.toHaveProperty("installed");
      expect(queries.detail("x/y").queryKey).toEqual([
        "admin",
        "extensions",
        "http://admin.test/",
        "detail",
        "x/y",
      ]);
    } finally {
      qc.clear();
    }
  });
  it.each(["/prefix", "http://admin.test/prefix", "https://admin.test/?x=y"])(
    "rejects unsupported non-origin base %s",
    (base) => expect(() => browserAdminApiBase(base)).toThrow(),
  );
  it("cancels the whole effect union before replacing initial reads and invalidates inactive keys without touching another origin", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    const base = "http://admin.test/";
    const activeKeys = [
      ["admin", "extensions", base, "installed"],
      ["admin", "services", base, "list"],
      ["admin", "integrations", base, "detail", "demo"],
      ["integrations", "http://admin.test"],
      ["admin", "overview", base],
      ["admin", "credentials", base],
    ];
    const initial = activeKeys.map(() => deferred<string>());
    const counts = activeKeys.map(() => 0);
    const signals: (AbortSignal | undefined)[] = [];
    const observers = activeKeys.map(
      (queryKey, i) =>
        new QueryObserver(qc, {
          queryKey,
          queryFn: ({ signal }) => {
            counts[i]++;
            signals[i] ??= signal;
            return counts[i] === 1 ? initial[i].promise : Promise.resolve("after");
          },
        }),
    );
    const unsubscribes = observers.map((o) => o.subscribe(() => {}));
    const inactive = ["admin", "extensions", base, "detail", "inactive"];
    const unrelated = ["admin", "extensions", "http://other.test", "installed"];
    qc.setQueryData(inactive, "before");
    qc.setQueryData(unrelated, "unrelated");
    try {
      await invalidateExtensionAdministration(qc, base, "components");
      expect(counts).toEqual([2, 2, 2, 2, 2, 2]);
      expect(signals.every((s) => s?.aborted)).toBe(true);
      initial.forEach((p) => {
        p.resolve("old");
      });
      await Promise.resolve();
      expect(activeKeys.map((k) => qc.getQueryData(k))).toEqual([
        "after",
        "after",
        "after",
        "after",
        "after",
        "after",
      ]);
      expect(qc.getQueryState(inactive)?.isInvalidated).toBe(true);
      expect(qc.getQueryState(unrelated)?.isInvalidated).toBe(false);
    } finally {
      unsubscribes.forEach((f) => {
        f();
      });
      qc.clear();
    }
  });
});
