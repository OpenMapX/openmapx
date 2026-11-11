import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ProviderHealthResponse } from "@/lib/admin/transitHooks";

const resetMutate = vi.fn();

vi.mock("@/integration-api/runtime/EnvProvider", () => ({
  useEnv: () => ({ apiUrl: "http://test.local" }),
}));

vi.mock("@/components/admin/shared/AdminToast", () => ({
  useAdminToast: () => () => {},
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: () => {} }),
  useMutation: () => ({ mutate: () => {}, isPending: false }),
  useQuery: () => ({ data: undefined, isLoading: false, isError: false }),
}));

vi.mock("@/lib/admin/transitHooks", async () => {
  const actual = await vi.importActual<typeof import("@/lib/admin/transitHooks")>(
    "@/lib/admin/transitHooks",
  );
  return {
    ...actual,
    useProviderHealth: () => ({
      data: sampleProviders,
      isLoading: false,
      isError: false,
    }),
    useResetProvider: () => ({ mutate: resetMutate, isPending: false }),
  };
});

const base = {
  schema: 2 as const,
  successCount: 200,
  failureCount: 5,
  countedFailureCount: 5,
  consecutiveSuccesses: 1,
  consecutiveFailures: 0,
  reopenCount: 0,
  emaLatencyMs: 110,
  window: [],
  windowFailureRate: 0.02,
  lastFailureAt: "2026-05-22T08:00:00.000Z",
  lastFailureOutcome: "timeout" as const,
  lastOperatorMessage: "timeout after 5s",
  retryAt: null,
};

const sampleProviders: ProviderHealthResponse = {
  providers: [
    { ...base, id: "transitous", state: "healthy" },
    {
      ...base,
      id: "tfl",
      state: "degraded",
      successCount: 70,
      failureCount: 12,
      consecutiveFailures: 2,
      windowFailureRate: 0.3,
    },
    {
      ...base,
      id: "db-vendo",
      state: "open",
      successCount: 50,
      failureCount: 30,
      consecutiveFailures: 5,
      windowFailureRate: 0.6,
      retryAt: new Date(Date.now() + 60_000).toISOString(),
    },
    {
      ...base,
      id: "irail",
      state: "half-open",
      consecutiveFailures: 5,
      windowFailureRate: null,
      lastOperatorMessage: null,
      lastFailureOutcome: "invalid_payload",
      retryAt: new Date(Date.now() - 60_000).toISOString(),
    },
  ],
};

function rowFor(markup: string, id: string): string {
  const start = markup.indexOf(`>${id}<`);
  const end = markup.indexOf("</tr>", start);
  return markup.slice(start, end);
}

describe("ProviderHealthTable", () => {
  it("renders one row per provider with success/failure counts", async () => {
    const { ProviderHealthTable } = await import("../ProviderHealthTable");
    const markup = renderToStaticMarkup(<ProviderHealthTable />);
    for (const id of ["transitous", "tfl", "db-vendo", "irail"]) expect(markup).toContain(id);
    expect(rowFor(markup, "transitous")).toContain(">200<");
    expect(rowFor(markup, "db-vendo")).toContain(">30<");
  });

  it("shows the explicit circuit state for every provider", async () => {
    const { ProviderHealthTable } = await import("../ProviderHealthTable");
    const markup = renderToStaticMarkup(<ProviderHealthTable />);
    expect(rowFor(markup, "transitous")).toContain(">healthy<");
    expect(rowFor(markup, "tfl")).toContain(">degraded<");
    expect(rowFor(markup, "db-vendo")).toContain("open until");
    expect(rowFor(markup, "irail")).toContain(">half-open<");
    expect(markup).not.toContain(">active<");
  });

  it("falls back to the failure outcome when no operator message was recorded", async () => {
    const { ProviderHealthTable } = await import("../ProviderHealthTable");
    const markup = renderToStaticMarkup(<ProviderHealthTable />);
    expect(rowFor(markup, "transitous")).toContain("last error: timeout after 5s");
    expect(rowFor(markup, "irail")).toContain("last error: invalid_payload");
    expect(rowFor(markup, "irail")).toContain("—");
  });
});
