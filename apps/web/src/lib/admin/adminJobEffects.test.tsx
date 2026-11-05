import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { job } from "@/components/admin/activity/__tests__/fixtures";
import { AdminJobTray } from "@/components/admin/activity/AdminJobTray";
import { useActivityClient } from "@/components/admin/activity/activityQueries";
import { useInstallExtension } from "@/hooks/useExtensions";
import { useServiceAction } from "@/hooks/useServices";
import { act, cleanup, createTestQueryClient, fireEvent, render, screen, waitFor } from "@/test";
import { deferred } from "@/test/extensionAdmin";
import { AdminJobEffectsProvider, useAdminJobRegistration } from "./adminJobEffects";

let apiUrl = "";
vi.mock("@/integration-api/runtime/EnvProvider", () => ({ useEnv: () => ({ apiUrl }) }));
const caches: ReturnType<typeof createTestQueryClient>[] = [];
function Caller() {
  const ext = useInstallExtension();
  const svc = useServiceAction("demo");
  return (
    <>
      <button type="button" onClick={() => ext.mutate({ id: "demo" })}>
        Extension
      </button>
      <button type="button" onClick={() => svc.mutate("start")}>
        Service
      </button>
    </>
  );
}
function mount() {
  const qc = createTestQueryClient();
  qc.setDefaultOptions({ queries: { retry: false, gcTime: Infinity } });
  caches.push(qc);
  const view = (visible = true) => (
    <QueryClientProvider client={qc}>
      <AdminJobEffectsProvider>{visible && <Caller />}</AdminJobEffectsProvider>
    </QueryClientProvider>
  );
  return { qc, view, ...render(view()) };
}
beforeEach(() => {
  apiUrl = "";
});
afterEach(() => {
  cleanup();
  for (const c of caches.splice(0)) c.clear();
  vi.unstubAllGlobals();
});
describe("one layout observer shared by extension and service adapters", () => {
  it.each(["success", "failed", "canceled"] as const)(
    "survives view disposal, nonterminal errors/cancel_pending, and applies each family's %s effects",
    async (status) => {
      let phase: "pending" | "error" | "service" | "done" = "pending";
      const observed: string[] = [];
      vi.stubGlobal("fetch", (raw: string) => {
        const url = new URL(raw);
        if (url.pathname.endsWith("/install"))
          return Response.json({ jobId: "ext-job" }, { status: 202 });
        if (url.pathname.endsWith("/action")) return Response.json({ ok: true, jobId: "svc-job" });
        const id = url.pathname.split("/").at(-1) ?? "";
        observed.push(raw);
        if (phase === "error") return Response.json({ error: "Unavailable" }, { status: 500 });
        return Response.json(
          job({
            id,
            status:
              phase === "done" || (phase === "service" && id === "svc-job")
                ? status
                : "cancel_pending",
          }),
        );
      });
      const { qc, view, rerender } = mount();
      const extKey = ["admin", "extensions", "", "installed"],
        svcKey = ["admin", "services", "", "list"],
        other = ["admin", "extensions", "http://other.test", "installed"];
      for (const k of [extKey, svcKey, other]) qc.setQueryData(k, {});
      fireEvent.click(screen.getByText("Extension"));
      fireEvent.click(screen.getByText("Service"));
      await waitFor(() =>
        expect(
          qc.getQueryData(["admin", "jobs", "detail", "", "application", "ext-job"]),
        ).toMatchObject({ status: "cancel_pending" }),
      );
      rerender(view(false));
      expect(qc.getQueryState(extKey)?.isInvalidated).toBe(false);
      phase = "error";
      await act(() => qc.invalidateQueries({ queryKey: ["admin", "jobs", "detail"] }));
      expect(qc.getQueryState(extKey)?.isInvalidated).toBe(false);
      expect(qc.getQueryState(svcKey)?.isInvalidated).toBe(false);
      phase = "service";
      await act(() => qc.invalidateQueries({ queryKey: ["admin", "jobs", "detail"] }));
      await waitFor(() => expect(qc.getQueryState(svcKey)?.isInvalidated).toBe(true));
      expect(qc.getQueryState(extKey)?.isInvalidated).toBe(false);
      phase = "done";
      await act(() => qc.invalidateQueries({ queryKey: ["admin", "jobs", "detail"] }));
      await waitFor(() => expect(qc.getQueryState(extKey)?.isInvalidated).toBe(true));
      expect(qc.getQueryState(svcKey)?.isInvalidated).toBe(true);
      expect(qc.getQueryState(other)?.isInvalidated).toBe(false);
      expect(observed.every((url) => new URL(url).origin === window.location.origin)).toBe(true);
    },
  );
  it("registers a late acknowledgement after only its view unmounts", async () => {
    const acceptance = deferred<Response>();
    let observed = false;
    vi.stubGlobal("fetch", (raw: string) => {
      if (raw.endsWith("/install")) return acceptance.promise;
      observed = true;
      return Response.json(job({ id: "ext-job", status: "success" }));
    });
    const { view, rerender, qc } = mount();
    const key = ["admin", "extensions", "", "installed"];
    qc.setQueryData(key, {});
    fireEvent.click(screen.getByText("Extension"));
    await act(async () => {});
    rerender(view(false));
    await act(async () => acceptance.resolve(Response.json({ jobId: "ext-job" }, { status: 202 })));
    await waitFor(() => expect(qc.getQueryState(key)?.isInvalidated).toBe(true));
    expect(observed).toBe(true);
  });
  it("rejects late extension acknowledgement after provider origin ABA", async () => {
    const acceptance = deferred<Response>();
    let observed = false;
    vi.stubGlobal("fetch", (raw: string) => {
      if (raw.endsWith("/install")) return acceptance.promise;
      observed = true;
      return Response.json(job());
    });
    const { view, rerender } = mount();
    fireEvent.click(screen.getByText("Extension"));
    await act(async () => {});
    apiUrl = "http://other.test";
    rerender(view());
    apiUrl = "";
    rerender(view());
    await act(async () => acceptance.resolve(Response.json({ jobId: "job-1" }, { status: 202 })));
    expect(observed).toBe(false);
  });
});

