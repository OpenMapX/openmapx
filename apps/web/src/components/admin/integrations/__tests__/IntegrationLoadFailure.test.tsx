import type { AdminIntegrationDetail } from "@openmapx/core/api-contracts";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, createTestQueryClient, render, screen, userEvent, waitFor, within } from "@/test";
import { AdminToastProvider } from "../../shared/AdminToast";
import { BulkConfigure } from "../BulkConfigure";
import { IntegrationDetail } from "../IntegrationDetail";
import { detail, summary } from "./fixtures";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntlWithCatalog());

const apiUrl = "http://admin.test";
vi.mock("@/integration-api/runtime/EnvProvider", () => ({ useEnv: () => ({ apiUrl }) }));
vi.mock(
  "next/navigation",
  async () => (await import("@/test/adminNavigation")).adminNavigationMock,
);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function serve(body: AdminIntegrationDetail) {
  const posted: string[] = [];
  vi.stubGlobal("fetch", async (input: string | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    const method = (typeof input === "string" ? init?.method : input.method) ?? "GET";
    if (method === "POST") {
      posted.push(url.pathname);
      return Response.json({ message: "Integrations reloaded", reloaded: 1, enabled: 0 });
    }
    if (url.pathname === `/api/admin/integrations/${body.id}`) return Response.json(body);
    return Response.json({ error: "Not found" }, { status: 404 });
  });
  return posted;
}

function mount(id: string) {
  const client = createTestQueryClient();
  client.setDefaultOptions({ queries: { retry: false } });
  render(
    <QueryClientProvider client={client}>
      <AdminToastProvider>
        <IntegrationDetail id={id} />
      </AdminToastProvider>
    </QueryClientProvider>,
  );
}

