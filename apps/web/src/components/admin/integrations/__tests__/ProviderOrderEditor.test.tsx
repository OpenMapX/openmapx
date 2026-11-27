import type {
  AdminIntegrationDetail,
  AdminProviderOrder,
  ConfigurationOwnership,
} from "@openmapx/core/api-contracts";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, createTestQueryClient, render, screen, userEvent, waitFor } from "@/test";
import { AdminToastProvider } from "../../shared/AdminToast";
import { IntegrationDetail } from "../IntegrationDetail";
import { ProviderOrderEditor } from "../ProviderOrderEditor";
import { detail } from "./fixtures";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntlWithCatalog());

const apiUrl = "http://admin.test";
vi.mock("@/integration-api/runtime/EnvProvider", () => ({ useEnv: () => ({ apiUrl }) }));
vi.mock(
  "next/navigation",
  async () => (await import("@/test/adminNavigation")).adminNavigationMock,
);

type Domain = AdminProviderOrder["domains"][number];
const entry = (integrationId: string, name: string, listed = true) => ({
  integrationId,
  name,
  isBuiltIn: true,
  listed,
});
const weather: Domain = {
  domain: "weather",
  orchestratorId: "weather",
  unlisted: "append",
  stored: [],
  effective: [entry("a", "Alpha", false), entry("b", "Beta", false), entry("c", "Gamma", false)],
};
const geocoding: Domain = {
  domain: "geocoding",
  orchestratorId: "geocoding",
  unlisted: "exclude",
  stored: ["geocoding-maptiler"],
  effective: [entry("geocoding-maptiler", "MapTiler"), entry("geocoding-acme", "Acme", false)],
};
const routing: Domain = {
  domain: "routing",
  orchestratorId: "routing",
  unlisted: "append",
  stored: ["routing-gone", "routing-a"],
  effective: [entry("routing-a", "Router A"), entry("routing-b", "Router B", false)],
};

function orchestrator(
  id: string,
  stored: string[],
  source: "default" | "database" | "env" = "default",
  ownership?: ConfigurationOwnership,
  configSchema?: AdminIntegrationDetail["manifest"]["configSchema"],
): AdminIntegrationDetail {
  const result: AdminIntegrationDetail = {
    ...detail,
    id,
    name: id,
    domains: ["data-source"],
    manifest: { id, name: id, version: "1.0.0", domains: ["data-source"] },
    resolvedConfig: { providerOrder: { value: stored, source } },
    ...(ownership && { ownership: { providerOrder: ownership } }),
    credentialStatus: [],
  };
  if (configSchema) result.manifest.configSchema = configSchema;
  return result;
}

interface Server {
  domains: Domain[];
  details: Record<string, AdminIntegrationDetail>;
  orderStatus?: number;
}
function serve(server: Server) {
  const patches: { path: string; body: unknown }[] = [];
  vi.stubGlobal("fetch", async (input: string, init: RequestInit) => {
    const url = new URL(input);
    if (url.origin !== apiUrl) throw new Error(`Unexpected network origin: ${url.origin}`);
    if (init.method === "PATCH") {
      patches.push({ path: url.pathname, body: JSON.parse(String(init.body)) });
      return Response.json({ ok: true, message: "ok", reloaded: 1, enabled: 1, updated: [] });
    }
    if (url.pathname === "/api/admin/provider-order")
      return server.orderStatus
        ? Response.json({ error: "Unavailable" }, { status: server.orderStatus })
        : Response.json({ domains: server.domains });
    const id = url.pathname.split("/").at(-1) ?? "";
    const found = server.details[id];
    return found ? Response.json(found) : Response.json({ error: "Not found" }, { status: 404 });
  });
  return patches;
}

