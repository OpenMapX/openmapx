// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQueryWrapper, render, screen, userEvent, waitFor } from "@/test";

vi.mock("@/lib/EnvProvider", () => ({
  useEnv: () => ({ apiUrl: "http://test.local" }),
}));

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

import { AppLogViewer } from "../AppLogViewer";

function makeEntries(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: i,
    level: "info",
    source: "api",
    msg: `entry ${i}`,
    time: 1700000000000 + i,
  }));
}

/** Latest request URL passed to fetch, as a URL object. */
function lastFetchUrl(): URL {
  const calls = fetchMock.mock.calls;
  return new URL(calls[calls.length - 1][0] as string);
}

beforeEach(() => {
  // Default: a full first page plus more total so a next page exists.
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ entries: makeEntries(100), total: 250, sources: ["api"] }),
  });
});

afterEach(() => {
  fetchMock.mockReset();
});

describe("AppLogViewer", () => {
  it("sends limit + offset=0 on the first page and honors data.total", async () => {
    render(<AppLogViewer />, { wrapper: createQueryWrapper() });

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = lastFetchUrl();
    expect(url.pathname).toBe("/api/admin/logs");
    expect(url.searchParams.get("limit")).toBe("100");
    expect(url.searchParams.get("offset")).toBe("0");

    // TablePagination reflects the API-reported total (250), not the page size.
    await screen.findByText(/of 250/);
  });

  it("sends offset = page * rowsPerPage when the next page is requested", async () => {
    const user = userEvent.setup();
    render(<AppLogViewer />, { wrapper: createQueryWrapper() });

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const nextButton = await screen.findByRole("button", { name: /next page/i });
    await user.click(nextButton);

    await waitFor(() => expect(lastFetchUrl().searchParams.get("offset")).toBe("100"));
    expect(lastFetchUrl().searchParams.get("limit")).toBe("100");
  });

  it("resets to the first page (offset=0) when a filter changes", async () => {
    const user = userEvent.setup();
    render(<AppLogViewer />, { wrapper: createQueryWrapper() });

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    // Advance to page 2 first.
    const nextButton = await screen.findByRole("button", { name: /next page/i });
    await user.click(nextButton);
    await waitFor(() => expect(lastFetchUrl().searchParams.get("offset")).toBe("100"));

    // Changing the search field must reset offset back to 0.
    const searchBox = screen.getByPlaceholderText("Search…");
    await user.type(searchBox, "boom");

    await waitFor(() => {
      const url = lastFetchUrl();
      expect(url.searchParams.get("offset")).toBe("0");
      expect(url.searchParams.get("search")).toBe("boom");
    });
  });
});
