// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQueryWrapper, render, screen, userEvent } from "@/test";
import type { IntegrationSummary } from "../IntegrationList";

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
    enabled: i % 2 === 0,
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
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => makeIntegrations(60),
    });
  });

  it("renders at most rowsPerPage rows for an oversized dataset", async () => {
    render(<IntegrationList />, { wrapper: createQueryWrapper() });

    await screen.findByText("Provider 000");
    const names = screen.getAllByText(/^Provider \d{3}$/);
    expect(names.length).toBe(25); // default rowsPerPage
  });

  it("shows the full filtered count in the pager", async () => {
    render(<IntegrationList />, { wrapper: createQueryWrapper() });
    await screen.findByText("Provider 000");
    await screen.findByText(/of 60/);
  });

  it("shows the next slice when paging forward", async () => {
    const user = userEvent.setup();
    render(<IntegrationList />, { wrapper: createQueryWrapper() });

    await screen.findByText("Provider 000");
    // Page 1 = providers 000..024; 025 is on page 2.
    expect(screen.queryByText("Provider 025")).toBeNull();

    const nextButton = await screen.findByRole("button", { name: /next page/i });
    await user.click(nextButton);

    await screen.findByText("Provider 025");
    expect(screen.queryByText("Provider 000")).toBeNull();
  });

  it("resets to the first page when a filter changes", async () => {
    const user = userEvent.setup();
    render(<IntegrationList />, { wrapper: createQueryWrapper() });

    await screen.findByText("Provider 000");

    // Advance to page 2.
    const nextButton = await screen.findByRole("button", { name: /next page/i });
    await user.click(nextButton);
    await screen.findByText("Provider 025");

    // Typing in search filters AND resets to page 1: the matching subset starts
    // from the first page again.
    const searchBox = screen.getByPlaceholderText("Search by name, id, domain…");
    await user.type(searchBox, "provider-0");

    // After the filter, page must be back to 0, so the first matching row is
    // visible and the pager reports page 1 of the filtered set.
    await screen.findByText("Provider 000");
  });
});
