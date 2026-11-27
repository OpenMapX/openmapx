import type { AdminIntegrationDetail } from "@openmapx/core/api-contracts";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, createTestQueryClient, render, screen, within } from "@/test";
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
  vi.stubGlobal("fetch", async (input: string) => {
    const url = new URL(input);
    if (url.pathname === `/api/admin/integrations/${body.id}`) return Response.json(body);
    return Response.json({ error: "Not found" }, { status: 404 });
  });
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
  serve({
    ...detail,
    id: "transit-acme",
    name: "Acme transit",
    enabled: true,
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
