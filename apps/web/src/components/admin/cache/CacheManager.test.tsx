// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueryWrapper, render, screen, userEvent, waitFor, within } from "@/test";

vi.mock("@/integration-api/runtime/EnvProvider", () => ({
  useEnv: () => ({ apiUrl: "http://test.local" }),
}));

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

import { CacheManager } from "./CacheManager";

const LIST_BODY = {
  namespaces: [
    { namespace: "int:geocoding", keyCount: 12 },
    { namespace: "cache:geocode", keyCount: 3 },
  ],
};

/** Route fetches: the list endpoint returns namespaces, clear returns a count. */
function mockRoutes() {
  fetchMock.mockImplementation((...args: unknown[]) => {
    const url = String(args[0]);
    if (url.endsWith("/api/admin/cache/clear")) {
      return Promise.resolve({ ok: true, json: async () => ({ deleted: 12 }) });
    }
    return Promise.resolve({ ok: true, json: async () => LIST_BODY });
  });
}

/** Calls made to the clear endpoint. */
function clearCalls(): unknown[][] {
  return fetchMock.mock.calls.filter((c) => String(c[0]).endsWith("/clear"));
}

/** Latest request body passed to a clear call, parsed. */
function lastClearBody(): unknown {
  const calls = clearCalls();
  const last = calls[calls.length - 1];
  return JSON.parse((last[1] as { body: string }).body);
}

afterEach(() => {
  fetchMock.mockReset();
});

describe("CacheManager", () => {
  it("renders namespace rows with key counts", async () => {
    mockRoutes();
    render(<CacheManager />, { wrapper: createQueryWrapper() });

    await screen.findByText("int:geocoding");
    expect(screen.getByText("cache:geocode")).toBeDefined();
    expect(screen.getByText("12")).toBeDefined();
    expect(screen.getByText("3")).toBeDefined();
  });

  it("clears a single namespace through the confirm dialog", async () => {
    const user = userEvent.setup();
    mockRoutes();
    render(<CacheManager />, { wrapper: createQueryWrapper() });

    await screen.findByText("int:geocoding");

    // First row's per-namespace Clear button.
    const clearButtons = screen.getAllByRole("button", { name: "Clear" });
    await user.click(clearButtons[0]);

    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Clear" }));

    await waitFor(() => expect(clearCalls().length).toBe(1));
    expect(lastClearBody()).toEqual({ namespace: "int:geocoding" });
  });

  it("clears all caches via the Clear all button with an empty body", async () => {
    const user = userEvent.setup();
    mockRoutes();
    render(<CacheManager />, { wrapper: createQueryWrapper() });

    await screen.findByText("int:geocoding");

    await user.click(screen.getByRole("button", { name: /clear all/i }));

    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Clear" }));

    await waitFor(() => expect(clearCalls().length).toBe(1));
    expect(lastClearBody()).toEqual({});
  });

  it("shows an empty state when there is no cached data", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ namespaces: [] }) });
    render(<CacheManager />, { wrapper: createQueryWrapper() });

    await screen.findByText("No cached data found");
  });
});
