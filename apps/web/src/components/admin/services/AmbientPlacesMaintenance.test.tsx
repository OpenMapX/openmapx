import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../shared/AdminToast", () => ({ useAdminToast: () => vi.fn() }));

import { AmbientPlacesMaintenance } from "./AmbientPlacesMaintenance";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function view() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
        })
      }
    >
      <AmbientPlacesMaintenance apiUrl="http://fixture" />
    </QueryClientProvider>,
  );
}
describe("ambient operator workflow", () => {
  it("publishes the fixed Germany preset and keeps staged progress separate from active coverage", async () => {
    const fetch = vi.fn(async (_url: unknown, initValue?: unknown) => ({
      ok: true,
      json: async () =>
        (initValue as RequestInit | undefined)?.method
          ? { accepted: true }
          : { active: null, previous: null, building: false, lastError: null },
    }));
    vi.stubGlobal("fetch", fetch);
    view();
    fireEvent.click(await screen.findByRole("radio", { name: "Germany" }));
    expect(screen.queryByRole("textbox", { name: "Region name" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Publish Germany snapshot" }));
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        "http://fixture/api/admin/ambient-places/build",
        expect.objectContaining({
          body: JSON.stringify({
            name: "Germany",
            bounds: [5.8, 47.2, 15.1, 55.1],
            coverage: "germany",
          }),
        }),
      ),
    );
  });
  it("shows pending country rows without advertising a published country snapshot", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          active: null,
          previous: null,
          building: true,
          lastError: null,
          progress: { phase: "overture", processed: 6000, batches: 3, placeCount: 5200 },
        }),
      })),
    );
    view();
    expect(await screen.findByText(/5,200 staged places/)).toBeInTheDocument();
    expect(screen.getByText("Not published")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Publish map snapshot" })).toBeDisabled();
  });
  it("shows source versions and publishes the bounded Aachen preset", async () => {
    const fetch = vi.fn(async (_url: unknown, initValue?: unknown) => ({
      ok: true,
      json: async () =>
        (initValue as RequestInit | undefined)?.method
          ? { accepted: true }
          : {
              active: {
                generation: "generation-one",
                policyVersion: 2,
                publishedAt: "2026-10-07T10:00:00Z",
                placeCount: 42,
                enabled: true,
                region: { name: "Aachen", bounds: [5.9, 50.65, 6.3, 50.95] },
                sources: {
                  osm: { epoch: "osm-one", publishedAt: "2026-10-07", count: 42 },
                  overture: null,
                },
              },
              previous: null,
              building: false,
              lastError: null,
            },
    }));
    vi.stubGlobal("fetch", fetch);
    view();
    await screen.findByText(/osm-one/);
    expect(screen.getByText(/OSM only/)).toBeInTheDocument();
    expect(screen.getByText("Policy 2")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Publish map snapshot" }));
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        "http://fixture/api/admin/ambient-places/build",
        expect.objectContaining({
          method: "POST",
          credentials: "include",
          body: JSON.stringify({ name: "Aachen", bounds: [5.9, 50.65, 6.3, 50.95] }),
        }),
      ),
    );
  });
  it("shows a failed build and asks before rolling back the publication", async () => {
    const fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        active: null,
        previous: "previous-id",
        building: false,
        lastError: "Overture conflation must be completed",
      }),
    }));
    vi.stubGlobal("fetch", fetch);
    view();
    await screen.findByText(/Overture conflation must be completed/);
    fireEvent.click(screen.getByRole("button", { name: "Roll back" }));
    await screen.findByRole("dialog");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
