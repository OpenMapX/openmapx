// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueryWrapper, render, screen, userEvent, waitFor, within } from "@/test";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntlWithCatalog());

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
  fetchMock.mockImplementation(async (url: unknown, init?: unknown) => {
    if (!String(url).endsWith("/api/admin/cache/clear")) return Response.json(LIST_BODY);
    return Response.json(
      JSON.parse(String((init as RequestInit | undefined)?.body)).dryRun
        ? { dryRun: true, estimatedCount: 2, patterns: ["int:geocoding:*"] }
        : { deleted: 12, patterns: ["int:geocoding:*"] },
    );
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

  it("clears a single namespace through the confirm dialog", async () => {
    const user = userEvent.setup();
    mockRoutes();
    render(<CacheManager />, { wrapper: createQueryWrapper() });

    await screen.findByText("int:geocoding");
    expect(screen.getByText("cache:geocode")).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();

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
    fetchMock.mockImplementation(async () => Response.json({ namespaces: [] }));
    render(<CacheManager />, { wrapper: createQueryWrapper() });

    await screen.findByText("No cached data found");
  });

  it("loads through the same-origin admin client with credentials and the query signal", async () => {
    mockRoutes();
    render(<CacheManager />, { wrapper: createQueryWrapper() });
    await screen.findByText("int:geocoding");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://test.local/api/admin/cache");
    expect(init.credentials).toBe("include");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("aborts the namespace request when the page unmounts", async () => {
    let signal: AbortSignal | undefined;
    fetchMock.mockImplementation(
      (_url: unknown, init?: unknown) =>
        new Promise<Response>((_resolve, reject) => {
          signal = (init as RequestInit | undefined)?.signal ?? undefined;
          signal?.addEventListener("abort", () => reject(signal?.reason), { once: true });
        }),
    );
    const { unmount } = render(<CacheManager />, { wrapper: createQueryWrapper() });
    await waitFor(() => expect(signal).toBeDefined());
    unmount();
    await waitFor(() => expect(signal?.aborted).toBe(true));
  });

  it("shows the server's preview refusal instead of a generic failure", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(async (url: unknown) =>
      String(url).endsWith("/clear")
        ? Response.json({ error: "Pattern too broad" }, { status: 400 })
        : Response.json(LIST_BODY),
    );
    render(<CacheManager />, { wrapper: createQueryWrapper() });
    await user.type(screen.getByLabelText("Cache pattern"), "int:*");
    await user.click(screen.getByRole("button", { name: "Preview pattern" }));
    expect(await screen.findByText("Pattern too broad")).toBeInTheDocument();
  });

  it("refuses a malformed namespace list rather than rendering it", async () => {
    fetchMock.mockImplementation(async () =>
      Response.json({ namespaces: [{ namespace: "int:geocoding", keyCount: -1 }] }),
    );
    render(<CacheManager />, { wrapper: createQueryWrapper() });
    expect(await screen.findByText("Failed to load the cache.")).toBeInTheDocument();
  });
});