it("shows an integration whose code failed to load as failed, with the phase and the error", async () => {
  const posted = serve({
    ...detail,
    id: "transit-acme",
    name: "Acme transit",
    // The host switches an integration whose load failed off at run time.
    enabled: false,
    // A health result from before the failure must not read as healthy.
    health: { status: "up", responseTime: 20 },
    hasHealthCheck: true,
    status: "failed",
    loadState: "failed",
    loadError: "SyntaxError: Unexpected token 'export'",
    loadErrorPhase: "import",
  });
  mount("transit-acme");

  const heading = await screen.findByRole("heading", { level: 1, name: "Acme transit" });
  const header = heading.parentElement as HTMLElement;
  expect(within(header).getByRole("img", { name: "Failed to load" })).toBeInTheDocument();
  expect(screen.queryByRole("img", { name: "Healthy" })).not.toBeInTheDocument();

  const notice = screen.getByRole("alert");
  expect(notice).toHaveTextContent("This integration is not running: its code failed to load.");
  expect(notice).toHaveTextContent("Its code could not be imported.");
  expect(notice).toHaveTextContent("SyntaxError: Unexpected token 'export'");
  expect(notice).toHaveTextContent(
    "Fix or update the integration, then select Reload to load it again, or disable it.",
  );

  const user = userEvent.setup();
  // The last health result was "up", but the code is not running.
  await user.click(screen.getByRole("tab", { name: "Health" }));
  const healthPanel = screen.getByRole("tabpanel");
  expect(within(healthPanel).getByRole("img", { name: "Failed to load" })).toBeInTheDocument();
  expect(within(healthPanel).queryByRole("img", { name: "Healthy" })).not.toBeInTheDocument();

  // The operator never switched it off, so enabling would change nothing.
  expect(screen.queryByRole("button", { name: "Enable" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Disable" }));
  await waitFor(() => expect(posted).toEqual(["/api/admin/integrations/transit-acme/disable"]));
});

it("labels a failed integration as failed, not disabled, on the bulk configuration page", async () => {
  vi.stubGlobal("fetch", async (input: string | Request) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.pathname === "/api/admin/integrations")
      return Response.json([
        {
          ...summary,
          id: "transit-acme",
          name: "Acme transit",
          enabled: false,
          status: "failed",
          loadState: "failed",
          loadError: "upstream token missing",
          loadErrorPhase: "setup",
        },
        { ...summary, id: "weather-off", name: "Weather off", enabled: false, status: "disabled" },
      ]);
    if (url.pathname === "/api/admin/integrations/env-vars")
      return Response.json({ integrations: [] });
    return Response.json({ error: "Not found" }, { status: 404 });
  });
  const client = createTestQueryClient();
  client.setDefaultOptions({ queries: { retry: false } });
  render(
    <QueryClientProvider client={client}>
      <AdminToastProvider>
        <BulkConfigure />
      </AdminToastProvider>
    </QueryClientProvider>,
  );

  const failed = await screen.findByRole("button", { name: /Acme transit/ });
  expect(within(failed).getByText("Failed to load")).toBeInTheDocument();
  expect(within(failed).queryByText("disabled")).not.toBeInTheDocument();
  const off = screen.getByRole("button", { name: /Weather off/ });
  expect(within(off).getByText("disabled")).toBeInTheDocument();
  expect(within(off).queryByText("Failed to load")).not.toBeInTheDocument();
});

const installed = {
  ...detail,
  id: "acme-places",
  name: "Acme Places",
  isBuiltIn: false,
  quality: "community" as const,
  enabled: false,
  health: { status: "up" as const, responseTime: 20 },
  hasHealthCheck: true,
};

it("explains that safe mode holds an installed integration back", async () => {
  serve({ ...installed, status: "safe-mode", loadState: "safe-mode" });
  mount("acme-places");

  const heading = await screen.findByRole("heading", { level: 1, name: "Acme Places" });
  const header = heading.parentElement as HTMLElement;
  expect(within(header).getByRole("img", { name: "Not loaded: safe mode" })).toBeInTheDocument();
  const notice = screen.getByRole("status");
  expect(notice).toHaveTextContent("Not loaded: the API runs in safe mode.");
  expect(within(notice).getByRole("link", { name: "Open the integration list" })).toHaveAttribute(
    "href",
    "/admin/integrations",
  );
  expect(screen.queryByText(/its code failed to load/)).not.toBeInTheDocument();
  // The operator's switch is on; reloading cannot load it while safe mode holds.
  expect(screen.getByRole("button", { name: "Disable" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Reload" })).not.toBeInTheDocument();

  const user = userEvent.setup();
  await user.click(screen.getByRole("tab", { name: "Health" }));
  const healthPanel = screen.getByRole("tabpanel");
  expect(
    within(healthPanel).getByRole("img", { name: "Not loaded: safe mode" }),
  ).toBeInTheDocument();
  expect(within(healthPanel).queryByRole("img", { name: "Healthy" })).not.toBeInTheDocument();
});

it("names the version an incompatible extension needs", async () => {
  serve({
    ...installed,
    status: "incompatible",
    loadState: "incompatible",
    loadError: "requires platform 2.0, this is 1.0",
    loadErrorPhase: "import",
  });
  mount("acme-places");

  await screen.findByRole("heading", { level: 1, name: "Acme Places" });
  const notice = screen.getByRole("status");
  expect(notice).toHaveTextContent("This release of OpenMapX cannot run this extension.");
  expect(notice).toHaveTextContent("requires platform 2.0, this is 1.0");
  expect(notice).toHaveTextContent(
    "Update OpenMapX, or install a version of the extension made for this release.",
  );
  expect(screen.queryByText("Its code could not be imported.")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Disable" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Reload" })).not.toBeInTheDocument();
});

it("says the extension is disabled and offers no switch that would not load it", async () => {
  serve({ ...installed, status: "disabled", loadState: "disabled" });
  mount("acme-places");

  await screen.findByRole("heading", { level: 1, name: "Acme Places" });
  const notice = screen.getByRole("status");
  expect(notice).toHaveTextContent("Not loaded: its extension is disabled.");
  expect(screen.queryByRole("button", { name: "Enable" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Disable" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Reload" })).not.toBeInTheDocument();
});

it("labels held-back integrations by their reason on the bulk configuration page", async () => {
  vi.stubGlobal("fetch", async (input: string | Request) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.pathname === "/api/admin/integrations")
      return Response.json([
        {
          ...summary,
          id: "held",
          name: "Held",
          enabled: false,
          status: "safe-mode",
          loadState: "safe-mode",
        },
        {
          ...summary,
          id: "old",
          name: "Old",
          enabled: false,
          status: "incompatible",
          loadState: "incompatible",
          loadError: "requires platform 2.0, this is 1.0",
          loadErrorPhase: "import",
        },
        {
          ...summary,
          id: "off",
          name: "Off",
          enabled: false,
          status: "disabled",
          loadState: "disabled",
        },
      ]);
    if (url.pathname === "/api/admin/integrations/env-vars")
      return Response.json({ integrations: [] });
    return Response.json({ error: "Not found" }, { status: 404 });
  });
  const client = createTestQueryClient();
  client.setDefaultOptions({ queries: { retry: false } });
  render(
    <QueryClientProvider client={client}>
      <AdminToastProvider>
        <BulkConfigure />
      </AdminToastProvider>
    </QueryClientProvider>,
  );

  const held = await screen.findByRole("button", { name: /Held/ });
  expect(within(held).getByText("Safe mode")).toBeInTheDocument();
  expect(within(held).queryByText("disabled")).not.toBeInTheDocument();
  const old = screen.getByRole("button", { name: /Old/ });
  expect(within(old).getByText("Not compatible")).toBeInTheDocument();
  expect(within(old).queryByText("Failed to load")).not.toBeInTheDocument();
  const off = screen.getByRole("button", { name: /Off/ });
  expect(within(off).getByText("Extension disabled")).toBeInTheDocument();
  expect(within(off).queryByText("disabled")).not.toBeInTheDocument();
});

it("shows no failure notice for an integration that loaded", async () => {
  serve({
    ...detail,
    status: "healthy",
    loadState: "loaded",
    loadError: null,
    loadErrorPhase: null,
  });
  mount(detail.id);
  await screen.findByRole("heading", { level: 1, name: detail.name });
  expect(screen.getByRole("img", { name: "Healthy" })).toBeInTheDocument();
  expect(screen.queryByText(/its code failed to load/)).not.toBeInTheDocument();
});
