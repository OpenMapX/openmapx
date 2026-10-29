import { en } from "@openmapx/i18n";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { NextIntlClientProvider } from "next-intl";
import { Component, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { job } from "@/components/admin/activity/__tests__/fixtures";
import { useActivityClient } from "@/components/admin/activity/activityQueries";
import { AdminJobEffectsProvider } from "@/lib/admin/adminJobEffects";
import { serviceAdminQueries } from "@/lib/admin/serviceAdmin";
import {
  act,
  cleanup,
  createTestQueryClient,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@/test";
import { AdminOperationCard } from "../operations/AdminOperationCard";
import type { AdminOperationContract } from "../operations/adminOperationsApi";
import { BackupsPage } from "./BackupsPage";
import { DataWorkflowsPage } from "./DataWorkflowsPage";
import { NotablePlacesMaintenance } from "./NotablePlacesMaintenance";
import { OvertureMaintenance } from "./OvertureMaintenance";
import { SearchIndexMaintenance } from "./SearchIndexMaintenance";

let apiUrl = "http://admin.test";
const toast = vi.fn();
vi.mock("@/integration-api/runtime/EnvProvider", () => ({ useEnv: () => ({ apiUrl }) }));
vi.mock("../shared/AdminToast", () => ({ useAdminToast: () => toast }));
// These unrelated acquisition families are outside Task4.
vi.mock("./AmbientPlacesMaintenance", () => ({ AmbientPlacesMaintenance: () => null }));
vi.mock("./TransitSourcesSection", () => ({ TransitSourcesSection: () => null }));
const at = "2026-10-21T10:00:00.000Z";
const inventory = {
  fetchedAt: at,
  osm: {
    found: true,
    filename: "synthetic.osm.pbf",
    sizeBytes: 42,
    modifiedAt: at,
    region: "test",
  },
  builds: [{ target: "motis", built: true, builtAt: at }],
  motisTransitous: {
    configFound: true,
    datasetCount: 1,
    realtimeFeedCount: 2,
    gbfsFeedCount: 3,
    feedProxyUrlCount: 4,
    gbfsProxyUrl: null,
    feedProxyMode: "mixed",
    feedProxyConfigFound: true,
    feedProxyVarsFound: false,
    feedProxyFeedCount: 5,
    capabilityState: "error",
    capabilityError: "Synthetic",
    activeEpoch: null,
    candidateEpoch: "candidate",
    testedAt: null,
    configHash: "a".repeat(64),
    licenseHash: null,
    rentalProviderCount: 6,
    rentalProviderGroupCount: 7,
    rollbackAvailable: true,
    operationsProfile: "planet",
    activeSlot: "A",
    previousHealthySlot: "B",
    preflightState: "blocked",
    preflightRequiredDiskBytes: 100,
    preflightFreeDiskBytes: null,
    pinProposalPending: true,
    crowdsourceState: "disabled-pending-review",
    gbfsCatalog: {
      state: "error",
      commit: null,
      lockedAt: null,
      registryRows: 1,
      registryAdded: 2,
      transitousPreferred: 3,
      quarantined: 4,
      validationFailed: 5,
      sources: [
        {
          sourceId: "source",
          country: "DE",
          status: "excluded",
          observation: "unknown",
          errorClass: "Synthetic",
          lastObservedSuccess: "unknown",
          lastErrorAt: "unknown",
          dataAge: "unknown",
        },
      ],
    },
  },
};
const backup = {
  name: "snapshot-1",
  createdAt: at,
  serviceCount: 17,
  volumeCount: 23,
  totalBytes: 1024,
};
const operation: AdminOperationContract = {
  id: "update",
  version: 3,
  group: "osm",
  title: "Update data",
  description: "Synthetic operation",
  risk: "normal",
  fields: [
    { name: "region", label: "Region", kind: "text" },
    { name: "failFast", label: "Fail fast", kind: "boolean" },
  ],
  defaults: { region: "old", failFast: false },
};
const preview = {
  ok: true,
  input: { region: "old", failFast: false },
  preview: ["Refresh synthetic data"],
  risk: "normal",
};
const caches: ReturnType<typeof createTestQueryClient>[] = [];
function pending<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { resolve, promise };
}
class Boundary extends Component<{ children: ReactNode }, { crashed: boolean }> {
  override state = { crashed: false };
  static getDerivedStateFromError() {
    return { crashed: true };
  }
  override render() {
    return this.state.crashed ? <span>render crashed</span> : this.props.children;
  }
}
function InventoryStatus() {
  const { client, apiUrl } = useActivityClient();
  const { data } = useQuery(serviceAdminQueries(client, apiUrl).data());
  return <output>{data?.osm.region}</output>;
}
function setup(
  handler?: (url: URL, init: RequestInit) => Response | Promise<Response> | undefined,
) {
  const requests: { url: URL; init: RequestInit }[] = [];
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    requests.push({ url, init });
    if (url.pathname.endsWith("/overture/recovery"))
      return Response.json({
        region: "europe/germany",
        busy: false,
        osmAvailable: true,
        downloadedRelease: "2026-10-21.0",
        installedRelease: "2026-10-21.0",
        actions: Object.fromEntries(
          [
            "overture-pull",
            "overture-ingest",
            "overture-extract",
            "overture-conflate",
            "overture-restart",
          ].map((id) => [id, { allowed: true, reason: null }]),
        ),
      });
    const result = handler?.(url, init);
    if (result) return result;
    if (url.pathname.startsWith("/api/admin/jobs/"))
      return Response.json(job({ id: url.pathname.split("/").at(-1), status: "cancel_pending" }));
    if (url.pathname.endsWith("/backups"))
      return Response.json({
        backups: [backup],
        warnings: ["Synthetic warning"],
        root: "ops-agent-managed",
      });
    if (url.pathname.endsWith("/services/data")) return Response.json(inventory);
    if (url.pathname.endsWith("/shared-mobility"))
      return Response.json({ rollbackCategories: [], decisions: [] });
    if (url.pathname.endsWith("/operations")) return Response.json({ operations: [operation] });
    if (url.pathname.endsWith("/preview")) return Response.json(preview);
    if (url.pathname.endsWith("/run")) return Response.json({ ok: true, jobId: "job-1" });
    if (url.pathname.includes("/data-manager/"))
      return Response.json({ error: "No snapshot" }, { status: 404 });
    throw new Error(`Unexpected synthetic request ${url.pathname}`);
  });
  return requests;
}
function mount(child: ReactNode) {
  const qc = createTestQueryClient();
  qc.setDefaultOptions({
    queries: { retry: false, gcTime: Infinity },
    mutations: { retry: 2, retryDelay: 1 },
  });
  caches.push(qc);
  const view = (next: ReactNode) => (
    <QueryClientProvider client={qc}>
      <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
        <AdminJobEffectsProvider>
          <Boundary>{next}</Boundary>
        </AdminJobEffectsProvider>
      </NextIntlClientProvider>
    </QueryClientProvider>
  );
  return { qc, view, ...render(view(child)) };
}
function card(contract = operation) {
  return (
    <AdminOperationCard
      apiUrl={apiUrl}
      operation={contract}
      onQueued={(id) => toast(id)}
      onError={(message) => toast(message, "error")}
    />
  );
}
beforeEach(() => {
  apiUrl = "http://admin.test";
  toast.mockClear();
});
afterEach(() => {
  cleanup();
  for (const qc of caches.splice(0)) qc.clear();
  vi.unstubAllGlobals();
});

