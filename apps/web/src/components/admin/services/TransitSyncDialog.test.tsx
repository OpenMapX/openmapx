import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TransitSyncDialog } from "./TransitSyncDialog";

const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((c) => {
    c.clear();
  });
  vi.restoreAllMocks();
});
const policy = {
  profile: "regional-assisted",
  countries: ["de", "at"],
  feedAllowList: [],
  acquisition: "mirror",
  artifactOrigins: ["https://api.transitous.org"],
  originDownloadsRequired: false,
  hostedRuntimeFallbackAllowed: true,
  gbfsSelection: "explicit-countries",
  maxFeedCount: 500,
  retentionGenerations: 2,
  resourceEnvelope: {
    minimumMemoryGb: 16,
    minimumCpu: 4,
    minimumDiskGb: 40,
    operatorCapacityRequired: false,
  },
  updateCadenceHours: 24,
  experimental: false,
};
function preview(countries: string[], ok: boolean) {
  return {
    preflightId: "00000000-0000-4000-8000-000000000001",
    fingerprint: "a".repeat(64),
    expiresAt: new Date(Date.now() + 300000).toISOString(),
    countries,
    allowedCountries: ["de", "at"],
    result: {
      ok,
      policy: { ...policy, countries },
      estimate: {
        feedCount: 1,
        measuredCompressedBytes: 0,
        compressedBytes: 1,
        expandedGtfsBytes: 1,
        importedMotisBytes: 1,
        osmBytes: 0,
        proxyCacheBytes: 1,
        requiredDiskBytes: 10,
        basis: "conservative-defaults",
      },
      capacity: {
        freeDiskBytes: ok ? 100 : 0,
        slotMemoryGb: 16,
        slotCpu: 4,
        fileDescriptorLimit: 65536,
        buildTimeoutHours: 12,
      },
      blockers: ok ? [] : ["insufficient disk"],
      warnings: ["size estimate uses conservative defaults"],
    },
  };
}
function view() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  const queued = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <TransitSyncDialog apiUrl="https://api.example.test" onClose={() => {}} onQueued={queued} />
    </QueryClientProvider>,
  );
  return queued;
}
it("shows server blockers and never queues a blocked preview", async () => {
  const submissions: unknown[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (String(input).endsWith("/profile")) return Response.json({ policy });
    if (String(input).endsWith("/preflight"))
      return Response.json(
        preview(JSON.parse(String((init as RequestInit | undefined)?.body)).countries, false),
      );
    submissions.push(input);
    return Response.json({});
  });
  view();
  await screen.findByLabelText("DE");
  fireEvent.click(screen.getByRole("button", { name: "Preview sync" }));
  expect(await screen.findByText("insufficient disk")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Queue sync" })).toBeDisabled();
  expect(submissions).toEqual([]);
});
it("submits only the reviewed subset and retains its exact intent on a failed response", async () => {
  const submitted: Record<string, unknown>[] = [],
    previews: string[][] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (String(input).endsWith("/profile")) return Response.json({ policy });
    const body = JSON.parse(String((init as RequestInit | undefined)?.body));
    if (String(input).endsWith("/preflight")) {
      previews.push(body.countries);
      return Response.json(preview(body.countries, true));
    }
    submitted.push(body);
    return submitted.length === 1
      ? Response.json({ error: "fixture unavailable" }, { status: 503 })
      : Response.json({ ok: true, jobId: "queued-1", status: "started" }, { status: 202 });
  });
  const queued = view();
  await screen.findByLabelText("AT");
  fireEvent.click(screen.getByLabelText("AT"));
  fireEvent.click(screen.getByRole("button", { name: "Preview sync" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Queue sync" })).not.toBeDisabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Queue sync" }));
  await screen.findByText(/Check Activity/);
  fireEvent.click(screen.getByRole("button", { name: "Queue sync" }));
  await waitFor(() => expect(queued).toHaveBeenCalledWith("queued-1"));
  expect(previews).toEqual([["de"]]);
  expect(submitted).toHaveLength(2);
  expect(submitted[1]).toEqual(submitted[0]);
  expect(submitted[0]).toMatchObject({
    countries: ["de"],
    preflightId: "00000000-0000-4000-8000-000000000001",
    fingerprint: "a".repeat(64),
    idempotencyKey: expect.any(String),
  });
});
it("invalidates a ready preview when the country selection changes", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) =>
    String(input).endsWith("/profile")
      ? Response.json({ policy })
      : Response.json(
          preview(JSON.parse(String((init as RequestInit | undefined)?.body)).countries, true),
        ),
  );
  view();
  await screen.findByLabelText("AT");
  fireEvent.click(screen.getByRole("button", { name: "Preview sync" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Queue sync" })).not.toBeDisabled(),
  );
  fireEvent.click(screen.getByLabelText("AT"));
  expect(screen.getByRole("button", { name: "Queue sync" })).toBeDisabled();
});
it("preserves a typed separator while choosing an explicit planet subset", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    Response.json({ policy: { ...policy, profile: "planet", countries: [] } }),
  );
  view();
  const input = await screen.findByRole("textbox", { name: "Country codes" });
  fireEvent.change(input, { target: { value: "de," } });
  expect(input).toHaveValue("de,");
});
it("does not associate a late sync acceptance with a newly selected instance", async () => {
  let deliver: ((value: Response) => void) | undefined;
  const queued = vi.fn(),
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (String(input).endsWith("/profile")) return Response.json({ policy });
    if (String(input).endsWith("/preflight"))
      return Response.json(
        preview(JSON.parse(String((init as RequestInit | undefined)?.body)).countries, true),
      );
    return new Promise<Response>((resolve) => {
      deliver = resolve;
    });
  });
  const screenView = render(
    <QueryClientProvider client={client}>
      <TransitSyncDialog apiUrl="https://old.example.test" onClose={() => {}} onQueued={queued} />
    </QueryClientProvider>,
  );
  await screen.findByLabelText("DE");
  fireEvent.click(screen.getByRole("button", { name: "Preview sync" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Queue sync" })).not.toBeDisabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Queue sync" }));
  await waitFor(() => expect(deliver).toBeDefined());
  screenView.rerender(
    <QueryClientProvider client={client}>
      <TransitSyncDialog apiUrl="https://new.example.test" onClose={() => {}} onQueued={queued} />
    </QueryClientProvider>,
  );
  deliver?.(
    Response.json({ ok: true, jobId: "old-instance-job", status: "started" }, { status: 202 }),
  );
  await waitFor(() => expect(client.isMutating()).toBe(0));
  expect(screen.getByRole("button", { name: "Queue sync" })).toBeDisabled();
  expect(queued).not.toHaveBeenCalled();
});
