import { useIntegrationRegistry } from "@openmapx/integration-framework/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invalidateIntegrationRuntime } from "@/lib/integrationRuntimeQuery";
import { CHANNEL_GLOBAL } from "@/lib/mobile/mobileShellEnvironment";
import { IntegrationProvider } from "./IntegrationProvider";

vi.mock("@/lib/EnvProvider", () => ({
  useEnv: () => ({ apiUrl: "https://api.example.test" }),
}));

const COMMUNITY_INTEGRATION = {
  id: "community-layer",
  isBuiltIn: false,
  frontend: { mapLayer: true },
};

const fetchMock = vi.fn();
let runtimeMetadata: Record<string, unknown>;

function MetadataProbe() {
  const registry = useIntegrationRegistry();
  return (
    <span>{registry.get(COMMUNITY_INTEGRATION.id) ? "metadata-loaded" : "metadata-pending"}</span>
  );
}

function renderProvider() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <IntegrationProvider>
          <span>child</span>
          <MetadataProbe />
        </IntegrationProvider>
      </QueryClientProvider>,
    ),
  };
}

const bundleScripts = () =>
  Array.from(document.head.querySelectorAll("script")).filter((script) =>
    script.src.includes("/bundle/index.js"),
  );

describe("IntegrationProvider community bundle boundary", () => {
  beforeEach(() => {
    runtimeMetadata = {
      revision: "default",
      integrations: [COMMUNITY_INTEGRATION],
      frameworkStrings: {},
      disclosures: [],
    };
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => Response.json(runtimeMetadata));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const script of bundleScripts()) script.remove();
    delete (globalThis as Record<string, unknown>)[CHANNEL_GLOBAL];
  });

  it("executes no community bundle in an ordinary browser", async () => {
    const { findByText } = renderProvider();
    await findByText("metadata-loaded");
    await waitFor(() => expect(bundleScripts()).toEqual([]));
  });

  it("replaces runtime metadata when an admin invalidates the shared query", async () => {
    const { client, findByText } = renderProvider();
    await findByText("metadata-loaded");

    runtimeMetadata = {
      revision: "second",
      integrations: [],
      frameworkStrings: {},
      disclosures: [],
    };
    await act(() => invalidateIntegrationRuntime(client, "https://api.example.test"));

    await findByText("metadata-pending");
  });

  it("executes no community bundle inside the installed shell", async () => {
    // The descriptor alone decides this. Waiting for the handshake would leave a
    // window in which code no reviewer saw had already run.
    (globalThis as Record<string, unknown>)[CHANNEL_GLOBAL] = { nonce: "abc123" };

    const { findByText } = renderProvider();
    await findByText("metadata-loaded");
    // Give the metadata query and its effect the chance the browser case took.
    await waitFor(() => expect(bundleScripts()).toEqual([]));

    expect(bundleScripts()).toEqual([]);
  });
});

describe("IntegrationProvider across every native descriptor state", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", async () =>
      Response.json({
        integrations: [COMMUNITY_INTEGRATION],
        frameworkStrings: {},
        disclosures: [],
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const script of bundleScripts()) script.remove();
    delete (globalThis as Record<string, unknown>)[CHANNEL_GLOBAL];
  });

  /**
   * The descriptor is the whole test.
   *
   * Negotiation may be in flight, may have failed, or may have concluded that
   * the shell is too old — none of those is a reason to execute code no
   * reviewer saw, and the decision must not wait for any of them to resolve.
   */
  it.each([
    { label: "negotiating", nonce: "abc123" },
    { label: "compatible", nonce: "def456" },
    { label: "incompatible", nonce: "ghi789" },
    { label: "errored", nonce: "jkl012" },
  ])("appends no bundle script while $label", async ({ nonce }) => {
    (globalThis as Record<string, unknown>)[CHANNEL_GLOBAL] = { nonce };

    const { findByText } = renderProvider();
    await findByText("metadata-loaded");
    await waitFor(() => expect(bundleScripts()).toEqual([]));

    expect(bundleScripts()).toEqual([]);
  });

  it("loads no community module script in any of them", async () => {
    (globalThis as Record<string, unknown>)[CHANNEL_GLOBAL] = { nonce: "abc123" };

    const { findByText } = renderProvider();
    await findByText("metadata-loaded");

    // Nothing appended means nothing to register: the module only exists once
    // its script has run.
    expect(bundleScripts()).toEqual([]);
  });

  it("also keeps an ordinary PWA free of same-origin community code", async () => {
    const { findByText } = renderProvider();
    await findByText("metadata-loaded");
    await waitFor(() => expect(bundleScripts()).toEqual([]));
  });
});
