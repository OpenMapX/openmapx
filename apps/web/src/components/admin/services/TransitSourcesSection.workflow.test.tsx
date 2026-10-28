import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TransitSourcesSection } from "./TransitSourcesSection";

const clients: QueryClient[] = [];
const source = {
  id: "catalog:de:vbb",
  sourceRevision: "a".repeat(64),
  desiredState: "enabled",
  actions: { enable: false, disable: true, remove: false, reason: null },
  region: "de",
  name: "VBB",
  format: "gtfs",
  origin: "catalog",
  license: {},
  requested: true,
  active: true,
  lifecycle: "active",
};
const state = {
  transitousRef: null,
  transitousLockedAt: null,
  transitousLockedBy: null,
  lastSyncAt: null,
  lastSyncStatus: null,
  currentJob: null,
  feedCount: 1,
  feeds: { byRegion: { de: 1 }, byStatus: { active: 1 } },
};
function view() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <TransitSourcesSection apiUrl="https://api.example.test" />
    </QueryClientProvider>,
  );
  return client;
}
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => {
    client.clear();
  });
  vi.restoreAllMocks();
});
function reads(input: string) {
  if (input.endsWith("/transit/state")) return Response.json(state);
  return Response.json({
    sourceRevision: "a".repeat(64),
    sources: [source],
    total: 1,
    limit: 500,
    offset: 0,
  });
}

describe("transit source administration workflow", () => {
  it("uses the encoded source operation and records a validated accepted job", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, initValue) => {
      const init = initValue as RequestInit | undefined;
      expect(init?.credentials).toBe("include");
      if (init?.method === "POST") {
        expect(String(input)).toBe(
          "https://api.example.test/api/data-manager/transit/sources/catalog%3Ade%3Avbb/disable",
        );
        expect(JSON.parse(init.body as string)).toMatchObject({
          expectedSourceRevision: "a".repeat(64),
          idempotencyKey: expect.any(String),
        });
        return Response.json(
          { jobId: "job-visible", sourceId: source.id, status: "started" },
          { status: 202 },
        );
      }
      return reads(String(input));
    });
    const client = view();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    fireEvent.click(await screen.findByRole("button", { name: "Disable" }));
    expect(await screen.findByText("Source change queued as job-visible.")).toBeInTheDocument();
    expect(await screen.findByText("catalog:de:vbb queued as job-visible.")).toBeInTheDocument();
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["admin", "transit", "https://api.example.test"],
    });
    expect(
      fetch.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "POST"),
    ).toBe(true);
  });
  it("does not report a queued job or successful invalidation for a conflict", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) =>
      (init as RequestInit | undefined)?.method === "POST"
        ? Response.json(
            { ok: false, reason: "in-flight", existingJobId: "running" },
            { status: 409 },
          )
        : reads(String(input)),
    );
    const client = view();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    fireEvent.click(await screen.findByRole("button", { name: "Disable" }));
    expect(await screen.findByText("in-flight")).toBeInTheDocument();
    expect(screen.queryByText(/Source change queued as/)).not.toBeInTheDocument();
    expect(invalidate).not.toHaveBeenCalled();
  });
  it("confirms the exact operator source name before removing its saved metadata", async () => {
    const row = {
        ...source,
        id: "operator:de:local",
        name: "Local operator",
        origin: "operator",
        actions: { enable: false, disable: true, remove: true, reason: null },
      },
      mutations: RequestInit[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, initValue) => {
      const init = initValue as RequestInit | undefined;
      if (init?.method === "DELETE") {
        mutations.push(init);
        expect(JSON.parse(init.body as string).expectedSourceRevision).toBe("a".repeat(64));
        return Response.json(
          { jobId: "remove-job", sourceId: row.id, status: "started" },
          { status: 202 },
        );
      }
      if (String(input).endsWith("/transit/state")) return Response.json(state);
      return Response.json({
        sourceRevision: "a".repeat(64),
        sources: [row],
        total: 1,
        limit: 500,
        offset: 0,
      });
    });
    view();
    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
    expect(await screen.findByText(/Remove Local operator\?/)).toBeInTheDocument();
    expect(mutations).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Remove source" }));
    await waitFor(() => expect(mutations).toHaveLength(1));
  });
  it("shows desired-disabled but still active after failure and trusts server action decisions", async () => {
    const row = {
      ...source,
      requested: false,
      desiredState: "disabled",
      lifecycle: "removal-pending",
      actions: { enable: true, disable: false, remove: false, reason: null },
    };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
      String(input).endsWith("/transit/state")
        ? Response.json(state)
        : Response.json({
            sourceRevision: "a".repeat(64),
            sources: [row],
            total: 1,
            limit: 500,
            offset: 0,
          }),
    );
    view();
    expect(await screen.findByText("Disabled · active pending sync")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Enable" })).not.toBeDisabled();
    expect(screen.queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
  });
  it("gates catalog search on the dialog and two trimmed characters while retaining its raw key", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).includes("/transit/catalog")) {
        expect(new URL(String(input)).searchParams.get("search")).toBe("de");
        return Response.json({
          sources: [
            {
              id: source.id,
              name: source.name,
              source: "transitous",
              countryCode: "de",
              url: "https://example.test/vbb.zip",
            },
          ],
          total: 1,
        });
      }
      return reads(String(input));
    });
    const client = view();
    await screen.findByRole("button", { name: "Disable" });
    expect(fetch.mock.calls.some(([url]) => String(url).includes("/catalog"))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Add source" }));
    const search = await screen.findByRole("textbox", {
      name: "Search installed catalog (optional)",
    });
    fireEvent.change(search, { target: { value: " d " } });
    expect(fetch.mock.calls.some(([url]) => String(url).includes("/catalog"))).toBe(false);
    fireEvent.change(search, { target: { value: " de " } });
    expect(await screen.findByRole("button", { name: "Enable VBB (de)" })).toBeInTheDocument();
    await waitFor(() =>
      expect(
        client.getQueryData(["admin", "transit", "https://api.example.test", "catalog", " de "]),
      ).toMatchObject({
        total: 1,
      }),
    );
  });
});
