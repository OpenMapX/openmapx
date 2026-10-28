import { SERVICE_ACTIONS } from "@openmapx/core/ops";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { job } from "@/components/admin/activity/__tests__/fixtures";
import { AdminJobEffectsProvider } from "@/lib/admin/adminJobEffects";
import { act, cleanup, createTestQueryClient, fireEvent, render, screen, waitFor } from "@/test";
import { RequiredServicesPanel } from "../integrations/RequiredServicesPanel";
import { ServiceCatalog } from "./ServiceCatalog";
import { ServiceCredentials } from "./ServiceCredentials";
import { ServiceDetail } from "./ServiceDetail";

const availableActions = Object.fromEntries(
  SERVICE_ACTIONS.map((action) => [
    action,
    { available: true, execution: "direct", reason: null, workflow: null },
  ]),
);
const acquisition = { state: "available", reason: null };
let apiUrl = "http://admin.test";
const toast = vi.fn();
vi.mock("@/integration-api/runtime/EnvProvider", () => ({ useEnv: () => ({ apiUrl }) }));
vi.mock("../shared/AdminToast", () => ({ useAdminToast: () => toast }));
vi.mock("./ManagedDawarichSetup", () => ({ ManagedDawarichSetup: () => null }));
vi.mock("./ServiceLogsDrawer", () => ({ ServiceLogsDrawer: () => null }));
const caches: ReturnType<typeof createTestQueryClient>[] = [];
function pending<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { resolve, promise };
}
const schema = {
  type: "object",
  properties: {
    count: { type: "integer", title: "Count" },
    locked: { type: "string", title: "Locked" },
  },
};
const manifest = (id: string) => ({
  id,
  name: id,
  version: "1.0.0",
  quality: "built-in",
  container: { image: "example.invalid/demo", tag: "1", future: { retained: true } },
  provides: [{ capability: "routing", metadata: { future: [true] } }],
  configSchema: schema,
  future: { untouched: [1, false] },
});
const selection = {
  source: "file",
  selectedRoots: ["demo"],
  requestedIds: ["demo"],
  effectiveIds: ["demo", "dependency"],
  warnings: ["Synthetic warning"],
  missingIds: [],
  envVarName: "OPENMAPX_SERVICES",
  envVarValue: null,
  selectionFilePath: "/synthetic/selection.json",
};
function setup(
  handler?: (url: URL, init: RequestInit) => Response | Promise<Response> | undefined,
) {
  let saved = 1;
  const requests: { url: URL; init: RequestInit }[] = [];
  vi.stubGlobal("fetch", (input: string, init: RequestInit) => {
    const url = new URL(input);
    requests.push({ url, init });
    const response = handler?.(url, init);
    if (response) return response;
    const path = url.pathname;
    if (path.startsWith("/api/admin/jobs/"))
      return Response.json(job({ id: path.split("/").at(-1), status: "running" }));
    if (path.endsWith("/selection")) return Response.json(selection);
    if (path.endsWith("/credentials"))
      return Response.json({
        serviceId: path.split("/").at(-2),
        secretsConfigured: true,
        credentials: [{ key: "TOKEN", title: "Demo token", source: "vault", updatedBy: null }],
      });
    if (path.endsWith("/config")) {
      if (init.method === "POST") {
        saved = JSON.parse(String(init.body)).config.count;
        return Response.json({ ok: true });
      }
      return Response.json({
        schema,
        resolvedConfig: {
          count: { value: saved, source: "database" },
          locked: { value: "host", source: "env" },
        },
        envPrefix: "SERVICE_DEMO_",
      });
    }
    if (path.endsWith("/action")) return Response.json({ ok: true, jobId: "job-1" });
    if (path === "/api/admin/services")
      return Response.json({
        acquisition,
        services: [
          {
            id: "demo",
            name: "Demo",
            version: "1.0.0",
            quality: "built-in",
            provides: ["routing"],
            consumes: [],
            enabled: true,
            isBuiltIn: true,
            actions: availableActions,
            status: "not-running",
          },
        ],
        summary: { unknown: 0, running: 0, stopped: 1, total: 1 },
      });
    return Response.json({
      acquisition,
      manifest: { ...manifest(path.split("/").at(-1) ?? "missing"), provides: ["routing"] },
      directory: "/synthetic",
      isBuiltIn: true,
      actions: availableActions,
      enabled: true,
      status: "not-running",
    });
  });
  return requests;
}
function mount(child: React.ReactNode) {
  const qc = createTestQueryClient();
  caches.push(qc);
  const view = (next: React.ReactNode) => (
    <QueryClientProvider client={qc}>
      <AdminJobEffectsProvider>{next}</AdminJobEffectsProvider>
    </QueryClientProvider>
  );
  return { qc, view, ...render(view(child)) };
}
async function config() {
  fireEvent.click(await screen.findByRole("tab", { name: "Configuration" }));
  await waitFor(() => expect(screen.getByRole("spinbutton")).toHaveValue(1));
  fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "2" } });
}
async function editCredential(value = "synthetic-private") {
  fireEvent.click(await screen.findByRole("button", { name: "Rotate" }));
  fireEvent.change(screen.getByLabelText("Value"), { target: { value } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
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
describe("service administration visible behavior with the generated SDK", () => {
  it("normalizes structured detail capabilities while retaining the complete raw manifest", async () => {
    setup((url) =>
      url.pathname === "/api/admin/services/demo"
        ? Response.json({
            acquisition,
            manifest: manifest("demo"),
            directory: "/synthetic",
            isBuiltIn: true,
            actions: availableActions,
            enabled: true,
            status: "not-running",
          })
        : undefined,
    );
    mount(<ServiceDetail id="demo" />);
    expect(await screen.findByText("routing")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Manifest" }));
    const raw = screen.getByText(/"untouched"/).textContent ?? "";
    expect(JSON.parse(raw)).toEqual(manifest("demo"));
  });
  it.each([true, false])(
    "distinguishes saved manual render (%s) from queued credential application",
    async (manual) => {
      setup((_url, init) =>
        init.method === "PUT"
          ? Response.json(manual ? { ok: true, needsRender: true } : { ok: true, jobId: "job-1" })
          : undefined,
      );
      mount(<ServiceCredentials serviceId="demo" />);
      await editCredential();
      await waitFor(() => expect(toast).toHaveBeenCalled());
      expect(toast.mock.calls[0][0]).toMatch(manual ? /Saved.*Render/ : /queued/i);
    },
  );
  it.each(["success", "error"] as const)(
    "fences credential dialog replacement on deferred %s",
    async (outcome) => {
      const deferred = pending<Response>();
      setup((_url, init) => (init.method === "PUT" ? deferred.promise : undefined));
      mount(<ServiceCredentials serviceId="demo" />);
      await editCredential();
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      fireEvent.click(await screen.findByRole("button", { name: "Rotate" }));
      fireEvent.change(screen.getByLabelText("Value"), { target: { value: "replacement-input" } });
      expect(screen.getByRole("button", { name: "Save" })).not.toBeDisabled();
      await act(async () =>
        deferred.resolve(
          outcome === "success"
            ? Response.json({ ok: true, needsRender: true })
            : Response.json({ error: "Rejected" }, { status: 400 }),
        ),
      );
      expect(screen.getByLabelText("Value")).toHaveValue("replacement-input");
      expect(toast).not.toHaveBeenCalled();
    },
  );
  it.each(
    (["service", "origin", "unmount"] as const).flatMap((replacement) =>
      ["success", "error"].map((outcome) => [replacement, outcome] as const),
    ),
  )("fences credential %s replacement on deferred %s", async (replacement, outcome) => {
    const deferred = pending<Response>();
    setup((_url, init) => (init.method === "PUT" ? deferred.promise : undefined));
    const { view, rerender, unmount } = mount(<ServiceCredentials serviceId="demo" />);
    await editCredential();
    if (replacement === "unmount") unmount();
    else {
      if (replacement === "origin") apiUrl = "http://second.test";
      rerender(
        view(<ServiceCredentials serviceId={replacement === "service" ? "next" : "demo"} />),
      );
    }
    await act(async () =>
      deferred.resolve(
        outcome === "success"
          ? Response.json({ ok: true, jobId: "job-1" })
          : Response.json({ error: "Old credential error" }, { status: 400 }),
      ),
    );
    expect(toast).not.toHaveBeenCalled();
    if (replacement !== "unmount") expect(screen.queryByLabelText("Value")).not.toBeInTheDocument();
  });
  it("shows config errors arrays, keeps env locks and prevents start after failed save", async () => {
    const requests = setup((url, init) =>
      url.pathname.endsWith("/config") && init.method === "POST"
        ? Response.json({ errors: ["Count is invalid", "Choose another value"] }, { status: 400 })
        : undefined,
    );
    mount(<ServiceDetail id="demo" />);
    await config();
    expect(screen.getByDisplayValue("host")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Save & apply" }));
    expect(await screen.findByText("Count is invalid; Choose another value")).toBeInTheDocument();
    expect(requests.filter((r) => r.url.pathname.endsWith("/action"))).toHaveLength(0);
  });
  it("keeps saved configuration after start failure and labels accepted start as queued", async () => {
    let failStart = true;
    setup((url, init) =>
      url.pathname.endsWith("/action") && init.method === "POST" && failStart
        ? Response.json({ error: "Start denied; saved configuration retained" }, { status: 400 })
        : undefined,
    );
    const { qc } = mount(<ServiceDetail id="demo" />);
    await config();
    fireEvent.click(screen.getByRole("button", { name: "Save & apply" }));
    expect(
      await screen.findByText("Start denied; saved configuration retained"),
    ).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("spinbutton")).toHaveValue(2));
    expect(qc.getQueryData(["admin", "services", apiUrl, "config", "demo"])).toMatchObject({
      resolvedConfig: { count: { value: 2 } },
    });
    failStart = false;
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "Save & apply" }));
    expect(await screen.findByText(/Configuration saved.*queued/i)).toBeInTheDocument();
    expect(screen.queryByText("Configuration saved and applied.")).not.toBeInTheDocument();
  });
  it.each(
    (["service", "origin", "tab", "unmount"] as const).flatMap((replacement) =>
      ["success", "error"].map((outcome) => [replacement, outcome] as const),
    ),
  )(
    "does not start or update replacement config after %s disposal and deferred %s",
    async (replacement, outcome) => {
      const deferred = pending<Response>();
      const requests = setup((url, init) =>
        url.pathname.endsWith("/config") && init.method === "POST" ? deferred.promise : undefined,
      );
      const { view, rerender, unmount } = mount(<ServiceDetail id="demo" />);
      await config();
      fireEvent.click(screen.getByRole("button", { name: "Save & apply" }));
      await waitFor(() => expect(requests.some((r) => r.init.method === "POST")).toBe(true));
      if (replacement === "unmount") unmount();
      else if (replacement === "tab")
        fireEvent.click(screen.getByRole("tab", { name: "Overview" }));
      else {
        if (replacement === "origin") apiUrl = "http://second.test";
        rerender(view(<ServiceDetail id={replacement === "service" ? "next" : "demo"} />));
      }
      await act(async () =>
        deferred.resolve(
          outcome === "success"
            ? Response.json({ ok: true })
            : Response.json({ errors: ["Old config error"] }, { status: 400 }),
        ),
      );
      expect(requests.filter((r) => r.url.pathname.endsWith("/action"))).toHaveLength(0);
      expect(screen.queryByText(/Configuration saved/)).not.toBeInTheDocument();
    },
  );
  it("preserves complete selection diagnostics and source lock without reinterpreting summary capabilities", async () => {
    setup((url) =>
      url.pathname.endsWith("/selection")
        ? Response.json({ ...selection, source: "env", envVarValue: "demo" })
        : undefined,
    );
    mount(<ServiceCatalog />);
    expect(await screen.findByText("Requested: 1")).toBeInTheDocument();
    expect(screen.getByText("Effective: 2")).toBeInTheDocument();
    expect(screen.getByText("Synthetic warning")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save Selection" })).toBeDisabled();
    expect(await screen.findByText("routing")).toBeInTheDocument();
  });
  it("fences a catalog health completion toast after origin replacement", async () => {
    const deferred = pending<Response>();
    setup((url) => (url.pathname.endsWith("/check") ? deferred.promise : undefined));
    const { view, rerender } = mount(<ServiceCatalog />);
    fireEvent.click(await screen.findByRole("button", { name: "Run Service Check" }));
    await act(async () => {});
    apiUrl = "http://second.test";
    rerender(view(<ServiceCatalog />));
    await act(async () =>
      deferred.resolve(
        Response.json({ acquisition, statuses: [], checkedAt: "2026-10-21T12:00:00.000Z" }),
      ),
    );
    expect(toast).not.toHaveBeenCalled();
  });
  it("refreshes credentials independently after two actual hook jobs finish, including failure", async () => {
    let revision = 0;
    let accepted = 0;
    setup((url, init) => {
      if (init.method === "PUT" || init.method === "DELETE")
        return Response.json({ ok: true, jobId: `job-${++accepted}` });
      if (url.pathname.endsWith("/credentials"))
        return Response.json({
          serviceId: "demo",
          secretsConfigured: true,
          credentials: [
            {
              key: "TOKEN",
              title: "Demo token",
              source: revision === 2 ? "missing" : "vault",
              updatedAt: "2026-10-21T12:00:00.000Z",
              updatedBy: `Revision ${revision}`,
            },
          ],
        });
      if (url.pathname.startsWith("/api/admin/jobs/")) {
        const id = url.pathname.split("/").at(-1) ?? "missing";
        return Response.json(
          job({
            id,
            status:
              id === "job-1" && revision >= 1
                ? "success"
                : id === "job-2" && revision === 2
                  ? "failed"
                  : "cancel_pending",
          }),
        );
      }
      return undefined;
    });
    const { qc } = mount(<ServiceCredentials serviceId="demo" />);
    await editCredential();
    await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(toast).toHaveBeenCalledTimes(2));
    expect(screen.getByText(/by Revision 0/)).toBeInTheDocument();
    revision = 1;
    await act(() =>
      qc.invalidateQueries({
        queryKey: ["admin", "jobs", "detail", apiUrl, "application", "job-1"],
      }),
    );
    expect(await screen.findByText(/by Revision 1/)).toBeInTheDocument();
    revision = 2;
    await act(() =>
      qc.invalidateQueries({
        queryKey: ["admin", "jobs", "detail", apiUrl, "application", "job-2"],
      }),
    );
    expect(await screen.findByText("Not set")).toBeInTheDocument();
    expect(screen.getByText(/by Revision 2/)).toBeInTheDocument();
  });
  it.each([
    "service-success",
    "service-error",
    "origin-success",
    "origin-error",
    "unmount-success",
    "unmount-error",
  ] as const)("fences lifecycle completion for %s", async (replacement) => {
    const deferred = pending<Response>();
    const requests = setup((url) =>
      url.pathname.endsWith("/action") ? deferred.promise : undefined,
    );
    const { view, rerender, unmount } = mount(<ServiceDetail id="demo" />);
    fireEvent.click(await screen.findByRole("button", { name: "Start" }));
    await waitFor(() => expect(requests.some((r) => r.init.method === "POST")).toBe(true));
    if (replacement.startsWith("unmount")) unmount();
    else {
      if (replacement.startsWith("origin")) apiUrl = "http://second.test";
      rerender(view(<ServiceDetail id={replacement.startsWith("service") ? "next" : "demo"} />));
    }
    await act(async () =>
      deferred.resolve(
        replacement.endsWith("error")
          ? Response.json({ error: "Old action error" }, { status: 400 })
          : Response.json({ ok: true, jobId: "job-1" }),
      ),
    );
    expect(toast).not.toHaveBeenCalled();
  });
  it.each(["success", "error"] as const)(
    "fences old config %s after form schema replacement without changing the new input",
    async (outcome) => {
      const deferred = pending<Response>();
      let replaced = false;
      const requests = setup((url, init) => {
        if (url.pathname.endsWith("/config") && init.method === "POST") return deferred.promise;
        if (url.pathname.endsWith("/config") && replaced && outcome === "success")
          return Response.json({
            schema,
            resolvedConfig: {
              count: { value: 2, source: "database" },
              locked: { value: "host", source: "env" },
            },
            envPrefix: "SERVICE_REPLACEMENT_",
          });
        if (url.pathname === "/api/admin/services/demo" && replaced)
          return Response.json({
            acquisition,
            manifest: {
              ...manifest("demo"),
              provides: ["routing"],
              configSchema: {
                ...schema,
                properties: {
                  ...schema.properties,
                  extra: { type: "string", title: "Replacement field" },
                },
              },
            },
            directory: "/synthetic",
            enabled: true,
            isBuiltIn: true,
            actions: availableActions,
            status: "not-running",
          });
        return undefined;
      });
      const { qc } = mount(<ServiceDetail id="demo" />);
      await config();
      fireEvent.click(screen.getByRole("button", { name: "Save & apply" }));
      replaced = true;
      await act(() =>
        qc.invalidateQueries({ queryKey: ["admin", "services", apiUrl, "detail", "demo"] }),
      );
      await screen.findByText("Replacement field");
      fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "8" } });
      await act(async () =>
        deferred.resolve(
          outcome === "error"
            ? Response.json({ errors: ["Old form error"] }, { status: 400 })
            : Response.json({ ok: true }),
        ),
      );
      if (outcome === "success") await screen.findByText(/SERVICE_REPLACEMENT_/);
      expect(screen.getByRole("spinbutton")).toHaveValue(8);
      expect(requests.filter((r) => r.url.pathname.endsWith("/action"))).toHaveLength(0);
      expect(screen.queryByText("Old form error")).not.toBeInTheDocument();
      expect(screen.queryByText(/Configuration saved/)).not.toBeInTheDocument();
    },
  );

  it("uses normalized list capabilities in the existing integration binding picker", async () => {
    let bound = false;
    const requests = setup((url, init) => {
      if (url.pathname === "/api/admin/integrations/demo/bindings")
        return Response.json({
          bindings: bound ? [{ capability: "routing", serviceId: "demo" }] : [],
        });
      if (
        url.pathname === "/api/admin/integrations/demo/bindings/routing" &&
        init.method === "POST"
      ) {
        bound = true;
        return Response.json({ ok: true });
      }
      return undefined;
    });
    mount(<RequiredServicesPanel integrationId="demo" requires={[{ capability: "routing" }]} />);
    await waitFor(() =>
      expect(
        screen.queryByText("No installed services provide this capability"),
      ).not.toBeInTheDocument(),
    );
    fireEvent.mouseDown(screen.getByRole("combobox"));
    fireEvent.click(await screen.findByRole("option", { name: "Demo (demo)" }));
    await waitFor(() => expect(bound).toBe(true));
    expect(requests.find((r) => r.init.method === "POST")?.init.body).toBe(
      JSON.stringify({ serviceId: "demo" }),
    );
    expect(await screen.findByText("Demo (demo)")).toBeInTheDocument();
  });
  it("queues selected lifecycle and explicit all-build jobs, then refreshes catalog state independently", async () => {
    let accepted = 0;
    let revision = 1;
    const requests = setup((url, init) => {
      if (url.pathname.endsWith("/bulk-action"))
        return Response.json({ ok: true, jobId: `job-${++accepted}` });
      if (url.pathname.startsWith("/api/admin/jobs/")) {
        const id = url.pathname.split("/").at(-1) ?? "missing";
        return Response.json(
          job({
            id,
            status:
              id === "job-1" && revision >= 2
                ? "success"
                : id === "job-2" && revision === 3
                  ? "canceled"
                  : "cancel_pending",
          }),
        );
      }
      if (url.pathname === "/api/admin/services" && init.method === "GET")
        return Response.json({
          acquisition,
          services: [
            {
              id: "demo",
              name: "Demo",
              version: `${revision}.0.0`,
              quality: "built-in",
              provides: ["routing"],
              consumes: [],
              enabled: true,
              isBuiltIn: true,
              actions: availableActions,
              status: revision === 2 ? "running" : "not-running",
            },
          ],
          summary: {
            unknown: 0,
            running: revision === 2 ? 1 : 0,
            stopped: revision === 2 ? 0 : 1,
            total: 1,
          },
        });
      return undefined;
    });
    const { qc } = mount(<ServiceCatalog />);
    await screen.findByText("Demo");
    fireEvent.click(screen.getAllByRole("checkbox")[0]);
    fireEvent.click(screen.getByRole("button", { name: "Start Selected" }));
    await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Build All" }));
    await waitFor(() => expect(toast).toHaveBeenCalledTimes(2));
    const bodies = requests
      .filter((r) => r.url.pathname.endsWith("/bulk-action"))
      .map((r) => JSON.parse(String(r.init.body)));
    expect(bodies).toEqual([
      { action: "start", serviceIds: ["demo"] },
      { action: "build", all: true, continueOnError: true },
    ]);
    expect(screen.getByText("0 running")).toBeInTheDocument();
    revision = 2;
    await act(() =>
      qc.invalidateQueries({
        queryKey: ["admin", "jobs", "detail", apiUrl, "application", "job-1"],
      }),
    );
    expect(await screen.findByText("1 running")).toBeInTheDocument();
    revision = 3;
    await act(() =>
      qc.invalidateQueries({
        queryKey: ["admin", "jobs", "detail", apiUrl, "application", "job-2"],
      }),
    );
    expect(await screen.findByText("3.0.0")).toBeInTheDocument();
    expect(screen.getByText("0 running")).toBeInTheDocument();
  });
  it("saves deliberate empty selection and refreshes its full server summary", async () => {
    let cleared = false;
    const requests = setup((url, init) => {
      if (!url.pathname.endsWith("/selection")) return undefined;
      const summary = {
        ...selection,
        selectedRoots: [],
        requestedIds: [],
        effectiveIds: [],
        warnings: ["Saved selection warning"],
      };
      if (init.method === "PUT") {
        cleared = true;
        return Response.json({ ok: true, revisionId: "synthetic-revision", summary });
      }
      return Response.json(cleared ? summary : selection);
    });
    mount(<ServiceCatalog />);
    await screen.findByDisplayValue("demo");
    fireEvent.change(screen.getByLabelText("Selected root service IDs"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Selection" }));
    expect(await screen.findByText("Saved selection warning")).toBeInTheDocument();
    expect(screen.getByText("Effective: 0")).toBeInTheDocument();
    expect(requests.find((r) => r.init.method === "PUT")?.init.body).toBe(
      JSON.stringify({ selectedRoots: [] }),
    );
  });
});

