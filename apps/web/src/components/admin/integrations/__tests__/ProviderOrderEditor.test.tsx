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
  detailStatus?: number;
  /** Holds each save open until it resolves. */
  patchGate?: Promise<void>;
}

/** The order a saved list is served in: listed entries first, then the rest. */
function stored(domain: Domain, providerOrder: string[]): Domain {
  const byId = new Map(domain.effective.map((item) => [item.integrationId, item]));
  const listed = providerOrder.flatMap((id) => {
    const item = byId.get(id);
    return item ? [{ ...item, listed: true }] : [];
  });
  const rest = domain.effective
    .filter((item) => !providerOrder.includes(item.integrationId))
    .map((item) => ({ ...item, listed: false }));
  return { ...domain, stored: providerOrder, effective: [...listed, ...rest] };
}

function serve(server: Server) {
  const patches: { path: string; body: unknown }[] = [];
  vi.stubGlobal("fetch", async (input: string, init: RequestInit) => {
    const url = new URL(input);
    if (url.origin !== apiUrl) throw new Error(`Unexpected network origin: ${url.origin}`);
    if (init.method === "PATCH") {
      const body = JSON.parse(String(init.body)) as { providerOrder: string[] };
      patches.push({ path: url.pathname, body });
      await server.patchGate;
      const id = url.pathname.split("/").at(-2);
      server.domains = server.domains.map((domain) =>
        domain.orchestratorId === id ? stored(domain, body.providerOrder) : domain,
      );
      return Response.json({ ok: true, message: "ok", reloaded: 1, enabled: 1, updated: [] });
    }
    if (server.detailStatus && url.pathname.startsWith("/api/admin/integrations/"))
      return Response.json({ error: "Unavailable" }, { status: server.detailStatus });
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
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Move Beta up" })).toBeDisabled(),
    );
    expect(screen.getByRole("button", { name: "Move Gamma down" })).toBeDisabled();
  });

  it("keeps keyboard focus on the moved row and announces where it went", async () => {
    let release = () => {};
    const server: Server = {
      domains: [weather],
      details: { weather: orchestrator("weather", []) },
      patchGate: new Promise((resolve) => {
        release = resolve;
      }),
    };
    const patches = serve(server);
    mount("weather", "weather");
    const gammaUp = await screen.findByRole("button", { name: "Move Gamma up" });
    await waitFor(() => expect(gammaUp).not.toBeDisabled());
    gammaUp.focus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(patches).toHaveLength(1));
    // While the save is open, the control in use stays focusable: a browser
    // moves focus off a control that becomes disabled.
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Move Gamma up" }));
    expect(document.activeElement).not.toBeDisabled();
    expect(document.activeElement).toHaveAttribute("aria-disabled", "true");
    release();
    server.patchGate = undefined;
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Move Gamma up" })).not.toHaveAttribute(
        "aria-disabled",
        "true",
      ),
    );
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Move Gamma up" }));
    expect(await screen.findByText("Gamma moved to position 2")).toBeInTheDocument();

    // At the top the same control no longer applies; focus takes the other direction.
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(patches).toHaveLength(2));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Move Gamma down" })),
    );
    expect(screen.getByRole("button", { name: "Move Gamma up" })).toBeDisabled();
    expect(await screen.findByText("Gamma moved to position 1")).toBeInTheDocument();
  });

  it("keeps keyboard focus in the list after adding and removing", async () => {
    const patches = serve({
      domains: [geocoding],
      details: { geocoding: orchestrator("geocoding", ["geocoding-maptiler"], "database") },
    });
    mount("geocoding", "geocoding");
    const add = await screen.findByRole("button", { name: "Add Acme" });
    await waitFor(() => expect(add).not.toBeDisabled());
    add.focus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(patches).toHaveLength(1));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Remove Acme" })),
    );
    expect(await screen.findByText("Acme added at position 2")).toBeInTheDocument();

    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(patches).toHaveLength(2));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Remove MapTiler" })),
    );
    expect(await screen.findByText("Acme removed")).toBeInTheDocument();
  });

  it("saves at most the schema's maximum, dropping trailing unlisted providers", async () => {
    const many: Domain = {
      ...weather,
      effective: Array.from({ length: 65 }, (_, i) => entry(`p${i}`, `Provider ${i}`, false)),
    };
    const patches = serve({
      domains: [many],
      details: {
        weather: orchestrator("weather", [], "default", undefined, {
          type: "object",
          properties: { providerOrder: { type: "array", maxItems: 64 } },
        }),
      },
    });
    mount("weather", "weather");
    const up = await screen.findByRole("button", { name: "Move Provider 1 up" });
    await waitFor(() => expect(up).not.toBeDisabled());
    await userEvent.click(up);
    await waitFor(() => expect(patches).toHaveLength(1));
    const saved = (patches[0]?.body as { providerOrder: string[] }).providerOrder;
    expect(saved).toHaveLength(64);
    expect(saved.slice(0, 3)).toEqual(["p1", "p0", "p2"]);
    expect(saved).not.toContain("p64");
  });

  it("explains why the order cannot be edited when the orchestrator could not be read", async () => {
    serve({ domains: [weather], details: {}, detailStatus: 500 });
    mount("weather", "weather");
    expect(
      await screen.findByText(
        "Couldn’t load this integration’s settings, so the order can’t be changed.",
      ),
    ).toBeInTheDocument();
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
      expect(patches.at(-1)?.body).toEqual({ providerOrder: ["routing-b", "routing-a"] }),
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

  it("shows no order control for an orchestrator whose configuration has no provider order", async () => {
    const rideHailing: Domain = {
      domain: "ride-hailing",
      orchestratorId: "ride-hailing",
      unlisted: "append",
      stored: [],
      effective: [entry("ride-a", "Ride A", false), entry("ride-b", "Ride B", false)],
    };
    const patches = serve({
      domains: [rideHailing],
      details: {
        "ride-hailing": {
          ...orchestrator("ride-hailing", [], "default", undefined, {
            type: "object",
            properties: { defaultProvider: { type: "string", title: "Default provider field" } },
          }),
          resolvedConfig: { defaultProvider: { value: "", source: "default" } },
        },
      },
    });
    const client = createTestQueryClient();
    client.setDefaultOptions({ queries: { retry: false } });
    render(
      <QueryClientProvider client={client}>
        <AdminToastProvider>
          <IntegrationDetail id="ride-hailing" />
        </AdminToastProvider>
      </QueryClientProvider>,
    );
    await userEvent.click(await screen.findByRole("tab", { name: /Configuration/ }));
    expect(await screen.findByText("Default provider field")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Provider order" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Move / })).not.toBeInTheDocument();
    expect(patches).toEqual([]);
  });

  it.each([
    ["weather", "Weather"],
    ["fuel-stations", "Fuel stations"],
    ["live-transit", "Live transit"],
  ])("names the %s domain it orders", async (domain, label) => {
    serve({
      domains: [{ ...weather, domain }],
      details: { weather: orchestrator("weather", []) },
    });
    mount("weather", domain);
    expect(await screen.findByText(label)).toBeInTheDocument();
  });

  it("reports a provider order that could not be read", async () => {
    serve({ domains: [], details: { weather: orchestrator("weather", []) }, orderStatus: 500 });
    mount("weather", "weather");
    expect(await screen.findByText("Couldn’t load the provider order.")).toBeInTheDocument();
  });
});