it("observes one accepted identity once and unions distinct settlement callbacks", async () => {
  const first = vi.fn(),
    second = vi.fn();
  const firstEffect = () => {
      first();
    },
    secondEffect = () => {
      second();
    };
  let finished = false;
  vi.stubGlobal("fetch", async () =>
    Response.json(job({ id: "shared-job", status: finished ? "success" : "running" })),
  );
  function Register() {
    const { client, apiUrl: origin } = useActivityClient();
    const register = useAdminJobRegistration();
    return (
      <button
        type="button"
        onClick={() => {
          for (const onSettled of [firstEffect, secondEffect, firstEffect])
            register({ client, apiUrl: origin, jobId: "shared-job", onSettled });
        }}
      >
        Register retry
      </button>
    );
  }
  const qc = createTestQueryClient();
  caches.push(qc);
  render(
    <QueryClientProvider client={qc}>
      <AdminJobEffectsProvider>
        <Register />
      </AdminJobEffectsProvider>
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByText("Register retry"));
  await waitFor(() =>
    expect(
      qc.getQueryData(["admin", "jobs", "detail", "", "application", "shared-job"]),
    ).toMatchObject({ status: "running" }),
  );
  expect(
    qc
      .getQueryCache()
      .find({ queryKey: ["admin", "jobs", "detail", "", "application", "shared-job"] })
      ?.getObserversCount(),
  ).toBe(1);
  finished = true;
  await act(() => qc.invalidateQueries({ queryKey: ["admin", "jobs", "detail"] }));
  await waitFor(() => expect(first).toHaveBeenCalledTimes(1));
  expect(second).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByText("Register retry"));
  await act(async () => {});
  expect(first).toHaveBeenCalledTimes(1);
  expect(second).toHaveBeenCalledTimes(1);
});

