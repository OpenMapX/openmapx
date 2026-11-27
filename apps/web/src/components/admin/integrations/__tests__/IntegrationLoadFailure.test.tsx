import type { AdminIntegrationDetail } from "@openmapx/core/api-contracts";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, createTestQueryClient, render, screen, userEvent, waitFor, within } from "@/test";
import { AdminToastProvider } from "../../shared/AdminToast";
import { IntegrationDetail } from "../IntegrationDetail";
import { detail } from "./fixtures";

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

  // The operator never switched it off, so enabling would change nothing.
  expect(screen.queryByRole("button", { name: "Enable" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
  await userEvent.setup().click(screen.getByRole("button", { name: "Disable" }));
  await waitFor(() => expect(posted).toEqual(["/api/admin/integrations/transit-acme/disable"]));
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