describe("service workflows through actual generated transport", () => {
  it("renders producer backup counts, warnings, managed root and corruption", async () => {
    setup(() =>
      Response.json({
        backups: [
          backup,
          { ...backup, name: "broken", corrupt: true, corruptReason: "invalid_manifest" },
        ],
        warnings: ["Synthetic warning"],
        root: "ops-agent-managed",
      }),
    );
    mount(<BackupsPage />);
    const row = (await screen.findByText("snapshot-1")).closest("tr");
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText("17")).toBeInTheDocument();
    expect(within(row as HTMLElement).getByText("23")).toBeInTheDocument();
    expect(screen.getByText("Synthetic warning")).toBeInTheDocument();
    expect(screen.getByText(/ops-agent-managed/)).toBeInTheDocument();
    const corrupt = screen.getByText("broken").closest("tr");
    expect(within(corrupt as HTMLElement).getByText("corrupt")).toBeInTheDocument();
  });
  it.each([403, 500, 200])(
    "renders an inventory error for JSON %s instead of mounting broken inventory",
    async (status) => {
      setup((url) =>
        url.pathname.endsWith("/services/data")
          ? Response.json({ error: "Synthetic denied" }, { status })
          : undefined,
      );
      mount(<DataWorkflowsPage />);
      expect(await screen.findByText("Failed to load data inventory.")).toBeInTheDocument();
      expect(screen.queryByText("Data Operations")).toBeNull();
    },
  );
  it("rejects a preview missing canonical input/risk instead of opening confirmation", async () => {
    setup((url) =>
      url.pathname.endsWith("/preview")
        ? Response.json({ ok: true, preview: ["Unsafe fallback"] })
        : undefined,
    );
    mount(card());
    fireEvent.click(screen.getByRole("button", { name: "Queue Update data" }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.any(String), "error"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it.each(["preview", "run"])(
    "does not continue pending %s into a replacement operation form",
    async (stage) => {
      const deferred = pending<Response>();
      const calls = setup((url) =>
        url.pathname.endsWith(`/${stage}`) ? deferred.promise : undefined,
      );
      const { view, rerender } = mount(card());
      fireEvent.click(screen.getByRole("button", { name: "Queue Update data" }));
      if (stage === "run") fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
      await waitFor(() =>
        expect(calls.some((r) => r.url.pathname.endsWith(`/${stage}`))).toBe(true),
      );
      rerender(
        view(
          card({
            ...operation,
            version: 4,
            title: "Replacement",
            defaults: { region: "new", failFast: true },
          }),
        ),
      );
      await act(async () =>
        deferred.resolve(
          Response.json(stage === "preview" ? preview : { ok: true, jobId: "job-1" }),
        ),
      );
      expect(screen.getByLabelText("Region")).toHaveValue("new");
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(toast).not.toHaveBeenCalled();
    },
  );
});

const overtureStatus = {
  ok: true,
  release: "release-after",
  region: "europe/germany",
  placeCount: 101,
  status: "completed",
  phase: "complete",
  attemptCount: 1,
  sourceFingerprint: null,
  emittedCount: null,
  extractedCount: null,
  processedCount: null,
  candidateCount: null,
  componentCount: null,
  assignmentCursor: null,
  stagedLinkCount: null,
  linkedCount: null,
  scoreCursorH3: null,
  scoreCursorType: null,
  scoreCursorId: null,
  phaseDurationsMs: {},
  lastError: null,
  startedAt: null,
  attemptStartedAt: null,
  phaseStartedAt: null,
  completedAt: null,
  workspaceCleanedAt: null,
  releaseFilesPrunedAt: null,
  updatedAt: at,
  heartbeatAgeMs: 0,
  stalled: false,
};
const indexStatus = {
  ok: true,
  epoch: "epoch-before",
  status: "ready",
  placeCount: 101,
  startedAt: null,
  publishedAt: at,
  updatedAt: at,
  lastError: null,
  building: false,
};
function embedded(kind: string, origin = apiUrl) {
  if (kind.startsWith("overture")) return <OvertureMaintenance apiUrl={origin} />;
  if (kind === "search-index-build") return <SearchIndexMaintenance apiUrl={origin} />;
  return <NotablePlacesMaintenance apiUrl={origin} />;
}
async function queueEmbedded(kind: string, confirmPreview = true) {
  if (kind.startsWith("overture") || kind === "search-index-build") {
    const region = await screen.findByLabelText("Region");
    fireEvent.change(region, { target: { value: "europe/germany" } });
  }
  const queue =
    kind === "overture-sync"
      ? "Full sync"
      : kind === "overture-conflate"
        ? "Resume links"
        : kind === "search-index-build"
          ? "Build index"
          : "Build now";
  const queueButton = await screen.findByRole("button", { name: queue });
  await waitFor(() => expect(queueButton).not.toBeDisabled());
  fireEvent.click(queueButton);
  if (!confirmPreview) return;
  const confirm =
    kind === "overture-sync"
      ? "Run operation"
      : kind === "overture-conflate"
        ? "Resume"
        : "Start build";
  fireEvent.click(
    await within(await screen.findByRole("dialog")).findByRole("button", { name: confirm }),
  );
}
describe("embedded operation callers", () => {
  it.each(["success", "failed", "canceled"] as const)(
    "replaces a pending initial embedded GET on terminal %s before its old response arrives",
    async (status) => {
      const initial = pending<Response>();
      const before = { ...indexStatus, source: "synthetic", minSitelinks: 8, nameCount: 202 };
      const oldResponse = Response.json(before);
      let completed = false;
      let reads = 0;
      setup((url) => {
        if (url.pathname.startsWith("/api/admin/jobs/"))
          return Response.json(job({ id: "job-1", status: completed ? status : "cancel_pending" }));
        if (url.pathname.endsWith("/notable-places/status")) {
          if (++reads === 1) return initial.promise;
          return Response.json({ ...before, placeCount: 303 });
        }
        return undefined;
      });
      const { qc } = mount(<NotablePlacesMaintenance apiUrl={apiUrl} />);
      await waitFor(() => expect(reads).toBe(1));
      await queueEmbedded("notable-places-build");
      const jobKey = ["admin", "jobs", "detail", apiUrl, "application", "job-1"];
      await waitFor(() =>
        expect(qc.getQueryData(jobKey)).toMatchObject({ status: "cancel_pending" }),
      );
      expect(reads).toBe(1);
      const publications: unknown[] = [];
      const unsubscribe = qc.getQueryCache().subscribe((event) => {
        if (event.query.queryKey[1] === "notable-places") publications.push(event.query.state.data);
      });
      try {
        completed = true;
        await act(() => qc.invalidateQueries({ queryKey: jobKey }));
        await waitFor(() => expect(reads).toBe(2));
        await screen.findByText("303");
        await act(async () => initial.resolve(oldResponse));
        expect(screen.getByText("303")).toBeInTheDocument();
        expect(screen.queryByText("101")).toBeNull();
        expect(reads).toBe(2);
        for (const data of publications)
          if (data !== undefined) expect(data).toMatchObject({ placeCount: 303 });
      } finally {
        initial.resolve(oldResponse);
        unsubscribe();
      }
    },
  );

  it.each(["overture-sync", "overture-conflate", "search-index-build", "notable-places-build"])(
    "registers %s after disposal and refreshes its actual displayed status on terminal failure",
    async (kind) => {
      const deferred = pending<Response>();
      let terminal = false;
      const calls = setup((url) => {
        if (url.pathname.endsWith("/run")) return deferred.promise;
        if (url.pathname.startsWith("/api/admin/jobs/"))
          return Response.json(
            job({ id: "job-1", status: terminal ? "failed" : "cancel_pending" }),
          );
        if (!terminal && url.pathname.includes("/data-manager/"))
          return Response.json({ error: "No snapshot" }, { status: 404 });
        if (terminal && url.pathname.endsWith("/search-index/status"))
          return Response.json({
            ...indexStatus,
            region: "europe/germany",
            sourcePath: null,
            sourceFingerprint: null,
            currentFingerprint: null,
            termCount: 20,
            stale: false,
            epoch: "epoch-after",
          });
        if (terminal && url.pathname.endsWith("/notable-places/status"))
          return Response.json({
            ...indexStatus,
            source: "synthetic",
            minSitelinks: 8,
            nameCount: 202,
          });
        if (terminal && url.pathname.endsWith("/overture/status"))
          return Response.json(overtureStatus);
        return undefined;
      });
      const { qc, view, rerender } = mount(embedded(kind));
      await queueEmbedded(kind);
      await waitFor(() =>
        expect(calls.some((r) => r.url.pathname.endsWith(`/${kind}/run`))).toBe(true),
      );
      rerender(view(<span>away</span>));
      await act(async () => deferred.resolve(Response.json({ ok: true, jobId: "job-1" })));
      await waitFor(() =>
        expect(calls.some((r) => r.url.pathname.endsWith("/jobs/job-1"))).toBe(true),
      );
      expect(toast).not.toHaveBeenCalled();
      rerender(view(embedded(kind)));
      terminal = true;
      await act(() => qc.invalidateQueries({ queryKey: ["admin", "jobs", "detail"] }));
      await screen.findByText(
        kind.startsWith("overture")
          ? "release-after"
          : kind === "search-index-build"
            ? "epoch-after"
            : "202",
      );
    },
  );
  it.each(["overture-sync", "search-index-build", "notable-places-build"])(
    "does not close a replacement %s origin's dialog on a late acknowledgement",
    async (kind) => {
      const deferred = pending<Response>();
      const calls = setup((url) => (url.pathname.endsWith("/run") ? deferred.promise : undefined));
      const { view, rerender } = mount(embedded(kind));
      await queueEmbedded(kind);
      await waitFor(() => expect(calls.some((r) => r.url.pathname.endsWith("/run"))).toBe(true));
      apiUrl = "http://second.test";
      rerender(view(embedded(kind)));
      const queue =
        kind === "overture-sync"
          ? "Full sync"
          : kind === "search-index-build"
            ? "Build index"
            : "Build now";
      if (kind !== "notable-places-build")
        fireEvent.change(await screen.findByLabelText("Region"), {
          target: { value: "new/region" },
        });
      const queueButton = await screen.findByRole("button", { name: queue });
      await waitFor(() => expect(queueButton).not.toBeDisabled());
      fireEvent.click(queueButton);
      await act(async () => deferred.resolve(Response.json({ ok: true, jobId: "job-1" })));
      expect(await screen.findByRole("dialog")).toBeInTheDocument();
      expect(toast).not.toHaveBeenCalled();
      expect(calls.filter((r) => r.url.pathname.includes("/jobs/"))).toHaveLength(0);
    },
  );
});

describe("backup dialog and input ownership", () => {
  it.each(["success", "missing-job", "failure"])(
    "retains replacement create input on %s and never retries",
    async (result) => {
      const deferred = pending<Response>();
      const calls = setup((url, init) =>
        url.pathname.endsWith("/backups") && init.method === "POST" ? deferred.promise : undefined,
      );
      mount(<BackupsPage />);
      await screen.findByText("snapshot-1");
      fireEvent.change(screen.getByLabelText("Backup name (optional)"), {
        target: { value: "first" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Create backup" }));
      await waitFor(() => expect(calls.some((r) => r.init.method === "POST")).toBe(true));
      fireEvent.change(screen.getByLabelText("Backup name (optional)"), {
        target: { value: "replacement" },
      });
      await act(async () =>
        deferred.resolve(
          Response.json(
            result === "success"
              ? { ok: true, jobId: "job-1" }
              : result === "missing-job"
                ? { ok: true }
                : { error: "Synthetic failure" },
            { status: result === "failure" ? 500 : 200 },
          ),
        ),
      );
      expect(screen.getByLabelText("Backup name (optional)")).toHaveValue("replacement");
      expect(toast).not.toHaveBeenCalled();
      expect(calls.filter((r) => r.init.method === "POST")).toHaveLength(1);
    },
  );
  it.each(["restore", "delete"])(
    "keeps a reopened %s dialog when an earlier request finishes",
    async (kind) => {
      const deferred = pending<Response>();
      const calls = setup((url, init) =>
        url.pathname.endsWith("/restore") || init.method === "DELETE"
          ? deferred.promise
          : undefined,
      );
      mount(<BackupsPage />);
      const row = (await screen.findByText("snapshot-1")).closest("tr") as HTMLElement;
      const open = () =>
        fireEvent.click(
          within(row).getAllByRole("button")[kind === "restore" ? 0 : 1] as HTMLElement,
        );
      open();
      fireEvent.click(
        screen.getByRole("button", { name: kind === "restore" ? "Restore" : "Delete" }),
      );
      await waitFor(() =>
        expect(
          calls.some((r) => r.url.pathname.endsWith("/restore") || r.init.method === "DELETE"),
        ).toBe(true),
      );
      fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape", code: "Escape" });
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      open();
      if (kind === "restore")
        fireEvent.change(screen.getByLabelText("Service IDs (optional)"), {
          target: { value: "new-service" },
        });
      await act(async () => deferred.resolve(Response.json({ ok: true, jobId: "job-1" })));
      expect(await screen.findByRole("dialog")).toBeInTheDocument();
      if (kind === "restore")
        expect(screen.getByLabelText("Service IDs (optional)")).toHaveValue("new-service");
      expect(toast).not.toHaveBeenCalled();
    },
  );
});

describe("accepted jobs refresh concrete workflows", () => {
  it.each(["success", "failed", "canceled"] as const)(
    "refreshes backup inventory and data independently for concurrent %s jobs after view disposal",
    async (terminal) => {
      const done = new Set<string>();
      let accepted = 0;
      const calls = setup((url, init) => {
        if (url.pathname.endsWith("/backups") && init.method === "POST")
          return Response.json({ ok: true, jobId: `job-${++accepted}` });
        if (url.pathname.includes("/jobs/")) {
          const id = url.pathname.split("/").at(-1) ?? "missing";
          return Response.json(job({ id, status: done.has(id) ? terminal : "cancel_pending" }));
        }
        if (url.pathname.endsWith("/backups"))
          return Response.json({
            backups: [{ ...backup, serviceCount: 17 + done.size }],
            warnings: [],
            root: "ops-agent-managed",
          });
        if (url.pathname.endsWith("/services/data"))
          return Response.json({
            ...inventory,
            osm: { ...inventory.osm, region: `generation-${done.size}` },
          });
        return undefined;
      });
      const { qc, view, rerender } = mount(
        <>
          <BackupsPage />
          <InventoryStatus />
        </>,
      );
      await screen.findByText("generation-0");
      fireEvent.click(await screen.findByRole("button", { name: "Create backup" }));
      await waitFor(() =>
        expect(calls.some((r) => r.url.pathname.endsWith("/jobs/job-1"))).toBe(true),
      );
      fireEvent.click(await screen.findByRole("button", { name: "Create backup" }));
      await waitFor(() =>
        expect(calls.some((r) => r.url.pathname.endsWith("/jobs/job-2"))).toBe(true),
      );
      const runningDataReads = calls.filter((r) =>
        r.url.pathname.endsWith("/services/data"),
      ).length;
      await act(() => qc.invalidateQueries({ queryKey: ["admin", "jobs", "detail"] }));
      expect(calls.filter((r) => r.url.pathname.endsWith("/services/data"))).toHaveLength(
        runningDataReads,
      );
      // Removing the initiating view leaves the one admin provider and its observers alive.
      rerender(view(<InventoryStatus />));
      done.add("job-1");
      await act(() => qc.invalidateQueries({ queryKey: ["admin", "jobs", "detail"] }));
      await screen.findByText("generation-1");
      rerender(
        view(
          <>
            <BackupsPage />
            <InventoryStatus />
          </>,
        ),
      );
      await screen.findByText("18");
      done.add("job-2");
      await act(() => qc.invalidateQueries({ queryKey: ["admin", "jobs", "detail"] }));
      await screen.findByText("generation-2");
      await screen.findByText("19");
    },
  );
  it.each(["wrong-id", "wrong-source"])(
    "keeps displayed inventory unchanged for %s terminal evidence",
    async (mismatch) => {
      let changed = false;
      setup((url, init) => {
        if (url.pathname.endsWith("/backups") && init.method === "POST")
          return Response.json({ ok: true, jobId: "job-1" });
        if (url.pathname.includes("/jobs/")) {
          changed = true;
          return Response.json(
            job({
              id: mismatch === "wrong-id" ? "unrelated" : "job-1",
              source: mismatch === "wrong-source" ? "data-manager" : "application",
              status: "success",
            }),
          );
        }
        if (url.pathname.endsWith("/services/data"))
          return Response.json({
            ...inventory,
            osm: { ...inventory.osm, region: changed ? "should-not-refresh" : "original" },
          });
        return undefined;
      });
      const { qc } = mount(
        <>
          <BackupsPage />
          <InventoryStatus />
        </>,
      );
      await screen.findByText("original");
      fireEvent.click(await screen.findByRole("button", { name: "Create backup" }));
      await waitFor(() =>
        expect(
          qc.getQueryState(["admin", "jobs", "detail", apiUrl, "application", "job-1"])?.status,
        ).toBe("error"),
      );
      expect(screen.getByText("original")).toBeInTheDocument();
      expect(screen.queryByText("should-not-refresh")).toBeNull();
    },
  );
  it("registers a disposed operation card's job and refreshes displayed data on completion", async () => {
    const deferred = pending<Response>();
    let done = false;
    const calls = setup((url) => {
      if (url.pathname.endsWith("/run")) return deferred.promise;
      if (url.pathname.includes("/jobs/"))
        return Response.json(job({ id: "job-1", status: done ? "canceled" : "cancel_pending" }));
      if (url.pathname.endsWith("/services/data"))
        return Response.json({
          ...inventory,
          osm: { ...inventory.osm, region: done ? "refreshed" : "original" },
        });
      return undefined;
    });
    const { qc, view, rerender } = mount(
      <>
        {card()}
        <InventoryStatus />
      </>,
    );
    await screen.findByText("original");
    fireEvent.click(screen.getByRole("button", { name: "Queue Update data" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(calls.some((r) => r.url.pathname.endsWith("/run"))).toBe(true));
    rerender(view(<InventoryStatus />));
    await act(async () => deferred.resolve(Response.json({ ok: true, jobId: "job-1" })));
    await waitFor(() =>
      expect(calls.some((r) => r.url.pathname.endsWith("/jobs/job-1"))).toBe(true),
    );
    expect(toast).not.toHaveBeenCalled();
    done = true;
    await act(() => qc.invalidateQueries({ queryKey: ["admin", "jobs", "detail"] }));
    await screen.findByText("refreshed");
  });
  it("rejects a late operation acknowledgement across origin ABA, including replacement input and displayed origin data", async () => {
    const deferred = pending<Response>();
    const calls = setup((url) => {
      if (url.pathname.endsWith("/run")) return deferred.promise;
      if (url.pathname.endsWith("/services/data"))
        return Response.json({ ...inventory, osm: { ...inventory.osm, region: url.origin } });
      return undefined;
    });
    const { view, rerender } = mount(
      <>
        {card()}
        <InventoryStatus />
      </>,
    );
    await screen.findByText("http://admin.test");
    fireEvent.click(screen.getByRole("button", { name: "Queue Update data" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(calls.some((r) => r.url.pathname.endsWith("/run"))).toBe(true));
    apiUrl = "http://second.test";
    rerender(
      view(
        <>
          {card()}
          <InventoryStatus />
        </>,
      ),
    );
    await screen.findByText("http://second.test");
    apiUrl = "http://admin.test";
    rerender(
      view(
        <>
          {card()}
          <InventoryStatus />
        </>,
      ),
    );
    fireEvent.change(screen.getByLabelText("Region"), { target: { value: "replacement" } });
    await act(async () => deferred.resolve(Response.json({ ok: true, jobId: "job-1" })));
    expect(screen.getByLabelText("Region")).toHaveValue("replacement");
    expect(screen.getByText("http://admin.test")).toBeInTheDocument();
    expect(calls.filter((r) => r.url.pathname.includes("/jobs/"))).toHaveLength(0);
    expect(toast).not.toHaveBeenCalled();
  });
});

describe("wire intent, validation, polling and policy", () => {
  it.each([{ serviceIds: [] }, { serviceIds: ["valhalla", "motis"] }])(
    "sends explicit restore serviceIds %j with stopRunning",
    async ({ serviceIds }) => {
      const calls = setup((url) =>
        url.pathname.endsWith("/restore")
          ? Response.json({ ok: true, jobId: "restore-job" })
          : undefined,
      );
      mount(<BackupsPage />);
      const row = (await screen.findByText("snapshot-1")).closest("tr") as HTMLElement;
      fireEvent.click(within(row).getByRole("button", { name: "Restore backup" }));
      fireEvent.change(screen.getByLabelText("Service IDs (optional)"), {
        target: { value: serviceIds.join(", ") },
      });
      fireEvent.click(
        screen.getByLabelText("Stop currently running target services before restore"),
      );
      fireEvent.click(screen.getByRole("button", { name: "Restore" }));
      await waitFor(() =>
        expect(toast).toHaveBeenCalledWith("Restore queued for snapshot-1 (restore-job)"),
      );
      const request = calls.find((r) => r.url.pathname.endsWith("/restore"));
      expect(request?.init.method).toBe("POST");
      expect(JSON.parse(String(request?.init.body))).toEqual({ serviceIds, stopRunning: true });
    },
  );
  it("encodes backup names through the generated path and preserves a server refusal", async () => {
    const calls = setup((url, init) => {
      if (init.method === "DELETE")
        return Response.json({ error: "Invalid backup name" }, { status: 400 });
      if (url.pathname.endsWith("/backups"))
        return Response.json({
          backups: [{ ...backup, name: "unsafe/name %?" }],
          warnings: [],
          root: "ops-agent-managed",
        });
      return undefined;
    });
    mount(<BackupsPage />);
    const row = (await screen.findByText("unsafe/name %?")).closest("tr") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "Delete backup" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Invalid backup name", "error"));
    expect(calls.find((r) => r.init.method === "DELETE")?.url.pathname).toBe(
      "/api/admin/services/backups/unsafe%2Fname%20%25%3F",
    );
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });
  it.each([
    "create",
    "restore",
    "delete",
    "preview",
    "run",
    "overture-sync",
    "overture-conflate",
    "search-index-build",
    "notable-places-build",
    "policy",
  ])("never retries %s under retrying mutation defaults", async (kind) => {
    let calls = setup((_url, init) =>
      init.method === "POST" || init.method === "DELETE"
        ? Response.json({ error: "Synthetic refused" }, { status: 500 })
        : undefined,
    );
    if (kind === "create") {
      mount(<BackupsPage />);
      fireEvent.click(await screen.findByRole("button", { name: "Create backup" }));
    } else if (kind === "restore" || kind === "delete") {
      mount(<BackupsPage />);
      const row = (await screen.findByText("snapshot-1")).closest("tr") as HTMLElement;
      fireEvent.click(
        within(row).getByRole("button", {
          name: kind === "restore" ? "Restore backup" : "Delete backup",
        }),
      );
      fireEvent.click(
        screen.getByRole("button", { name: kind === "restore" ? "Restore" : "Delete" }),
      );
    } else if (kind === "preview" || kind === "run") {
      // Run needs a valid preview before its controlled refusal.
      if (kind === "run")
        calls = setup((url, init) =>
          url.pathname.endsWith("/preview")
            ? Response.json(preview)
            : init.method === "POST"
              ? Response.json({ error: "Synthetic refused" }, { status: 500 })
              : undefined,
        );
      mount(card());
      fireEvent.click(screen.getByRole("button", { name: "Queue Update data" }));
      if (kind === "run") fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
    } else if (kind === "policy") {
      mount(<DataWorkflowsPage />);
      fireEvent.click((await screen.findAllByLabelText("Fan-out rollback"))[0] as HTMLElement);
    } else {
      mount(embedded(kind));
      await queueEmbedded(kind, !kind.startsWith("overture"));
    }
    if (kind === "policy") await screen.findByText("Synthetic refused");
    else await waitFor(() => expect(toast).toHaveBeenCalledWith("Synthetic refused", "error"));
    // All error handling has settled; retry:false must override the client's 2 retries.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
    });
    expect(
      calls.filter((r) => r.init.method === "POST" || r.init.method === "DELETE"),
    ).toHaveLength(kind === "run" ? 2 : 1);
    if (kind === "create")
      expect(calls.filter((r) => r.init.method === "POST").map((r) => r.url.pathname)).toEqual([
        "/api/admin/services/backups",
      ]);
  });
  it("keeps full MOTIS/GBFS evidence in the query and synchronously refreshes rollback without a job", async () => {
    let rollback = false;
    const calls = setup((url, init) => {
      if (url.pathname.endsWith("/rollback")) {
        rollback = JSON.parse(String(init.body)).enabled;
        return Response.json({ rollbackCategories: ["bike"], decisions: [] });
      }
      if (url.pathname.endsWith("/shared-mobility"))
        return Response.json({
          rollbackCategories: rollback ? ["bike"] : [],
          decisions: [
            {
              category: "bike",
              recordedAt: at,
              decision: {
                policy: "motis-first",
                local: "partial",
                served: "fanout",
                partial: true,
                calledAdapters: ["motis"],
                skippedAdapters: ["fallback"],
                stationDelta: 2,
                vehicleDelta: -1,
              },
            },
          ],
        });
      return undefined;
    });
    const { qc } = mount(<DataWorkflowsPage />);
    await screen.findByText("1 schedule dataset(s)");
    expect(qc.getQueryData(["admin", "services", apiUrl, "data"])).toEqual(inventory);
    expect(await screen.findByText(/called motis; skipped fallback/)).toBeInTheDocument();
    const toggle = screen.getAllByLabelText("Fan-out rollback")[0] as HTMLElement;
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toBeChecked());
    expect(calls.find((r) => r.url.pathname.endsWith("/rollback"))?.url.pathname).toBe(
      "/api/admin/shared-mobility/bike/rollback",
    );
    expect(calls.filter((r) => r.url.pathname.includes("/jobs/"))).toHaveLength(0);
  });
  it("polls displayed data every 30 seconds", async () => {
    vi.useFakeTimers();
    try {
      let reads = 0;
      setup((url) =>
        url.pathname.endsWith("/services/data")
          ? Response.json({ ...inventory, osm: { ...inventory.osm, region: `poll-${++reads}` } })
          : undefined,
      );
      mount(<DataWorkflowsPage />);
      await act(async () => vi.advanceTimersByTimeAsync(1));
      expect(screen.getByText("poll-1")).toBeInTheDocument();
      await act(async () => vi.advanceTimersByTimeAsync(29_999));
      expect(screen.queryByText("poll-2")).toBeNull();
      await act(async () => vi.advanceTimersByTimeAsync(1));
      expect(screen.getByText("poll-2")).toBeInTheDocument();
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });
});

describe("pending form inputs and malformed operation acceptance", () => {
  it("does not clear restore input edited while the original restore is pending", async () => {
    const deferred = pending<Response>();
    const calls = setup((url) =>
      url.pathname.endsWith("/restore") ? deferred.promise : undefined,
    );
    mount(<BackupsPage />);
    const row = (await screen.findByText("snapshot-1")).closest("tr") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "Restore backup" }));
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(calls.some((r) => r.url.pathname.endsWith("/restore"))).toBe(true));
    fireEvent.change(screen.getByLabelText("Service IDs (optional)"), {
      target: { value: "replacement" },
    });
    await act(async () => deferred.resolve(Response.json({ ok: true, jobId: "job-1" })));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByLabelText("Service IDs (optional)")).toHaveValue("replacement");
    expect(toast).not.toHaveBeenCalled();
  });
  it.each([{ ok: true }, { ok: false, jobId: "invented" }])(
    "does not close confirmation or claim queued for malformed run %j",
    async (body) => {
      setup((url) => (url.pathname.endsWith("/run") ? Response.json(body) : undefined));
      mount(card());
      fireEvent.click(screen.getByRole("button", { name: "Queue Update data" }));
      fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
      await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.any(String), "error"));
      expect(await screen.findByRole("dialog")).toBeInTheDocument();
      expect(toast).not.toHaveBeenCalledWith("invented");
    },
  );
  it("keeps dotted field issues and raw strings/booleans through preview and run", async () => {
    let attempts = 0;
    const calls = setup((url) => {
      if (url.pathname.endsWith("/preview"))
        return Response.json({ ...preview, input: { regions: ["de"], failFast: true } });
      if (url.pathname.endsWith("/run")) {
        attempts++;
        return Response.json(
          {
            ok: false,
            error: "Invalid region",
            issues: [{ path: "source.region", message: "Use a supported path" }],
          },
          { status: 400 },
        );
      }
      return undefined;
    });
    mount(
      card({
        ...operation,
        fields: [
          { name: "source.region", label: "Source region", kind: "text" },
          { name: "failFast", label: "Fail fast", kind: "boolean" },
        ],
        defaults: { "source.region": " de, fr ", failFast: true },
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Queue Update data" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(attempts).toBe(1));
    await screen.findByText("Invalid region");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByText("Use a supported path")).toBeInTheDocument();
    for (const request of calls.filter((r) => r.init.method === "POST"))
      expect(JSON.parse(String(request.init.body))).toEqual({
        "source.region": " de, fr ",
        failFast: true,
      });
  });
});

describe("existing data-manager status semantics", () => {
  it.each(["overture-sync", "search-index-build", "notable-places-build"])(
    "distinguishes %s status absence from authorization refusal",
    async (kind) => {
      let denied = false;
      const calls = setup((url) =>
        url.pathname.includes("/data-manager/")
          ? Response.json(
              { error: denied ? "Synthetic forbidden" : "No snapshot" },
              { status: denied ? 403 : 404 },
            )
          : undefined,
      );
      mount(embedded(kind));
      const absence = kind.startsWith("overture")
        ? /has not been ingested yet/
        : kind === "search-index-build"
          ? /No .*index.*published/i
          : /No notable-places index is published yet/;
      await screen.findByText(absence);
      denied = true;
      fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
      await screen.findByText("Synthetic forbidden");
      expect(calls.filter((r) => r.url.pathname.includes("/data-manager/"))).toHaveLength(2);
    },
  );
  it.each(["overture-sync", "search-index-build", "notable-places-build"])(
    "keeps %s status queries and displayed data isolated by origin",
    async (kind) => {
      const calls = setup((url) =>
        url.pathname.includes("/data-manager/")
          ? Response.json({ error: `${url.origin} denied` }, { status: 403 })
          : undefined,
      );
      const { view, rerender } = mount(embedded(kind));
      await screen.findByText("http://admin.test denied");
      apiUrl = "http://second.test";
      rerender(view(embedded(kind)));
      await screen.findByText("http://second.test denied");
      expect(screen.queryByText("http://admin.test denied")).toBeNull();
      expect(
        calls.filter((r) => r.url.pathname.includes("/data-manager/")).map((r) => r.url.origin),
      ).toEqual(["http://admin.test", "http://second.test"]);
    },
  );
  it("rejects a declared JSON body with wrong response media instead of rendering operation success", async () => {
    setup((url) =>
      url.pathname.endsWith("/preview")
        ? new Response(JSON.stringify(preview), { headers: { "content-type": "text/plain" } })
        : undefined,
    );
    mount(card());
    fireEvent.click(screen.getByRole("button", { name: "Queue Update data" }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.any(String), "error"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

it("refreshes embedded status displayed on the data page after a catalogue operation completes", async () => {
  let terminal = false;
  const calls = setup((url) => {
    if (url.pathname.includes("/jobs/"))
      return Response.json(job({ id: "job-1", status: terminal ? "success" : "cancel_pending" }));
    if (url.pathname.endsWith("/search-index/status"))
      return Response.json({
        ...indexStatus,
        region: "europe/germany",
        sourcePath: null,
        sourceFingerprint: null,
        currentFingerprint: null,
        termCount: 20,
        stale: false,
        epoch: terminal ? "catalogue-refreshed" : "catalogue-before",
      });
    return undefined;
  });
  const { qc } = mount(<DataWorkflowsPage />);
  await screen.findByText("catalogue-before");
  fireEvent.click(screen.getByRole("button", { name: "Queue Update data" }));
  fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
  await waitFor(() => expect(calls.some((r) => r.url.pathname.endsWith("/jobs/job-1"))).toBe(true));
  terminal = true;
  await act(() => qc.invalidateQueries({ queryKey: ["admin", "jobs", "detail"] }));
  await screen.findByText("catalogue-refreshed");
});

it.each([
  { kind: "overture-sync", running: true, interval: 10_000 },
  { kind: "overture-sync", running: false, interval: 60_000 },
  { kind: "search-index-build", running: true, interval: 10_000 },
  { kind: "search-index-build", running: false, interval: 60_000 },
  { kind: "notable-places-build", running: true, interval: 10_000 },
  { kind: "notable-places-build", running: false, interval: 60_000 },
])(
  "polls displayed $kind status at $interval ms when running=$running",
  async ({ kind, running, interval }) => {
    vi.useFakeTimers();
    try {
      let reads = 0;
      setup((url) => {
        if (!url.pathname.includes("/data-manager/")) return undefined;
        const lastError = `status-poll-${++reads}`;
        if (kind.startsWith("overture"))
          return Response.json({
            ...overtureStatus,
            status: running ? "running" : "completed",
            lastError,
          });
        if (kind === "search-index-build")
          return Response.json({
            ...indexStatus,
            region: "europe/germany",
            sourcePath: null,
            sourceFingerprint: null,
            currentFingerprint: null,
            termCount: 20,
            stale: false,
            building: running,
            lastError,
          });
        return Response.json({
          ...indexStatus,
          source: "synthetic",
          minSitelinks: 8,
          nameCount: 202,
          building: running,
          lastError,
        });
      });
      mount(embedded(kind));
      await act(async () => vi.advanceTimersByTimeAsync(1));
      expect(screen.getByText("status-poll-1")).toBeInTheDocument();
      await act(async () => vi.advanceTimersByTimeAsync(interval - 1));
      expect(screen.queryByText("status-poll-2")).toBeNull();
      await act(async () => vi.advanceTimersByTimeAsync(1));
      expect(screen.getByText("status-poll-2")).toBeInTheDocument();
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  },
);

it.each(["restore", "delete"])(
  "keeps the current %s dialog open when acceptance lacks a job ID",
  async (kind) => {
    const calls = setup((_url, init) =>
      init.method === "POST" || init.method === "DELETE" ? Response.json({ ok: true }) : undefined,
    );
    mount(<BackupsPage />);
    const row = (await screen.findByText("snapshot-1")).closest("tr") as HTMLElement;
    fireEvent.click(
      within(row).getByRole("button", {
        name: kind === "restore" ? "Restore backup" : "Delete backup",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: kind === "restore" ? "Restore" : "Delete" }),
    );
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.any(String), "error"));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(calls.filter((r) => r.url.pathname.includes("/jobs/"))).toHaveLength(0);
  },
);