it("bounds the visible tray without dropping any of nine unresolved observers", async () => {
  vi.stubGlobal("fetch", async (raw: string) =>
    raw.includes("job-1?")
      ? Response.json({ error: "Unavailable" }, { status: 503 })
      : Response.json(
          job({
            id: decodeURIComponent(new URL(raw).pathname.split("/").at(-1) ?? ""),
            status: "running",
          }),
        ),
  );
  function Register() {
    const { client, apiUrl: origin } = useActivityClient();
    const register = useAdminJobRegistration();
    return (
      <button
        type="button"
        onClick={() => {
          for (let i = 0; i < 9; i++)
            register({
              client,
              apiUrl: origin,
              jobId: `job-${i}`,
              label: `Job ${i}`,
              onSettled: () => {},
            });
        }}
      >
        Queue nine
      </button>
    );
  }
  const qc = createTestQueryClient();
  caches.push(qc);
  render(
    <QueryClientProvider client={qc}>
      <AdminJobEffectsProvider>
        <Register />
        <AdminJobTray />
      </AdminJobEffectsProvider>
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByText("Queue nine"));
  await waitFor(() =>
    expect(
      qc
        .getQueryCache()
        .getAll()
        .filter((query) => query.queryKey[2] === "detail" && query.getObserversCount() === 1),
    ).toHaveLength(9),
  );
  fireEvent.click(screen.getByRole("button", { name: "Administration jobs, 9 active" }));
  expect(screen.getAllByRole("link", { name: /^Job / })).toHaveLength(8);
  expect(screen.getByRole("link", { name: "All jobs" })).toHaveAttribute(
    "href",
    "/admin/activity?tab=jobs",
  );
  expect(await screen.findByText("Outcome unknown")).toBeInTheDocument();
});
it("does not observe broad application jobs when the administration role disables registration", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  function Register() {
    const { client, apiUrl: origin } = useActivityClient();
    const register = useAdminJobRegistration();
    return (
      <button
        type="button"
        onClick={() =>
          register({ client, apiUrl: origin, jobId: "forbidden", onSettled: () => {} })
        }
      >
        Try registration
      </button>
    );
  }
  const qc = createTestQueryClient();
  caches.push(qc);
  render(
    <QueryClientProvider client={qc}>
      <AdminJobEffectsProvider enabled={false}>
        <Register />
      </AdminJobEffectsProvider>
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByText("Try registration"));
  await act(async () => {});
  expect(fetcher).not.toHaveBeenCalled();
});

it("keeps an older active job visible before newer completed jobs", async () => {
  vi.stubGlobal("fetch", async (raw: string) => {
    const id = new URL(raw).pathname.split("/").at(-1) ?? "";
    return Response.json(job({ id, status: id === "old-active" ? "running" : "success" }));
  });
  function Register() {
    const { client, apiUrl: origin } = useActivityClient();
    const register = useAdminJobRegistration();
    return (
      <button
        type="button"
        onClick={() => {
          register({
            client,
            apiUrl: origin,
            jobId: "old-active",
            label: "Still running",
            onSettled: () => {},
          });
          for (let i = 0; i < 8; i++)
            register({
              client,
              apiUrl: origin,
              jobId: `done-${i}`,
              label: `Completed ${i}`,
              onSettled: () => {},
            });
        }}
      >
        Queue mixed
      </button>
    );
  }
  const qc = createTestQueryClient();
  caches.push(qc);
  render(
    <QueryClientProvider client={qc}>
      <AdminJobEffectsProvider>
        <Register />
        <AdminJobTray />
      </AdminJobEffectsProvider>
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByText("Queue mixed"));
  await screen.findByRole("button", { name: "Administration jobs, 1 active" });
  fireEvent.click(screen.getByRole("button", { name: "Administration jobs, 1 active" }));
  expect(screen.getByRole("link", { name: "Still running" })).toHaveAttribute(
    "href",
    "/admin/activity?tab=jobs&job=old-active&source=application",
  );
});
