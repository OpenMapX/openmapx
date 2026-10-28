import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  createTestQueryClient,
  fireEvent,
  render,
  screen,
  userEvent,
  waitFor,
} from "@/test";
import { job } from "../../activity/__tests__/fixtures";
import { AdminOverview } from "../../overview/AdminOverview";
import { AdminToastProvider } from "../../shared/AdminToast";
import { BulkConfigure } from "../BulkConfigure";
import { ConfigSchemaForm } from "../ConfigSchemaForm";
import { IntegrationDetail } from "../IntegrationDetail";
import { IntegrationList } from "../IntegrationList";
import { RequiredServicesPanel } from "../RequiredServicesPanel";
import { SetCredentialDialog } from "../SetCredentialDialog";
import { detail, summary } from "./fixtures";

const credentialReceipt = {
  operationId: "credential-synthetic-operation",
  integrationId: "demo",
  desiredRevision: "a".repeat(64),
  database: "retained",
  runtime: "applied",
  runtimeGenerationId: "11111111-1111-4111-8111-111111111111",
};
let apiUrl = "http://admin.test";
vi.mock("@/integration-api/runtime/EnvProvider", () => ({ useEnv: () => ({ apiUrl }) }));
// Service acquisition is outside this integration-family task.
vi.mock("@/hooks/useServices", () => ({
  useServicesList: () => ({
    data: {
      services: [{ id: "local", name: "Local", status: "running", provides: ["search /places"] }],
    },
  }),
}));

