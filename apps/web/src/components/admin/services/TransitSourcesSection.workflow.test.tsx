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
              installedSourceId: source.id,
              discoveryIds: [],
              name: source.name,
              source: "transitous",
              countryCode: "de",
              url: "https://example.test/vbb.zip",
            },
          ],
          total: 1,
          limit: 50,
          offset: 0,
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
        client.getQueryData([
          "admin",
          "transit",
          "https://api.example.test",
          "catalog",
          " de ",
          0,
          50,
        ]),
      ).toMatchObject({
        total: 1,
      }),
    );
  });
});
it("finds source601 through a server query instead of filtering the first500", async () => {
  const rows = Array.from({ length: 601 }, (_, n) => ({
    ...source,
    id: `catalog:de:${n}`,
    name: `Source ${String(n).padStart(4, "0")}`,
  }));
  const requests: URL[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/transit/state")) return Response.json(state);
    requests.push(url);
    const search = url.searchParams.get("search")?.toLowerCase(),
      matching = search ? rows.filter((r) => r.name.toLowerCase().includes(search)) : rows;
    const limit = Number(url.searchParams.get("limit") ?? 50),
      offset = Number(url.searchParams.get("offset") ?? 0);
    return Response.json({
      sourceRevision: "a".repeat(64),
      sources: matching.slice(offset, offset + limit),
      total: matching.length,
      limit,
      offset,
    });
  });
  view();
  await screen.findByText("Source 0000");
  fireEvent.click(screen.getByRole("button", { name: "Go to next page" }));
  await screen.findByText("Source 0050");
  fireEvent.change(screen.getByPlaceholderText(/Search sources by name/), {
    target: { value: "Source 0600" },
  });
  expect(await screen.findByText("Source 0600")).toBeInTheDocument();
  expect(
    requests.some(
      (url) =>
        url.searchParams.get("search") === "Source 0600" && url.searchParams.get("offset") === "0",
    ),
  ).toBe(true);
  fireEvent.change(screen.getByPlaceholderText(/Search sources by name/), {
    target: { value: "" },
  });
  expect(await screen.findByText("Source 0000")).toBeInTheDocument();
  expect(screen.queryByText("Source 0050")).not.toBeInTheDocument();
});
it("opens a country review before submitting a transit sync", async () => {
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input) => reads(String(input)));
  view();
  await screen.findByText("VBB");
  fireEvent.click(screen.getByRole("button", { name: "Sync sources" }));
  expect(await screen.findByRole("dialog", { name: "Review transit sync" })).toBeInTheDocument();
  expect(
    fetch.mock.calls.some(
      ([url, init]) =>
        String(url).endsWith("/transit/sync") &&
        (init as RequestInit | undefined)?.method === "POST",
    ),
  ).toBe(false);
});
it("uses a discovery-only result to fill Add and retains its declared license and credit", async () => {
  const mutations: unknown[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if ((init as RequestInit | undefined)?.method === "POST") {
      mutations.push(input);
      return Response.json({});
    }
    if (String(input).includes("/catalog"))
      return Response.json({
        sources: [
          {
            id: "mobilitydb:demo",
            installedSourceId: null,
            discoveryIds: ["mobilitydb:demo"],
            name: "Demo",
            source: "mobilitydb",
            countryCode: "de",
            url: "https://example.test/demo.zip",
            licensing: {
              version: 1,
              bindings: [
                {
                  scope: "data",
                  subject: "Demo publisher",
                  license: { kind: "spdx", expression: "CC-BY-4.0" },
                  notice: "Credit Demo",
                },
              ],
            },
          },
        ],
        total: 1,
        limit: 50,
        offset: 0,
      });
    return reads(String(input));
  });
  view();
  await screen.findByText("VBB");
  fireEvent.click(screen.getByRole("button", { name: "Add source" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Search installed catalog (optional)" }), {
    target: { value: "Demo" },
  });
  fireEvent.click(await screen.findByRole("button", { name: "Use Demo (de)" }));
  expect(screen.getByRole("textbox", { name: "Schedule URL" })).toHaveValue(
    "https://example.test/demo.zip",
  );
  expect(screen.getByRole("textbox", { name: "SPDX license" })).toHaveValue("CC-BY-4.0");
  expect(screen.getByRole("textbox", { name: "Attribution" })).toHaveValue(
    "Demo publisher\nCredit Demo",
  );
  expect(mutations).toEqual([]);
});

it("ignores old origin and out-of-order search pages", async () => {
  let old: ((response: Response) => void) | undefined;
  let earlier: ((response: Response) => void) | undefined;
  const page = (name: string) =>
    Response.json({
      sourceRevision: "a".repeat(64),
      sources: [{ ...source, name }],
      total: 1,
      limit: 50,
      offset: 0,
    });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/state")) return Response.json(state);
    if (url.hostname === "old.example.test")
      return new Promise<Response>((resolve) => {
        old = resolve;
      });
    if (url.searchParams.get("search") === "earlier")
      return new Promise<Response>((resolve) => {
        earlier = resolve;
      });
    return page(url.searchParams.get("search") === "latest" ? "Latest page" : "Current instance");
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  const renderView = (apiUrl: string) => (
    <QueryClientProvider client={client}>
      <TransitSourcesSection apiUrl={apiUrl} />
    </QueryClientProvider>
  );
  const rendered = render(renderView("https://old.example.test"));
  await waitFor(() => expect(old).toBeTypeOf("function"));
  rendered.rerender(renderView("https://new.example.test"));
  await screen.findByText("Current instance");
  old?.(page("Old instance"));
  fireEvent.change(screen.getByPlaceholderText(/Search sources by name/), {
    target: { value: "earlier" },
  });
  await waitFor(() => expect(earlier).toBeTypeOf("function"));
  fireEvent.change(screen.getByPlaceholderText(/Search sources by name/), {
    target: { value: "latest" },
  });
  await screen.findByText("Latest page");
  earlier?.(page("Earlier page"));
  await waitFor(() => expect(client.isFetching()).toBe(0));
  expect(screen.getByText("Latest page")).toBeInTheDocument();
  expect(screen.queryByText("Earlier page")).not.toBeInTheDocument();
  expect(screen.queryByText("Old instance")).not.toBeInTheDocument();
});
