// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQueryWrapper, render, screen, userEvent } from "@/test";
import type { IntegrationSummary } from "../IntegrationList";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntlWithCatalog());

vi.mock("@/integration-api/runtime/EnvProvider", () => ({
  useEnv: () => ({ apiUrl: "http://test.local" }),
}));

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

import { IntegrationList } from "../IntegrationList";

function makeIntegrations(count: number): IntegrationSummary[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `provider-${String(i).padStart(3, "0")}`,
    name: `Provider ${String(i).padStart(3, "0")}`,
    domains: ["geocoding"],
    quality: "built-in" as const,
    isBuiltIn: true,
    loadState: "loaded" as const,
    loadError: null,
    requires: [],
    enabled: i % 2 === 0,
    status: i % 2 === 0 ? ("healthy" as const) : ("disabled" as const),
    loadErrorPhase: null,
    configured: true,
    hasHealthCheck: false,
    health: null,
    dependencies: [],
    infrastructure: null,
  }));
}

afterEach(() => {
  fetchMock.mockReset();
});

describe("IntegrationList pagination", () => {
  beforeEach(() => {
    fetchMock.mockImplementation((input: unknown) => {
      expect(input).toBe("http://test.local/api/admin/integrations");
      return Response.json(makeIntegrations(60));
    });
  });

  it("renders at most rowsPerPage rows for an oversized dataset", async () => {
    render(<IntegrationList />, { wrapper: createQueryWrapper() });

    await screen.findByText("Provider 000");
    const names = screen.getAllByText(/^Provider \d{3}$/);
    expect(names.length).toBe(25); // default rowsPerPage
    await screen.findByText(/of 60/);
  });

  it("resets to the first page when a filter changes", async () => {
    const user = userEvent.setup();
    render(<IntegrationList />, { wrapper: createQueryWrapper() });

    await screen.findByText("Provider 000");

    // Advance to page 2.
    const nextButton = await screen.findByRole("button", { name: /next page/i });
    await user.click(nextButton);
    await screen.findByText("Provider 025");
    expect(screen.queryByText("Provider 000")).toBeNull();

    // Typing in search filters AND resets to page 1: the matching subset starts
    // from the first page again.
    const searchBox = screen.getByPlaceholderText("Search by name, id, domain…");
    await user.type(searchBox, "provider-0");

    // After the filter, page must be back to 0, so the first matching row is
    // visible and the pager reports page 1 of the filtered set.
    await screen.findByText("Provider 000");
  });
});

describe("IntegrationList load state", () => {
  it("marks an integration whose code failed to load", async () => {
    const [loaded, failed] = makeIntegrations(2);
    fetchMock.mockImplementation(() =>
      Response.json([
        loaded,
        {
          ...failed,
          enabled: false,
          status: "disabled",
          loadState: "failed",
          loadError: "bad setup",
          loadErrorPhase: "setup",
        },
      ]),
    );
    const user = userEvent.setup();
    render(<IntegrationList />, { wrapper: createQueryWrapper() });

    const chips = await screen.findAllByText("Failed to load");
    expect(chips).toHaveLength(1);
    await user.hover(chips[0] as HTMLElement);
    expect(
      await screen.findByText(
        "This integration was left out because its code failed to load: bad setup",
      ),
    ).toBeTruthy();
  });

  it("counts and filters an enabled integration that failed to load as unhealthy", async () => {
    const [loaded, failed] = makeIntegrations(2);
    fetchMock.mockImplementation(() =>
      Response.json([
        loaded,
        {
          ...failed,
          name: "Acme transit",
          enabled: true,
          status: "failed",
          loadState: "failed",
          loadError: "SyntaxError",
          loadErrorPhase: "import",
        },
      ]),
    );
    const user = userEvent.setup();
    render(<IntegrationList />, { wrapper: createQueryWrapper() });

    await screen.findByText("Acme transit");
    expect(screen.getByRole("img", { name: "Failed to load" })).toBeInTheDocument();
    expect(screen.getAllByRole("img", { name: "Healthy" })).toHaveLength(1);
    expect(screen.getByText("1 unhealthy")).toBeInTheDocument();

    await user.click(screen.getByText("All statuses"));
    await user.click(await screen.findByRole("option", { name: "Unhealthy" }));
    expect(await screen.findByText("Acme transit")).toBeInTheDocument();
    expect(screen.queryByText("Provider 000")).toBeNull();
  });
});
