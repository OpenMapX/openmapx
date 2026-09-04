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

const sampleProviders: ProviderHealthResponse = {
  providers: [
    {
      id: "transitous",
      success: 200,
      failure: 5,
      emaLatencyMs: 110,
      window: [],
      windowFailureRate: 0.02,
      lastFailureAt: "2026-05-22T08:00:00.000Z",
      lastFailureReason: "timeout after 5s",
    },
    {
      id: "db-vendo",
      success: 50,
      failure: 30,
      emaLatencyMs: 800,
      window: [],
      windowFailureRate: 0.6,
      disabledUntil: new Date(Date.now() + 60_000).toISOString(),
      disabledReason: "failure rate exceeded threshold",
    },
  ],
};

describe("ProviderHealthTable", () => {
  it("renders one row per provider with success/failure counts", async () => {
    const { ProviderHealthTable } = await import("../ProviderHealthTable");
    const markup = renderToStaticMarkup(<ProviderHealthTable />);
    expect(markup).toContain("transitous");
    expect(markup).toContain("db-vendo");
    expect(markup).toContain("200");
    expect(markup).toContain("30");
  });

  it("flags auto-disabled providers", async () => {
    const { ProviderHealthTable } = await import("../ProviderHealthTable");
    const markup = renderToStaticMarkup(<ProviderHealthTable />);
    // The disabled provider's chip prefixes with "disabled until".
    expect(markup).toContain("disabled until");
  });

  it("renders the Reset button per row", async () => {
    const { ProviderHealthTable } = await import("../ProviderHealthTable");
    const markup = renderToStaticMarkup(<ProviderHealthTable />);
    // Each row carries a Reset button; we expect at least two.
    const matches = markup.match(/Reset/g) ?? [];
    expect(matches.length).toBeDefined();
    expect((matches.length ?? 0) >= 2).toBe(true);
  });
});
