import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../shared/AdminToast", () => ({ useAdminToast: () => vi.fn() }));

import { AmbientPlacesMaintenance } from "./AmbientPlacesMaintenance";

const clients: QueryClient[] = [];
const generation = "11111111-1111-4111-8111-111111111111";
const date = "2026-10-07T10:00:00.000Z";
const idle = {
  active: null,
  previous: null,
  building: false,
  lastError: null,
  progress: null,
  candidate: null,
};
const checkpoint = {
  phase: "osm",
  processed: 2000,
  batches: 1,
  placeCount: 1999,
  osmType: "node",
  osmId: "2000",
  gers: "",
  osmProcessed: 2000,
  overtureProcessed: 0,
  osmCount: 1999,
  overtureCount: 0,
};
const active = {
  version: 2,
  attributionPrecision: "captured-fields",
  generation,
  policyVersion: 2,
  publishedAt: date,
  placeCount: 42,
  enabled: true,
  region: { name: "Aachen", bounds: [5.9, 50.65, 6.3, 50.95] },
  sources: {
    osm: { region: "europe/germany", epoch: "osm-one", publishedAt: date, count: 42 },
    overture: null,
  },
};
function response(status: unknown, init?: unknown) {
  return (init as RequestInit | undefined)?.method === "POST"
    ? Response.json({ accepted: true }, { status: 202, headers: { "cache-control": "no-store" } })
    : Response.json(status, { headers: { "cache-control": "no-store" } });
}
function view() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  return render(
    <QueryClientProvider client={client}>
      <AmbientPlacesMaintenance apiUrl="http://fixture" />
    </QueryClientProvider>,
  );
}
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => {
    client.clear();
  });
  vi.unstubAllGlobals();
});

describe("ambient operator workflow", () => {
  it("publishes the fixed planet preset and can resume an interrupted candidate", async () => {
    const fetch = vi.fn(async (_url, init) => response(idle, init));
    vi.stubGlobal("fetch", fetch);
    view();
    fireEvent.click(await screen.findByRole("radio", { name: "Planet" }));
    fireEvent.click(screen.getByRole("button", { name: "Publish planet snapshot" }));
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        "http://fixture/api/admin/ambient-places/build",
        expect.objectContaining({
          body: JSON.stringify({
            name: "Planet",
            bounds: [-180, -85.051129, 180, 85.051129],
            coverage: "planet",
          }),
        }),
      ),
    );
    cleanup();
    fetch.mockImplementation(async (_url, init) =>
      response(
        {
          ...idle,
          lastError: "Interrupted",
          candidate: {
            generation,
            status: "failed",
            checkpoint,
            error: "Interrupted",
            startedAt: date,
            updatedAt: date,
          },
        },
        init,
      ),
    );
    view();
    fireEvent.click(await screen.findByRole("button", { name: "Resume planet build" }));
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        "http://fixture/api/admin/ambient-places/resume",
        expect.objectContaining({ body: JSON.stringify({ generation }) }),
      ),
    );
    expect(screen.getByRole("button", { name: "Publish map snapshot" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Discard candidate" }));
    expect(await screen.findByRole("dialog")).toHaveTextContent(
      "Discard unpublished planet candidate?",
    );
  });
  it("publishes the fixed Germany preset and keeps staged progress separate from active coverage", async () => {
    const fetch = vi.fn(async (_url, init) => response(idle, init));
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
      vi.fn(async () =>
        Response.json(
          {
            ...idle,
            building: true,
            progress: { phase: "overture", processed: 6000, batches: 3, placeCount: 5200 },
          },
          { headers: { "cache-control": "no-store" } },
        ),
      ),
    );
    view();
    expect(await screen.findByText(/5,200 staged places/)).toBeInTheDocument();
    expect(screen.getByText("Not published")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Publish map snapshot" })).toBeDisabled();
  });
  it("shows source versions and publishes the bounded Aachen preset", async () => {
    const fetch = vi.fn(async (_url, init) => response({ ...idle, active }, init));
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
    const fetch = vi.fn(async () =>
      Response.json(
        { ...idle, previous: generation, lastError: "Overture conflation must be completed" },
        { headers: { "cache-control": "no-store" } },
      ),
    );
    vi.stubGlobal("fetch", fetch);
    view();
    await screen.findByText(/Overture conflation must be completed/);
    fireEvent.click(screen.getByRole("button", { name: "Roll back" }));
    await screen.findByRole("dialog");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