const clients: ReturnType<typeof createTestQueryClient>[] = [];
function mount(node: React.ReactNode, retryQueries = false) {
  const client = createTestQueryClient();
  // A caller must explicitly disable mutation retries, even under a retrying host default.
  client.setDefaultOptions({
    queries: { retry: retryQueries ? 2 : false, retryDelay: 1 },
    mutations: { retry: 2, retryDelay: 1 },
  });
  clients.push(client);
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <AdminToastProvider>{node}</AdminToastProvider>
      </QueryClientProvider>,
    ),
  };
}
function transport(handler: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: URL; init: RequestInit }[] = [];
  vi.stubGlobal("fetch", (input: string, init: RequestInit) => {
    const url = new URL(input);
    if (url.origin !== apiUrl) throw new Error(`Unexpected network origin: ${url.origin}`);
    expect(init.credentials).toBe("include");
    calls.push({ url, init });
    return handler(url, init);
  });
  return calls;
}
beforeEach(() => {
  apiUrl = "http://admin.test";
});
afterEach(() => {
  cleanup();
  for (const c of clients.splice(0)) c.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("integration administration browser behavior", () => {
  it.each(["origin", "integration", "credential", "unmount"])(
    "owns a deferred credential completion across %s replacement",
    async (replacement) => {
      let finish!: (response: Response) => void;
      const pending = new Promise<Response>((resolve) => {
        finish = resolve;
      });
      const calls = transport(() => pending);
      const oldClose = vi.fn(),
        replacementClose = vi.fn();
      const props = {
        open: true,
        expectedRevision: "a".repeat(64),
        integrationId: "demo",
        credentialKey: "token",
        title: "Token",
        onClose: oldClose,
      };
      const { client, rerender, unmount } = mount(<SetCredentialDialog {...props} />);
      const invalidation = vi.spyOn(client, "invalidateQueries");
      fireEvent.change(screen.getByLabelText("Token"), { target: { value: "old-input" } });
      await userEvent.click(screen.getByRole("button", { name: "Save Credential" }));
      await waitFor(() => expect(calls).toHaveLength(1));
      if (replacement === "unmount") unmount();
      else {
        if (replacement === "origin") apiUrl = "http://replacement.test";
        rerender(
          <QueryClientProvider client={client}>
            <AdminToastProvider>
              <SetCredentialDialog
                {...props}
                integrationId={replacement === "integration" ? "other" : "demo"}
                credentialKey={replacement === "credential" ? "other" : "token"}
                onClose={replacementClose}
              />
            </AdminToastProvider>
          </QueryClientProvider>,
        );
        fireEvent.change(screen.getByLabelText("Token"), {
          target: { value: "replacement-input" },
        });
      }
      await act(async () => {
        finish(Response.json(credentialReceipt));
        await pending;
      });
      await waitFor(() => expect(invalidation).toHaveBeenCalled());
      expect(oldClose).not.toHaveBeenCalled();
      expect(replacementClose).not.toHaveBeenCalled();
      if (replacement !== "unmount")
        expect(screen.getByLabelText("Token")).toHaveValue("replacement-input");
      expect(
        invalidation.mock.calls.every(
          ([options]) => !JSON.stringify(options).includes("replacement.test"),
        ),
      ).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0].init.signal?.aborted).toBe(false);
    },
  );

  it("keeps replacement config input and feedback when an older save rejects", async () => {
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    const calls = transport(() => pending);
    const saved = vi.fn();
    const schema = { properties: { label: { type: "string", title: "Label" } } };
    const resolvedConfig = { label: { value: "before", source: "database" as const } };
    const { client, rerender } = mount(
      <ConfigSchemaForm
        integrationId="demo"
        schema={schema}
        resolvedConfig={resolvedConfig}
        onSaved={saved}
      />,
    );
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "old" } });
    await userEvent.click(screen.getByRole("button", { name: /^Save/ }));
    await waitFor(() => expect(calls).toHaveLength(1));
    apiUrl = "http://replacement.test";
    rerender(
      <QueryClientProvider client={client}>
        <AdminToastProvider>
          <ConfigSchemaForm
            integrationId="other"
            schema={schema}
            resolvedConfig={resolvedConfig}
            onSaved={saved}
          />
        </AdminToastProvider>
      </QueryClientProvider>,
    );
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "new-input" } });
    await act(async () => {
      finish(Response.json({ errors: ["old-owner-error"] }, { status: 400 }));
      await pending;
    });
    expect(saved).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox")).toHaveValue("new-input");
    expect(screen.queryByText("old-owner-error")).not.toBeInTheDocument();
    expect(screen.queryByText("Configuration saved.")).not.toBeInTheDocument();
    expect(calls).toHaveLength(1);
  });

  it.each(
    [
      "overview-sweep",
      "list-sweep",
      "list-toggle",
      "detail-toggle",
      "detail-delete",
      "bulk-delete",
      "binding",
      "overview-reload",
      "list-reload",
      "detail-reload",
    ].flatMap((scenario) => [200, 400].map((status) => [scenario, status] as const)),
  )("keeps %s completion effects with the originating view (HTTP %s)", async (scenario, status) => {
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    const calls = transport((url, init) => {
      if (init.method && init.method !== "GET") return pending;
      if (url.pathname === "/api/admin/integrations") return Response.json([summary]);
      if (url.pathname === "/api/admin/integrations/demo")
        return Response.json({
          ...detail,
          credentialStatus: detail.credentialStatus.map((field) => ({ ...field, source: "vault" })),
        });
      if (url.pathname.endsWith("/bindings"))
        return Response.json({
          bindings: [],
          revision: "a".repeat(64),
          desiredRevision: "a".repeat(64),
          runtime: null,
          lastApplication: null,
        });
      if (url.pathname.endsWith("/env-vars"))
        return Response.json({
          integrations: [
            {
              id: "demo",
              name: "Demo",
              enabled: true,
              envVars: [
                { key: "token", name: "DEMO_TOKEN", title: "Token", secret: true, present: true },
              ],
            },
          ],
        });
      if (url.pathname === "/api/admin/credentials")
        return Response.json({ secretsConfigured: true, credentials: [] });
      if (url.pathname === "/api/admin/overview")
        return Response.json({
          systemHealth: { status: "pass", unhealthyCount: 0 },
          users: { total: 1, active24h: 1, banned: 0 },
          integrations: { total: 1, enabled: 1, unhealthy: 0, unconfigured: 0 },
          services: null,
          attention: [],
          recentActivity: [],
          activeJobs: [],
        });
      throw new Error(`Unexpected request ${url}`);
    });
    const component = () =>
      scenario.startsWith("overview") ? (
        <AdminOverview />
      ) : scenario.startsWith("list") ? (
        <IntegrationList />
      ) : scenario.startsWith("detail") ? (
        <IntegrationDetail id="demo" />
      ) : scenario === "bulk-delete" ? (
        <BulkConfigure />
      ) : (
        <RequiredServicesPanel integrationId="demo" requires={[{ capability: "search /places" }]} />
      );
    const { client, rerender } = mount(component());
    const invalidation = vi.spyOn(client, "invalidateQueries");
    if (scenario === "binding") {
      await waitFor(() => expect(calls.length).toBeGreaterThan(0));
      await userEvent.click(screen.getByRole("combobox"));
      await userEvent.click(await screen.findByRole("option", { name: "Local (local)" }));
    } else if (scenario.endsWith("delete")) {
      if (scenario === "bulk-delete")
        await userEvent.click(await screen.findByRole("button", { name: /Demo demo/ }));
      else await userEvent.click(await screen.findByRole("tab", { name: /Credentials/ }));
      await userEvent.click(await screen.findByRole("button", { name: "Delete from vault" }));
    } else if (scenario === "list-toggle") await userEvent.click(await screen.findByRole("switch"));
    else
      await userEvent.click(
        await screen.findByRole("button", {
          name: scenario.endsWith("reload")
            ? /Reload/
            : scenario === "detail-toggle"
              ? "Disable"
              : /Health [Cc]hecks/,
        }),
      );
    await waitFor(() =>
      expect(calls.filter(({ init }) => init.method && init.method !== "GET")).toHaveLength(1),
    );
    apiUrl = "http://replacement.test";
    rerender(
      <QueryClientProvider client={client}>
        <AdminToastProvider>{component()}</AdminToastProvider>
      </QueryClientProvider>,
    );
    const response = scenario.endsWith("reload")
      ? { ok: true, jobId: "job-old" }
      : scenario.endsWith("sweep")
        ? { timestamp: "2026-10-20T10:00:00.000Z", count: 1, results: [] }
        : scenario.endsWith("delete")
          ? credentialReceipt
          : scenario === "binding"
            ? { ok: true }
            : { ok: true, message: "Saved", reloaded: 1, enabled: 1 };
    await act(async () => {
      finish(
        Response.json(status === 200 ? response : { errors: ["old-owner-error"] }, { status }),
      );
      await pending;
    });
    await waitFor(() =>
      expect(
        client
          .getMutationCache()
          .getAll()
          .every((mutation) => mutation.state.status !== "pending"),
      ).toBe(true),
    );
    expect(
      screen.queryByText(
        /old-owner-error|Operation failed|Delete failed|Failed to delete|Health checks failed|Health check sweep failed|Reload failed|Failed to queue reload|Health checks complete|Health checks completed|Integration disabled|Credential.*deleted|Reload job queued/,
      ),
    ).not.toBeInTheDocument();
    expect(
      invalidation.mock.calls.every(
        ([options]) => !JSON.stringify(options).includes("replacement.test"),
      ),
    ).toBe(true);
    expect(calls.filter(({ init }) => init.method && init.method !== "GET")).toHaveLength(1);
    expect(calls.some(({ url }) => url.pathname.includes("cancel"))).toBe(false);
  });

  it.each(["origin", "identity", "unmount"])(
    "suppresses credential errors after %s disposal",
    async (replacement) => {
      let finish!: (response: Response) => void;
      const pending = new Promise<Response>((resolve) => {
        finish = resolve;
      });
      const calls = transport(() => pending);
      const closed = vi.fn();
      const props = {
        open: true,
        expectedRevision: "a".repeat(64),
        integrationId: "demo",
        credentialKey: "token",
        title: "Token",
        onClose: closed,
      };
      const { client, rerender, unmount } = mount(<SetCredentialDialog {...props} />);
      const invalidation = vi.spyOn(client, "invalidateQueries");
      fireEvent.change(screen.getByLabelText("Token"), { target: { value: "first" } });
      await userEvent.click(screen.getByRole("button", { name: "Save Credential" }));
      await waitFor(() => expect(calls).toHaveLength(1));
      if (replacement === "unmount") unmount();
      else {
        if (replacement === "origin") apiUrl = "http://replacement.test";
        rerender(
          <QueryClientProvider client={client}>
            <AdminToastProvider>
              <SetCredentialDialog
                {...props}
                credentialKey={replacement === "identity" ? "other" : "token"}
              />
            </AdminToastProvider>
          </QueryClientProvider>,
        );
        fireEvent.change(screen.getByLabelText("Token"), { target: { value: "replacement" } });
      }
      await act(async () => {
        finish(Response.json({ errors: ["old-owner-error"] }, { status: 400 }));
        await pending;
      });
      await waitFor(() =>
        expect(
          client
            .getMutationCache()
            .getAll()
            .every((mutation) => mutation.state.status !== "pending"),
        ).toBe(true),
      );
      expect(closed).not.toHaveBeenCalled();
      expect(screen.queryByText("old-owner-error")).not.toBeInTheDocument();
      if (replacement !== "unmount")
        expect(screen.getByLabelText("Token")).toHaveValue("replacement");
      expect(calls).toHaveLength(1);
      expect(invalidation).not.toHaveBeenCalled();
    },
  );

  it.each(["origin", "identity", "unmount"])(
    "does not call onSaved or clear a replacement config after %s",
    async (replacement) => {
      let finish!: (response: Response) => void;
      const pending = new Promise<Response>((resolve) => {
        finish = resolve;
      });
      const calls = transport(() => pending);
      const saved = vi.fn(),
        replaced = vi.fn();
      const props = {
        schema: { properties: { label: { type: "string" } } },
        resolvedConfig: { label: { value: "before", source: "database" as const } },
      };
      const { client, rerender, unmount } = mount(
        <ConfigSchemaForm integrationId="demo" {...props} onSaved={saved} />,
      );
      const invalidation = vi.spyOn(client, "invalidateQueries");
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "old" } });
      await userEvent.click(screen.getByRole("button", { name: /^Save/ }));
      await waitFor(() => expect(calls).toHaveLength(1));
      if (replacement === "unmount") unmount();
      else {
        if (replacement === "origin") apiUrl = "http://replacement.test";
        rerender(
          <QueryClientProvider client={client}>
            <AdminToastProvider>
              <ConfigSchemaForm
                integrationId={replacement === "identity" ? "other" : "demo"}
                {...props}
                onSaved={replaced}
              />
            </AdminToastProvider>
          </QueryClientProvider>,
        );
        fireEvent.change(screen.getByRole("textbox"), { target: { value: "replacement" } });
      }
      await act(async () => {
        finish(
          Response.json({
            ok: true,
            updated: ["label"],
            message: "Saved",
            reloaded: 1,
            enabled: 1,
          }),
        );
        await pending;
      });
      await waitFor(() => expect(invalidation).toHaveBeenCalled());
      expect(saved).not.toHaveBeenCalled();
      expect(replaced).not.toHaveBeenCalled();
      expect(screen.queryByText("Configuration saved.")).not.toBeInTheDocument();
      if (replacement !== "unmount") expect(screen.getByRole("textbox")).toHaveValue("replacement");
      expect(
        invalidation.mock.calls.every(
          ([options]) => !JSON.stringify(options).includes("replacement.test"),
        ),
      ).toBe(true);
      expect(calls).toHaveLength(1);
    },
  );

  it.each(["desired", "generation"])(
    "does not label an older successful receipt as current (%s)",
    async (mode) => {
      transport(() =>
        Response.json({
          bindings: [{ capability: "search /places", serviceId: "local" }],
          revision: "b".repeat(64),
          desiredRevision: (mode === "desired" ? "b" : "a").repeat(64),
          runtime: {
            generationId:
              mode === "generation"
                ? "22222222-2222-4222-8222-222222222222"
                : "11111111-1111-4111-8111-111111111111",
            bindings: { "search /places": "old-provider" },
            configRevision: "a".repeat(64),
          },
          lastApplication: {
            operationId: "old-binding-operation",
            integrationId: "demo",
            desiredRevision: "a".repeat(64),
            database: "retained",
            runtime: "applied",
            runtimeGenerationId: "11111111-1111-4111-8111-111111111111",
          },
        }),
      );
      mount(
        <RequiredServicesPanel
          integrationId="demo"
          requires={[{ capability: "search /places" }]}
        />,
      );
      expect(await screen.findByText(/Active: old-provider/)).toBeInTheDocument();
      expect(screen.queryByText("Binding saved and active.")).not.toBeInTheDocument();
    },
  );
  it("shows saved and live bindings independently when activation fails", async () => {
    transport((_url, init) => {
      if (init.method && init.method !== "GET") {
        expect(JSON.parse(String(init.body))).toEqual({
          serviceId: "local",
          expectedServiceId: null,
          expectedRevision: "a".repeat(64),
        });
        return Response.json({
          operationId: "opk1_syntheticbindingoperation",
          integrationId: "demo",
          desiredRevision: "a".repeat(64),
          database: "retained",
          runtime: "failed",
          runtimeGenerationId: "11111111-1111-4111-8111-111111111111",
          reason: "reload_failed",
        });
      }
      return Response.json({
        bindings: [],
        revision: "a".repeat(64),
        desiredRevision: "a".repeat(64),
        runtime: {
          generationId: "11111111-1111-4111-8111-111111111111",
          bindings: { "search /places": "old-provider" },
          configRevision: "a".repeat(64),
        },
        lastApplication: null,
      });
    });
    mount(
      <RequiredServicesPanel integrationId="demo" requires={[{ capability: "search /places" }]} />,
    );
    expect(await screen.findByText(/Active: old-provider/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("combobox"));
    await userEvent.click(await screen.findByRole("option", { name: "Local (local)" }));
    expect(await screen.findByText(/Binding saved.*Reload failed/)).toBeInTheDocument();
    expect(screen.getByText(/Active: old-provider/)).toBeInTheDocument();
  });

  it.each(["POST", "DELETE"])(
    "rejects binding %s without success invalidation or retry",
    async (method) => {
      const calls = transport((url, init) => {
        if (init.method === "GET" || !init.method) {
          expect(url.pathname).toBe("/api/admin/integrations/demo/bindings");
          return Response.json({
            revision: "a".repeat(64),
            desiredRevision: "a".repeat(64),
            runtime: null,
            lastApplication: null,
            bindings:
              method === "DELETE" ? [{ capability: "search /places", serviceId: "local" }] : [],
          });
        }
        expect(url.pathname).toBe("/api/admin/integrations/demo/bindings/search%20%2Fplaces");
        expect(init.method).toBe(method);
        return Response.json({ error: "Binding denied" }, { status: 403 });
      });
      const { client } = mount(
        <RequiredServicesPanel
          integrationId="demo"
          requires={[{ capability: "search /places" }]}
        />,
      );
      const invalidate = vi.spyOn(client, "invalidateQueries");
      await waitFor(() => expect(calls.length).toBe(1));
      await userEvent.click(screen.getByRole("combobox"));
      await userEvent.click(
        await screen.findByRole("option", { name: method === "DELETE" ? /none/ : "Local (local)" }),
      );
      expect(await screen.findByText(/Binding denied/)).toBeInTheDocument();
      expect(calls.filter(({ init }) => init.method === method)).toHaveLength(1);
      expect(invalidate).not.toHaveBeenCalled();
    },
  );

  it("shows config-file effective source separately from vault audit and retains full manifest", async () => {
    transport((url) => {
      expect(url.pathname).toBe("/api/admin/integrations/demo");
      return Response.json(detail);
    });
    mount(<IntegrationDetail id="demo" />);
    await userEvent.click(await screen.findByRole("tab", { name: /Credentials/ }));
    expect(await screen.findByText("config.json")).toBeInTheDocument();
    expect(screen.queryByText("missing")).not.toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /Vault/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete from vault" })).toBeInTheDocument();
  });

  it("keeps an env-sourced bulk credential locked despite a retained vault entry", async () => {
    const requests = transport((url, init) => {
      switch (url.pathname) {
        case "/api/admin/integrations":
          return Response.json([summary]);
        case "/api/admin/integrations/env-vars":
          return Response.json({
            integrations: [
              {
                id: "demo",
                name: "Demo",
                enabled: true,
                envVars: [
                  { key: "token", name: "DEMO_TOKEN", title: "Token", secret: true, present: true },
                ],
              },
            ],
          });
        case "/api/admin/integrations/demo":
          return Response.json({
            ...detail,
            credentialStatus: [{ ...detail.credentialStatus[0], source: "env" }],
          });
        case "/api/admin/credentials/demo/token":
          expect(init.method).toBe("DELETE");
          return Response.json({ ok: true, message: "Reloaded", reloaded: 1, enabled: 1 });
        default:
          throw new Error(`Unexpected request ${url}`);
      }
    });
    mount(<BulkConfigure />);
    await userEvent.click(await screen.findByRole("button", { name: /Demo demo/ }));
    expect(await screen.findByText("env")).toBeInTheDocument();
    expect(screen.getByText(/Vault updated/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete from vault" })).toBeDisabled();
    expect(requests.filter(({ init }) => init.method === "DELETE")).toHaveLength(0);
  });

  it("uses complete overview and credential summaries and refreshes after a health sweep", async () => {
    const requests = transport((url, init) => {
      switch (url.pathname) {
        case "/api/admin/overview":
          return Response.json({
            systemHealth: { status: "pass", unhealthyCount: 0 },
            users: { total: 1, active24h: 1, banned: 0 },
            integrations: { total: 1, enabled: 1, unhealthy: 0, unconfigured: 1 },
            services: null,
            attention: [],
            recentActivity: [],
            activeJobs: [],
          });
        case "/api/admin/credentials":
          return Response.json({
            secretsConfigured: true,
            credentials: [
              {
                integrationId: "demo",
                name: "Demo",
                enabled: true,
                secretFields: 1,
                vaultStored: 1,
                missingCredentials: 0,
              },
            ],
          });
        case "/api/admin/integrations/health/run":
          expect(init.method).toBe("POST");
          return Response.json({ timestamp: "2026-10-20T10:00:00.000Z", count: 1, results: [] });
        default:
          throw new Error(`Unexpected request ${url}`);
      }
    });
    mount(<AdminOverview />);
    await userEvent.click(await screen.findByRole("button", { name: "Health checks" }));
    expect(await screen.findByText("Health checks complete")).toBeInTheDocument();
    await waitFor(() =>
      expect(
        requests.filter(({ url }) => url.pathname === "/api/admin/overview").length,
      ).toBeGreaterThan(1),
    );
    expect(
      requests.filter(({ url }) => url.pathname === "/api/admin/integrations/health/run"),
    ).toHaveLength(1);
  });

  it("displays structured resolved configuration as full JSON", async () => {
    transport(() =>
      Response.json({
        ...detail,
        resolvedConfig: {
          nested: { source: "config.json", value: { fields: [1, false, { keep: "raw" }] } },
        },
      }),
    );
    mount(<IntegrationDetail id="demo" />);
    await userEvent.click(await screen.findByRole("tab", { name: "Configuration" }));
    expect(await screen.findByText('{"fields":[1,false,{"keep":"raw"}]}')).toBeInTheDocument();
  });

  it("does not retry an explicit health check under retrying query defaults", async () => {
    const requests = transport((url) => {
      if (url.pathname === "/api/admin/integrations/demo")
        return Response.json({ ...detail, hasHealthCheck: true });
      if (url.pathname === "/api/admin/integrations/demo/health/history")
        return Response.json({ integrationId: "demo", hours: 24, timeline: [] });
      expect(url.pathname).toBe("/api/admin/integrations/demo/health");
      return Response.json({ error: "Health failure" }, { status: 500 });
    });
    mount(<IntegrationDetail id="demo" />, true);
    await userEvent.click(await screen.findByRole("tab", { name: "Health" }));
    await userEvent.click(await screen.findByRole("button", { name: "Run Check" }));
    expect(await screen.findByText("Health check failed")).toBeInTheDocument();
    expect(
      requests.filter(({ url }) => url.pathname === "/api/admin/integrations/demo/health"),
    ).toHaveLength(1);
  });

  it("aborts an embedded health read when its tab unmounts without canceling host work", async () => {
    let healthSignal: AbortSignal | null | undefined;
    let canceled = false;
    const requests = transport((url, init) => {
      if (url.pathname === "/api/admin/integrations/demo")
        return Response.json({ ...detail, hasHealthCheck: true });
      if (url.pathname === "/api/admin/integrations/demo/health/history")
        return Response.json({ integrationId: "demo", hours: 24, timeline: [] });
      expect(url.pathname).toBe("/api/admin/integrations/demo/health");
      healthSignal = init.signal;
      return new Response(
        new ReadableStream({
          cancel: () => {
            canceled = true;
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    });
    mount(<IntegrationDetail id="demo" />);
    await userEvent.click(await screen.findByRole("tab", { name: "Health" }));
    await userEvent.click(await screen.findByRole("button", { name: "Run Check" }));
    await waitFor(() => expect(healthSignal).toBeInstanceOf(AbortSignal));
    await userEvent.click(screen.getByRole("tab", { name: "Overview" }));
    await waitFor(() => expect(healthSignal?.aborted).toBe(true));
    expect(canceled).toBe(true);
    expect(requests.some(({ url }) => url.pathname.includes("cancel"))).toBe(false);
  });

  it.each(["tab exit", "origin replacement", "integration replacement"])(
    "does not complete an interrupted repeat health check after %s",
    async (interruption) => {
      let healthReads = 0;
      let healthSignal: AbortSignal | null | undefined;
      let bodyCanceled = false;
      const requests = transport((url, init) => {
        const id = url.pathname.split("/")[4];
        expect(["demo", "other"]).toContain(id);
        expect(init.method ?? "GET").toBe("GET");
        if (url.pathname.endsWith("/health/history"))
          return Response.json({ integrationId: id, hours: 24, timeline: [] });
        if (!url.pathname.endsWith("/health")) {
          expect(url.pathname).toBe(`/api/admin/integrations/${id}`);
          return Response.json({ ...detail, id, hasHealthCheck: true });
        }
        healthReads++;
        if (healthReads !== 2)
          return Response.json([
            { id, name: "Demo", category: "geocoding", url: "https://provider.test", status: "up" },
          ]);
        healthSignal = init.signal;
        return new Response(
          new ReadableStream({
            cancel: () => {
              bodyCanceled = true;
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      });
      const mounted = mount(<IntegrationDetail id="demo" />);
      const invalidate = vi.spyOn(mounted.client, "invalidateQueries");
      await userEvent.click(await screen.findByRole("tab", { name: "Health" }));
      await userEvent.click(screen.getByRole("button", { name: "Run Check" }));
      expect(await screen.findByText("Health check completed")).toBeInTheDocument();
      expect(invalidate).toHaveBeenCalled();
      await userEvent.click(screen.getByRole("button", { name: "Close" }));
      await waitFor(() =>
        expect(screen.queryByText("Health check completed")).not.toBeInTheDocument(),
      );
      invalidate.mockClear();

      await userEvent.click(screen.getByRole("button", { name: "Run Check" }));
      await waitFor(() => expect(healthSignal).toBeInstanceOf(AbortSignal));
      if (interruption === "tab exit") {
        await userEvent.click(screen.getByRole("tab", { name: "Overview" }));
      } else {
        if (interruption === "origin replacement") apiUrl = "http://replacement.test";
        const id = interruption === "integration replacement" ? "other" : "demo";
        // Retained detail data keeps HealthTab mounted while its owner changes.
        mounted.client.setQueryData(["admin", "integrations", apiUrl, "detail", id], {
          ...detail,
          id,
          hasHealthCheck: true,
        });
        mounted.rerender(
          <QueryClientProvider client={mounted.client}>
            <AdminToastProvider>
              <IntegrationDetail id={id} />
            </AdminToastProvider>
          </QueryClientProvider>,
        );
      }
      await waitFor(() => expect(healthSignal?.aborted).toBe(true));
      await waitFor(() => expect(mounted.client.isMutating()).toBe(0));
      expect(bodyCanceled).toBe(true);
      expect(invalidate).not.toHaveBeenCalled();
      expect(screen.queryByText(/Health check (completed|failed)/)).not.toBeInTheDocument();
      expect(healthReads).toBe(2);
      expect(requests.some(({ url }) => url.pathname.includes("cancel"))).toBe(false);

      if (interruption === "tab exit")
        await userEvent.click(screen.getByRole("tab", { name: "Health" }));
      await userEvent.click(await screen.findByRole("button", { name: "Run Check" }));
      expect(await screen.findByText("Health check completed")).toBeInTheDocument();
      expect(healthReads).toBe(3);
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: ["admin", "integrations", apiUrl],
      });
    },
  );

  it("preserves validation errors and never calls the saved callback for a failed config write", async () => {
    const calls = transport((url, init) => {
      expect(url.pathname).toBe("/api/admin/integrations/demo/config");
      expect(init.method).toBe("PATCH");
      return Response.json(
        { errors: ["Endpoint must use HTTPS", "Unknown config field"] },
        { status: 400 },
      );
    });
    const saved = vi.fn();
    mount(
      <ConfigSchemaForm
        integrationId="demo"
        schema={{ type: "object", properties: { endpoint: { type: "string", title: "Endpoint" } } }}
        resolvedConfig={{ endpoint: { value: "old", source: "default" } }}
        onSaved={saved}
      />,
    );
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "new" } });
    await userEvent.click(screen.getByRole("button", { name: /Save/ }));
    expect(
      await screen.findByText(/Endpoint must use HTTPS.*Unknown config field/),
    ).toBeInTheDocument();
    expect(saved).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });

  it("keeps a failed activation visibly saved and never reports provider success", async () => {
    transport(() =>
      Response.json({ ...credentialReceipt, runtime: "failed", reason: "reload_failed" }),
    );
    const close = vi.fn();
    mount(
      <SetCredentialDialog
        open
        expectedRevision={"a".repeat(64)}
        onClose={close}
        integrationId="demo"
        credentialKey="token"
        title="Token"
      />,
    );
    fireEvent.change(screen.getByLabelText("Token"), {
      target: { value: "synthetic-new-private" },
    });
    await userEvent.click(screen.getByRole("button", { name: "Save Credential" }));
    expect(await screen.findByText(/Credential saved. Provider reload failed/)).toBeInTheDocument();
    expect(close).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Token")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Save Credential" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(close).toHaveBeenCalledOnce();
  });
  it("retains the original revision and idempotency key for an unchanged rejected credential draft", async () => {
    const calls = transport(() =>
        Response.json(
          { error: "Configuration changed. Refresh before applying." },
          { status: 409 },
        ),
      ),
      close = vi.fn();
    const props = {
      open: true,
      expectedRevision: "a".repeat(64),
      onClose: close,
      integrationId: "demo",
      credentialKey: "token",
      title: "Token",
    };
    const { client, rerender } = mount(<SetCredentialDialog {...props} />);
    fireEvent.change(screen.getByLabelText("Token"), { target: { value: "synthetic-private" } });
    await userEvent.click(screen.getByRole("button", { name: "Save Credential" }));
    await screen.findByText(/Configuration changed/);
    rerender(
      <QueryClientProvider client={client}>
        <AdminToastProvider>
          <SetCredentialDialog {...props} expectedRevision={"b".repeat(64)} />
        </AdminToastProvider>
      </QueryClientProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Save Credential" }));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(JSON.parse(calls[0]!.init.body as string).expectedRevision).toBe("a".repeat(64));
    expect(calls[1]!.init.body).toBe(calls[0]!.init.body);
    expect(new Headers(calls[1]!.init.headers).get("Idempotency-Key")).toBe(
      new Headers(calls[0]!.init.headers).get("Idempotency-Key"),
    );
    expect(close).not.toHaveBeenCalled();
  });
  it("shows the declared vault hint without closing or retrying a failed credential write", async () => {
    const calls = transport((url) => {
      expect(url.pathname).toBe("/api/admin/credentials/demo/token%20%2Fkey");
      return Response.json(
        { error: "Vault unavailable", hint: "Configure the credential vault first" },
        { status: 503 },
      );
    });
    const close = vi.fn();
    mount(
      <SetCredentialDialog
        open
        onClose={close}
        integrationId="demo"
        credentialKey="token /key"
        expectedRevision={"a".repeat(64)}
        title="Token"
      />,
    );
    fireEvent.change(screen.getByLabelText("Token"), { target: { value: "synthetic-test-value" } });
    await userEvent.click(screen.getByRole("button", { name: "Save Credential" }));
    expect(
      await screen.findByText(/Vault unavailable.*Configure the credential vault first/),
    ).toBeInTheDocument();
    expect(close).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });

  it.each(["success", "failed", "canceled"] as const)(
    "refreshes all domain caches only after actual reload %s",
    async (status) => {
      let finish = false;
      const calls = transport((url, init) => {
        if (url.pathname === "/api/admin/integrations" && (!init.method || init.method === "GET"))
          return Response.json([summary]);
        if (url.pathname === "/api/admin/integrations/reload")
          return Response.json({ ok: true, jobId: "job-1" });
        if (url.pathname === "/api/admin/jobs/job-1") {
          expect(url.searchParams.get("source")).toBe("application");
          return Response.json(job({ status: finish ? status : "running", cancelable: !finish }));
        }
        throw new Error(`Unexpected request ${url}`);
      });
      const { client } = mount(<IntegrationList />);
      await screen.findByText("Demo");
      const keys = [
        ["admin", "integrations", apiUrl, "detail", "demo"],
        ["admin", "credentials", apiUrl],
        ["admin", "overview", apiUrl],
        ["integrations", apiUrl],
        ["admin", "integrations", "http://other.test", "detail", "demo"],
      ];
      for (const key of keys) client.setQueryData(key, { cached: true });
      await userEvent.click(screen.getByRole("button", { name: /Reload/ }));
      await screen.findByText(/queued/i);
      await waitFor(() =>
        expect(calls.some(({ url }) => url.pathname === "/api/admin/jobs/job-1")).toBe(true),
      );
      for (const key of keys) expect(client.getQueryState(key)?.isInvalidated).toBe(false);
      finish = true;
      await act(async () => {
        await client.refetchQueries({ queryKey: ["admin", "jobs"] });
      });
      await waitFor(() => {
        for (const key of keys.slice(0, 4))
          expect(client.getQueryState(key)?.isInvalidated).toBe(true);
      });
      expect(client.getQueryState(keys[4])?.isInvalidated).toBe(false);
      expect(calls.filter(({ url }) => url.pathname.endsWith("/reload"))).toHaveLength(1);
    },
  );
});
