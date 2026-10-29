import { en } from "@openmapx/i18n";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminJobEffectsProvider } from "@/lib/admin/adminJobEffects";
import { NotablePlacesMaintenance, notablePlacesStatusQueryKey } from "./NotablePlacesMaintenance";
import { OvertureMaintenance, overtureStatusQueryKey } from "./OvertureMaintenance";
import { SearchIndexMaintenance, searchIndexStatusQueryKey } from "./SearchIndexMaintenance";

const apiUrl = "https://api.example.test";
vi.mock("@/integration-api/runtime/EnvProvider", () => ({ useEnv: () => ({ apiUrl }) }));
vi.mock("../shared/AdminToast", () => ({ useAdminToast: () => vi.fn() }));
const clients: QueryClient[] = [];
function view(Component: typeof SearchIndexMaintenance) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
        <AdminJobEffectsProvider>
          <Component apiUrl={apiUrl} />
        </AdminJobEffectsProvider>
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
  return client;
}
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => {
    client.clear();
  });
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("maintenance status contracts", () => {
  it.each([
    ["search", SearchIndexMaintenance],
    ["notable", NotablePlacesMaintenance],
    ["Overture", OvertureMaintenance],
  ] as const)("rejects a malformed absent response in %s", async (_name, Component) => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({}, { status: 404 }),
    );
    view(Component);
    expect(await screen.findByRole("alert")).toHaveTextContent(/Failed to load|contract/i);
  });
  it.each([
    [
      "search",
      SearchIndexMaintenance,
      searchIndexStatusQueryKey(apiUrl),
      /No local OSM alias index is published/,
    ],
    [
      "notable",
      NotablePlacesMaintenance,
      notablePlacesStatusQueryKey(apiUrl),
      /No notable-places index is published yet/,
    ],
    [
      "Overture",
      OvertureMaintenance,
      overtureStatusQueryKey(apiUrl),
      /Overture Places has not been ingested yet/,
    ],
  ] as const)(
    "keeps a validated 404 as successful absence in %s",
    async (_name, Component, key, notice) => {
      const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
        expect((init as RequestInit | undefined)?.credentials).toBe("include");
        return Response.json({ ok: false, error: "not built" }, { status: 404 });
      });
      const client = view(Component);
      expect(await screen.findByRole("alert")).toHaveTextContent(notice);
      expect(client.getQueryData(key)).toBeNull();
      expect(client.getQueryState(key)?.status).toBe("success");
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );
  it("keeps authentication errors separate from an absent index", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ error: "Authentication required" }, { status: 401 }),
    );
    const client = view(NotablePlacesMaintenance);
    expect(await screen.findByRole("alert")).toHaveTextContent("Authentication required");
    expect(client.getQueryState(notablePlacesStatusQueryKey(apiUrl))?.status).toBe("error");
    expect(screen.queryByText(/No notable-places index is published yet/)).not.toBeInTheDocument();
  });
  it("polls a building search index at ten seconds and a ready index at sixty", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      attempts++;
      return Response.json({
        ok: true,
        region: "europe/germany",
        sourcePath: "/data/osm/de.osm.pbf",
        sourceFingerprint: "source",
        currentFingerprint: "source",
        epoch: "epoch",
        status: attempts === 1 ? "building" : "ready",
        building: attempts === 1,
        stale: false,
        placeCount: 1,
        termCount: 2,
        startedAt: null,
        publishedAt: null,
        updatedAt: "2026-10-19T00:00:00.000Z",
        lastError: null,
      });
    });
    const client = view(SearchIndexMaintenance);
    const key = searchIndexStatusQueryKey(apiUrl);
    await act(async () => {
      await vi.waitFor(() =>
        expect(client.getQueryData<{ building: boolean }>(key)?.building).toBe(true),
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9_000);
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.waitFor(() =>
        expect(client.getQueryData<{ building: boolean }>(key)?.building).toBe(false),
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(58_000);
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
