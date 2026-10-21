import { QueryClientProvider } from "@tanstack/react-query";
import type { PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, createTestQueryClient, renderHook, waitFor } from "@/test";
import { useDawarichProvisioning } from "./useDawarichProvisioning";

let apiUrl = "https://api.test";
vi.mock("@/integration-api/runtime/EnvProvider", () => ({ useEnv: () => ({ apiUrl }) }));
const status = {
  installed: true,
  selected: false,
  running: false,
  healthy: false,
  publicOrigin: "https://timeline.example.test",
  oauthClient: {
    present: true,
    clientId: null,
    redirectUriMatches: true,
    settingsMatch: true,
    recoveryRequired: false,
  },
  secrets: {
    databasePassword: "consistent",
    secretKeyBase: "missing",
    oidcClientSecret: "conflict",
  },
  configReady: false,
  readyToStart: false,
  needsApply: true,
} as const;
const caches: ReturnType<typeof createTestQueryClient>[] = [];
function mount() {
  const qc = createTestQueryClient();
  qc.setDefaultOptions({
    queries: { retry: false, gcTime: Infinity },
    mutations: { retry: 2, retryDelay: 1 },
  });
  caches.push(qc);
  return {
    qc,
    ...renderHook(() => useDawarichProvisioning(), {
      wrapper: ({ children }: PropsWithChildren) => (
        <QueryClientProvider client={qc}>{children}</QueryClientProvider>
      ),
    }),
  };
}
beforeEach(() => {
  apiUrl = "https://api.test";
});
afterEach(() => {
  cleanup();
  for (const qc of caches.splice(0)) qc.clear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe("managed Dawarich canonical acquisition", () => {
  it("preserves independent flags, scoped status and no-store", async () => {
    const requests: RequestInit[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      requests.push(init);
      return Response.json(status);
    });
    const { result, qc } = mount();
    await waitFor(() => expect(result.current.statusQuery.isSuccess).toBe(true));
    expect(result.current.statusQuery.data).toEqual(status);
    expect(qc.getQueryData(["admin", "services", apiUrl, "dawarich"])).toEqual(status);
    expect(requests[0]).toMatchObject({
      cache: "no-store",
      credentials: "include",
      signal: expect.any(AbortSignal),
    });
  });
  it("uses exact provision and rotation bodies once despite retry defaults", async () => {
    const writes: { path: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      if (init.method === "POST") {
        writes.push({ path: new URL(url).pathname, init });
        return Response.json({ code: "DAWARICH_DATABASE_SECRET_CONFLICT" }, { status: 409 });
      }
      return Response.json(status);
    });
    const { result } = mount();
    await waitFor(() => expect(result.current.statusQuery.isSuccess).toBe(true));
    await act(async () => {
      await result.current.provision.mutateAsync("timeline.example.test").catch(() => {});
    });
    await act(async () => {
      await result.current.rotate.mutateAsync().catch(() => {});
    });
    expect(writes.map(({ path, init }) => [path, JSON.parse(String(init.body))])).toEqual([
      ["/api/admin/dawarich/provision", { publicHost: "timeline.example.test" }],
      ["/api/admin/dawarich/rotate-oidc-secret", { confirmation: "ROTATE DAWARICH OIDC SECRET" }],
    ]);
  });
  it.each([
    [409, "DAWARICH_DATABASE_SECRET_CONFLICT", "DAWARICH_DATABASE_SECRET_CONFLICT"],
    [409, "DAWARICH_RAILS_SECRET_CONFLICT", "DAWARICH_RAILS_SECRET_CONFLICT"],
    [409, "DAWARICH_OAUTH_CLIENT_CONFLICT", "DAWARICH_OAUTH_CLIENT_CONFLICT"],
    [422, "DAWARICH_INVALID_PUBLIC_HOST", "DAWARICH_INVALID_PUBLIC_HOST"],
    [503, "DAWARICH_OIDC_SECRET_RECOVERY_REQUIRED", "DAWARICH_OIDC_SECRET_RECOVERY_REQUIRED"],
    [503, "DAWARICH_PROVISIONING_FAILED", "DAWARICH_PROVISIONING_FAILED"],
    [409, "DAWARICH_BUNDLE_NOT_INSTALLED", "DAWARICH_PROVISIONING_FAILED"],
    [500, "DAWARICH_DATABASE_SECRET_CONFLICT", "DAWARICH_PROVISIONING_FAILED"],
    [409, "secret-unrecognized", "DAWARICH_PROVISIONING_FAILED"],
  ] as const)("maps only declared status/code %s/%s", async (code, value, expected) => {
    vi.stubGlobal("fetch", async () => Response.json({ code: value }, { status: code }));
    const { result } = mount();
    await waitFor(() => expect(result.current.statusQuery.isError).toBe(true));
    expect(result.current.statusQuery.error?.message).toBe(expected);
  });
  it.each([{}, { ...status, secrets: { ...status.secrets, oidcClientSecret: "secret-value" } }])(
    "rejects malformed status safely",
    async (body) => {
      vi.stubGlobal("fetch", async () => Response.json(body));
      const { result } = mount();
      await waitFor(() => expect(result.current.statusQuery.isError).toBe(true));
      expect(result.current.statusQuery.error?.message).toBe("DAWARICH_PROVISIONING_FAILED");
    },
  );
  it("bounds a stalled status reader to 30 seconds and releases it", async () => {
    vi.useFakeTimers();
    let canceled = false;
    const stream = new ReadableStream({
      cancel() {
        canceled = true;
      },
    });
    vi.stubGlobal(
      "fetch",
      async () => new Response(stream, { headers: { "content-type": "application/json" } }),
    );
    const { result } = mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_001);
    });
    expect(result.current.statusQuery.isError).toBe(true);
    expect(canceled).toBe(true);
    expect(stream.locked).toBe(false);
  });
});

it.each([
  ["provision", 409, "DAWARICH_BUNDLE_NOT_INSTALLED", "DAWARICH_BUNDLE_NOT_INSTALLED"],
  [
    "rotate",
    400,
    "DAWARICH_ROTATION_CONFIRMATION_REQUIRED",
    "DAWARICH_ROTATION_CONFIRMATION_REQUIRED",
  ],
  ["rotate", 422, "DAWARICH_INVALID_PUBLIC_HOST", "DAWARICH_INVALID_PUBLIC_HOST"],
  [
    "rotate",
    503,
    "DAWARICH_OIDC_SECRET_RECOVERY_REQUIRED",
    "DAWARICH_OIDC_SECRET_RECOVERY_REQUIRED",
  ],
  ["rotate", 500, "DAWARICH_DATABASE_SECRET_CONFLICT", "DAWARICH_PROVISIONING_FAILED"],
] as const)(
  "retains only declared %s mutation status %s code %s",
  async (action, code, value, expected) => {
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) =>
      init.method === "POST"
        ? Response.json({ code: value }, { status: code })
        : Response.json(status),
    );
    const { result } = mount();
    await waitFor(() => expect(result.current.statusQuery.isSuccess).toBe(true));
    await act(async () => {
      await (action === "rotate"
        ? result.current.rotate.mutateAsync()
        : result.current.provision.mutateAsync(undefined)
      ).catch((error) => {
        expect(error.message).toBe(expected);
      });
    });
    await waitFor(() => expect(result.current[action].isError).toBe(true));
  },
);
