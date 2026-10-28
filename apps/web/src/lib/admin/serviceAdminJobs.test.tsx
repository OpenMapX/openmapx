import { runAdminServiceAction } from "@openmapx/core/api-admin-sdk";
import { useMutation, useQuery } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { job } from "@/components/admin/activity/__tests__/fixtures";
import { useActivityClient } from "@/components/admin/activity/activityQueries";
import {
  act,
  cleanup,
  createQueryWrapper,
  createTestQueryClient,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@/test";
import { AdminJobEffectsProvider } from "./adminJobEffects";
import { serviceAdminQueries, serviceOrThrow } from "./serviceAdmin";
import { useServiceJobRegistration } from "./serviceAdminJobs";

let apiUrl = "http://admin.test";
const acquisition = { state: "available", reason: null };

vi.mock("@/integration-api/runtime/EnvProvider", () => ({ useEnv: () => ({ apiUrl }) }));
const caches: ReturnType<typeof createTestQueryClient>[] = [];
function pending<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { resolve, promise };
}
function Caller() {
  // Intentionally a separate, ordinary hook-local client from the provider's.
  const { client, apiUrl } = useActivityClient();
  const register = useServiceJobRegistration();
  const mutation = useMutation({
    retry: false,
    mutationFn: async () => {
      const result = await serviceOrThrow(
        runAdminServiceAction("demo", { action: "start" }, { client }),
      );
      register({
        client,
        apiUrl,
        jobId: result.jobId,
        effect: { kind: "service", serviceId: "demo" },
      });
    },
  });
  return (
    <button type="button" onClick={() => mutation.mutate()}>
      Queue
    </button>
  );
}
function Status() {
  const { client, apiUrl } = useActivityClient();
  const { data } = useQuery(serviceAdminQueries(client, apiUrl).list());
  return <output>{data?.summary.running ?? "waiting"}</output>;
}
function mount() {
  const qc = createTestQueryClient();
  qc.setDefaultOptions({ queries: { retry: false, gcTime: Infinity } });
  caches.push(qc);
  const Wrapper = createQueryWrapper(qc);
  const view = (caller = true) => (
    <Wrapper>
      <AdminJobEffectsProvider>
        <Status />
        {caller && <Caller />}
      </AdminJobEffectsProvider>
    </Wrapper>
  );
  return { qc, view, ...render(view()) };
}
beforeEach(() => {
  apiUrl = "http://admin.test";
});
afterEach(() => {
  cleanup();
  for (const qc of caches.splice(0)) qc.clear();
  vi.unstubAllGlobals();
});
describe("admin-owned accepted service jobs", () => {
  it.each(["success", "failed", "canceled"] as const)(
    "replaces a pending initial service GET on terminal %s before its old response arrives",
    async (status) => {
      const initial = pending<Response>();
      const oldResponse = Response.json({
        acquisition,
        services: [],
        summary: { unknown: 0, running: 0, stopped: 2, total: 2 },
      });
      let completed = false;
      let reads = 0;
      const signals: (AbortSignal | null | undefined)[] = [];
      vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
        const path = new URL(url).pathname;
        if (path.endsWith("/action")) return Response.json({ ok: true, jobId: "job-1" });
        if (path.startsWith("/api/admin/jobs/"))
          return Response.json(job({ id: "job-1", status: completed ? status : "cancel_pending" }));
        expect(path).toBe("/api/admin/services");
        signals.push(init.signal);
        if (++reads === 1) return initial.promise;
        return Response.json({
          acquisition,
          services: [],
          summary: { unknown: 0, running: 2, stopped: 0, total: 2 },
        });
      });
      const { qc } = mount();
      await waitFor(() => expect(reads).toBe(1));
      fireEvent.click(screen.getByText("Queue"));
      const jobKey = ["admin", "jobs", "detail", apiUrl, "application", "job-1"];
      await waitFor(() =>
        expect(qc.getQueryData(jobKey)).toMatchObject({ status: "cancel_pending" }),
      );
      expect(reads).toBe(1);
      expect(screen.getByText("waiting")).toBeInTheDocument();
      const publications: unknown[] = [];
      const unsubscribe = qc.getQueryCache().subscribe((event) => {
        if (event.query.queryKey[3] === "list") publications.push(event.query.state.data);
      });
      try {
        completed = true;
        await act(() => qc.invalidateQueries({ queryKey: jobKey }));
        await waitFor(() => expect(reads).toBe(2));
        await screen.findByText("2");
        expect(signals[0]?.aborted).toBe(true);
        expect(signals[1]?.aborted).toBe(false);
        await act(async () => initial.resolve(oldResponse));
        expect(screen.getByText("2")).toBeInTheDocument();
        expect(screen.queryByText("0")).toBeNull();
        expect(reads).toBe(2);
        for (const data of publications)
          if (data !== undefined)
            expect(data).toMatchObject({ summary: { unknown: 0, running: 2 } });
      } finally {
        initial.resolve(oldResponse);
        unsubscribe();
      }
    },
  );

  it.each(["success", "failed", "canceled"] as const)(
    "retains distinct same-origin clients, multiple jobs and disposed callers until %s refresh",
    async (status) => {
      let completed = false;
      let accepted = 0;
      const observed = new Set<string>();
      vi.stubGlobal("fetch", (url: string) => {
        const path = new URL(url).pathname;
        if (path.endsWith("/action"))
          return Response.json({ ok: true, jobId: `job-${++accepted}` });
        if (path.startsWith("/api/admin/jobs/")) {
          const id = path.split("/").at(-1) ?? "missing";
          observed.add(id);
          return Response.json(job({ id, status: completed ? status : "cancel_pending" }));
        }
        expect(path).toBe("/api/admin/services");
        return Response.json({
          acquisition,
          services: [],
          summary: { unknown: 0, running: completed ? 2 : 0, stopped: 0, total: 2 },
        });
      });
      const { qc, view, rerender } = mount();
      await screen.findByText("0");
      fireEvent.click(screen.getByText("Queue"));
      await waitFor(() => expect(observed.has("job-1")).toBe(true));
      fireEvent.click(screen.getByText("Queue"));
      await waitFor(() => expect(observed.size).toBe(2));
      rerender(view(false));
      expect(screen.getByText("0")).toBeInTheDocument();
      completed = true;
      await act(() => qc.invalidateQueries({ queryKey: ["admin", "jobs", "detail"] }));
      await screen.findByText("2");
      expect(observed).toEqual(new Set(["job-1", "job-2"]));
    },
  );
  it.each(["wrong-id", "wrong-source"])("rejects %s as terminal evidence", async (mismatch) => {
    let listReads = 0;
    let observations = 0;
    vi.stubGlobal("fetch", (url: string) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/action")) return Response.json({ ok: true, jobId: "job-1" });
      if (path.startsWith("/api/admin/jobs/")) {
        observations++;
        return Response.json(
          job({
            id: mismatch === "wrong-id" ? "other" : "job-1",
            source: mismatch === "wrong-source" ? "data-manager" : "application",
            status: "success",
          }),
        );
      }
      listReads++;
      return Response.json({
        acquisition,
        services: [],
        summary: { unknown: 0, running: 0, stopped: 0, total: 1 },
      });
    });
    const { qc } = mount();
    await screen.findByText("0");
    const before = listReads;
    fireEvent.click(screen.getByText("Queue"));
    await waitFor(() => expect(observations).toBe(1));
    await waitFor(() =>
      expect(
        qc.getQueryState(["admin", "jobs", "detail", apiUrl, "application", "job-1"])?.status,
      ).toBe("error"),
    );
    expect(listReads).toBe(before);
  });
  it("does not adopt a late old-origin acknowledgement after replacement, even on return to that origin", async () => {
    const deferred = pending<Response>();
    const observed: string[] = [];
    vi.stubGlobal("fetch", (url: string) => {
      const u = new URL(url);
      if (u.pathname.endsWith("/action")) return deferred.promise;
      if (u.pathname.startsWith("/api/admin/jobs/")) {
        observed.push(url);
        return Response.json(job());
      }
      return Response.json({
        acquisition,
        services: [],
        summary: { unknown: 0, running: 0, stopped: 0, total: 0 },
      });
    });
    const { view, rerender } = mount();
    await screen.findByText("0");
    fireEvent.click(screen.getByText("Queue"));
    await act(async () => {});
    apiUrl = "http://second.test";
    rerender(view());
    apiUrl = "http://admin.test";
    rerender(view());
    await act(async () => deferred.resolve(Response.json({ ok: true, jobId: "job-1" })));
    expect(observed).toEqual([]);
  });
  it("refreshes Activity at acceptance without touching another origin or refreshing service state early", async () => {
    vi.stubGlobal("fetch", (url: string) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/action")) return Response.json({ ok: true, jobId: "job-1" });
      if (path.startsWith("/api/admin/jobs/")) return Response.json(job());
      return Response.json({
        acquisition,
        services: [],
        summary: { unknown: 0, running: 0, stopped: 0, total: 0 },
      });
    });
    const { qc } = mount();
    await screen.findByText("0");
    const first = ["admin", "jobs", "list", apiUrl, "all"];
    const second = ["admin", "jobs", "list", "http://second.test", "all"];
    qc.setQueryData(first, []);
    qc.setQueryData(second, []);
    fireEvent.click(screen.getByText("Queue"));
    await waitFor(() => expect(qc.getQueryState(first)?.isInvalidated).toBe(true));
    expect(qc.getQueryState(second)?.isInvalidated).toBe(false);
    expect(qc.getQueryState(["admin", "services", apiUrl, "list"])?.isInvalidated).toBe(false);
  });
  it("keeps observation after a failed public status with retained unknown outcome", async () => {
    let reads = 0;
    vi.stubGlobal("fetch", (url: string) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/action")) return Response.json({ ok: true, jobId: "job-1" });
      if (path.startsWith("/api/admin/jobs/")) {
        reads++;
        return Response.json(
          job({
            status: "failed",
            result: {
              observation: {
                state: "unknown",
                reason: "transport",
                nextCheckAt: "2026-10-28T09:00:00Z",
              },
            },
          }),
        );
      }
      return Response.json({
        acquisition,
        services: [],
        summary: { running: 0, stopped: 0, unknown: 0, total: 0 },
      });
    });
    const { qc } = mount();
    await screen.findByText("0");
    fireEvent.click(screen.getByText("Queue"));
    await waitFor(() => expect(reads).toBeGreaterThanOrEqual(2), { timeout: 3000 });
    expect(qc.getQueryState(["admin", "services", apiUrl, "list"])?.isInvalidated).toBe(false);
  });
});