it("uses capabilities for deselected running service cleanup", async () => {
  setup((url) =>
    url.pathname === "/api/admin/services/demo"
      ? Response.json({
          manifest: manifest("demo"),
          directory: "/synthetic",
          isBuiltIn: true,
          enabled: false,
          status: "running",
          acquisition,
          actions: {
            ...availableActions,
            start: { available: false, execution: "direct", reason: "disabled", workflow: null },
            apply: { available: false, execution: "direct", reason: "disabled", workflow: null },
          },
        })
      : undefined,
  );
  mount(<ServiceDetail id="demo" />);
  expect(await screen.findByRole("button", { name: "Apply changes" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Stop" })).not.toBeDisabled();
  expect(screen.getByRole("button", { name: "Logs" })).not.toBeDisabled();
});
it("disables unavailable controls and keeps outage guidance visible", async () => {
  const actions = Object.fromEntries(
    SERVICE_ACTIONS.map((action) => [
      action,
      { available: false, execution: "direct", reason: "unavailable", workflow: null },
    ]),
  );
  setup((url) =>
    url.pathname === "/api/admin/services/demo"
      ? Response.json({
          manifest: manifest("demo"),
          directory: "/synthetic",
          isBuiltIn: true,
          enabled: true,
          status: "unknown",
          acquisition: { state: "unavailable", reason: "ops_unavailable" },
          actions,
        })
      : undefined,
  );
  mount(<ServiceDetail id="demo" />);
  expect(await screen.findByRole("button", { name: "Restart" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Logs" })).toBeDisabled();
  expect(screen.getByText(/Operations agent is unavailable/)).toBeInTheDocument();
});

it("disables a mixed bulk action and lists ineligible IDs", async () => {
  const core = {
    ...availableActions,
    restart: { available: true, execution: "workflow", reason: null, workflow: "core-restart" },
  };
  setup((url) =>
    url.pathname === "/api/admin/services"
      ? Response.json({
          acquisition,
          services: [
            {
              id: "demo",
              name: "Demo",
              version: "1",
              quality: "built-in",
              provides: [],
              consumes: [],
              enabled: true,
              isBuiltIn: true,
              status: "running",
              actions: availableActions,
            },
            {
              id: "app-api",
              name: "API",
              version: "1",
              quality: "built-in",
              provides: [],
              consumes: [],
              enabled: true,
              isBuiltIn: true,
              status: "running",
              actions: core,
            },
          ],
          summary: { running: 2, stopped: 0, unknown: 0, total: 2 },
        })
      : undefined,
  );
  mount(<ServiceCatalog />);
  await screen.findByRole("link", { name: "Demo" });
  fireEvent.click(screen.getAllByRole("checkbox")[0]);
  const button = screen.getByRole("button", { name: "Restart Selected" });
  expect(button).toBeDisabled();
  expect(button).toHaveAttribute("title", expect.stringContaining("app-api"));
});
