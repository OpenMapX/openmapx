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
  it("previews a scoped glob and confirms only the captured preview target", async () => {
    const user = userEvent.setup();
    mockRoutes();
    fetchMock.mockImplementation(async (url, options) =>
      String(url).endsWith("/clear")
        ? {
            ok: true,
            json: async () =>
              JSON.parse((options as { body: string }).body).dryRun
                ? { dryRun: true, estimatedCount: 2, patterns: ["int:geocoding:*"] }
                : { deleted: 2, patterns: ["int:geocoding:*"] },
          }
        : { ok: true, json: async () => LIST_BODY },
    );
    render(<CacheManager />, { wrapper: createQueryWrapper() });
    await user.type(screen.getByLabelText("Cache pattern"), "int:geocoding:*");
    await user.click(screen.getByRole("button", { name: "Preview pattern" }));
    await screen.findByText(/Estimated matching keys: 2/);
    expect(lastClearBody()).toEqual({ pattern: "int:geocoding:*", dryRun: true });
    await user.click(screen.getByRole("button", { name: "Clear previewed pattern" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(lastClearBody()).toEqual({ pattern: "int:geocoding:*" }));
  });
  it("invalidates the displayed preview on edit and prevents foreign-prefix requests", async () => {
    const user = userEvent.setup();
    mockRoutes();
    fetchMock.mockImplementation(async (url) => ({
      ok: true,
      json: async () =>
        String(url).endsWith("/clear")
          ? { dryRun: true, estimatedCount: 2, patterns: ["int:geocoding:*"] }
          : LIST_BODY,
    }));
    render(<CacheManager />, { wrapper: createQueryWrapper() });
    const input = screen.getByLabelText("Cache pattern");
    await user.type(input, "session:*");
    expect(screen.getByRole("button", { name: "Preview pattern" })).toBeDisabled();
    expect(clearCalls()).toHaveLength(0);
    await user.clear(input);
    await user.type(input, "int:geocoding:*");
    await user.click(screen.getByRole("button", { name: "Preview pattern" }));
    await screen.findByText(/Estimated matching keys: 2/);
    await user.clear(input);
    await user.type(input, "cache:*");
    expect(screen.queryByText(/Estimated matching keys/)).toBeNull();
    expect(screen.getByRole("button", { name: "Clear previewed pattern" })).toBeDisabled();
    expect(clearCalls()).toHaveLength(1);
  });
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
