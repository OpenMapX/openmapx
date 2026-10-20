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
  it.each(["POST", "DELETE"])(
    "rejects binding %s without success invalidation or retry",
    async (method) => {
      const calls = transport((url, init) => {
        if (init.method === "GET" || !init.method) {
          expect(url.pathname).toBe("/api/admin/integrations/demo/bindings");
          return Response.json({
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

  it("keeps the bulk credential's env source and independently deletes its stored vault entry", async () => {
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
    await userEvent.click(screen.getByRole("button", { name: "Delete from vault" }));
    expect(await screen.findByText("Credential deleted")).toBeInTheDocument();
    expect(requests.filter(({ init }) => init.method === "DELETE")).toHaveLength(1);
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