function mount(orchestratorId: string, domain: string) {
  const client = createTestQueryClient();
  client.setDefaultOptions({ queries: { retry: false }, mutations: { retry: false } });
  return render(
    <QueryClientProvider client={client}>
      <AdminToastProvider>
        <ProviderOrderEditor orchestratorId={orchestratorId} domain={domain} />
      </AdminToastProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("provider order editor", () => {
  it("saves the reordered list", async () => {
    const patches = serve({
      domains: [weather],
      details: { weather: orchestrator("weather", []) },
    });
    mount("weather", "weather");
    await userEvent.click(await screen.findByRole("button", { name: "Move Beta up" }));
    await waitFor(() =>
      expect(patches).toEqual([
        {
          path: "/api/admin/integrations/weather/config",
          body: { providerOrder: ["b", "a", "c"] },
        },
      ]),
    );
    expect(screen.getByRole("button", { name: "Move Alpha up" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Move Gamma down" })).toBeDisabled();
  });

  it("offers an unlisted geocoder instead of saving it", async () => {
    const patches = serve({
      domains: [geocoding],
      details: { geocoding: orchestrator("geocoding", ["geocoding-maptiler"], "database") },
    });
    mount("geocoding", "geocoding");
    expect(await screen.findByRole("heading", { name: "Available" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Move Acme up" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Add Acme" }));
    await waitFor(() =>
      expect(patches.at(-1)).toEqual({
        path: "/api/admin/integrations/geocoding/config",
        body: { providerOrder: ["geocoding-maptiler", "geocoding-acme"] },
      }),
    );
  });

  it("removes a selected geocoder from the selection", async () => {
    const patches = serve({
      domains: [geocoding],
      details: { geocoding: orchestrator("geocoding", ["geocoding-maptiler"], "database") },
    });
    mount("geocoding", "geocoding");
    await userEvent.click(await screen.findByRole("button", { name: "Remove MapTiler" }));
    await waitFor(() =>
      expect(patches.at(-1)).toEqual({
        path: "/api/admin/integrations/geocoding/config",
        body: { providerOrder: [] },
      }),
    );
  });

  it("keeps a listed integration that is not loaded in place until it is removed", async () => {
    const patches = serve({
      domains: [routing],
      details: { routing: orchestrator("routing", routing.stored, "database") },
    });
    mount("routing", "routing");
    expect(await screen.findByText("routing-gone")).toBeInTheDocument();
    expect(screen.getByText("Not loaded")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Move Router B up" }));
    await waitFor(() =>
      expect(patches.at(-1)?.body).toEqual({
        providerOrder: ["routing-gone", "routing-b", "routing-a"],
      }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Remove routing-gone" }));
    await waitFor(() =>
      expect(patches.at(-1)?.body).toEqual({ providerOrder: ["routing-a", "routing-b"] }),
    );
    expect(screen.queryByRole("button", { name: "Remove Router A" })).not.toBeInTheDocument();
  });

  it("shows an environment override and offers no change it would ignore", async () => {
    const patches = serve({
      domains: [weather],
      details: {
        weather: orchestrator("weather", ["c"], "env", {
          source: "env",
          writable: false,
          secret: false,
          adoption: "host_action_required",
          reason: "host_environment",
          envVar: "INTEGRATION_WEATHER_PROVIDER_ORDER",
        }),
      },
    });
    mount("weather", "weather");
    expect(
      await screen.findByText("INTEGRATION_WEATHER_PROVIDER_ORDER", { selector: "code" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The host variable INTEGRATION_WEATHER_PROVIDER_ORDER sets this order, so a change here would have no effect.",
    );
    for (const button of screen.getAllByRole("button", { name: /^Move / }))
      expect(button).toBeDisabled();
    expect(patches).toEqual([]);
  });

  it("replaces the generic field on an orchestrator's configuration tab", async () => {
    serve({
      domains: [weather],
      details: {
        weather: orchestrator("weather", [], "default", undefined, {
          type: "object",
          properties: {
            providerOrder: { type: "array", items: { type: "string" }, title: "Order field" },
            timeout: { type: "number", title: "Timeout field" },
          },
        }),
      },
    });
    const client = createTestQueryClient();
    client.setDefaultOptions({ queries: { retry: false } });
    render(
      <QueryClientProvider client={client}>
        <AdminToastProvider>
          <IntegrationDetail id="weather" />
        </AdminToastProvider>
      </QueryClientProvider>,
    );
    await userEvent.click(await screen.findByRole("tab", { name: /Configuration/ }));
    expect(await screen.findByRole("heading", { name: "Provider order" })).toBeInTheDocument();
    expect(await screen.findByText("Timeout field")).toBeInTheDocument();
    expect(screen.queryByText("Order field")).not.toBeInTheDocument();
  });

  it("reports a provider order that could not be read", async () => {
    serve({ domains: [], details: { weather: orchestrator("weather", []) }, orderStatus: 500 });
    mount("weather", "weather");
    expect(await screen.findByText("Couldn’t load the provider order.")).toBeInTheDocument();
  });
});
