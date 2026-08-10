import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

function renderProvider() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <IntegrationProvider>
        <span>child</span>
      </IntegrationProvider>
    </QueryClientProvider>,
  );
}

const bundleScripts = () =>
  Array.from(document.head.querySelectorAll("script")).filter((script) =>
    script.src.includes("/bundle/index.js"),
  );

describe("IntegrationProvider community bundle boundary", () => {
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

  it("loads a community bundle in an ordinary browser", async () => {
    renderProvider();

    await waitFor(() => expect(bundleScripts()).toHaveLength(1));
  });

  it("executes no community bundle inside the installed shell", async () => {
    // The descriptor alone decides this. Waiting for the handshake would leave a
    // window in which code no reviewer saw had already run.
    (globalThis as Record<string, unknown>)[CHANNEL_GLOBAL] = { nonce: "abc123" };

    const { findByText } = renderProvider();
    await findByText("child");
    // Give the metadata query and its effect the chance the browser case took.
    await waitFor(() => expect(bundleScripts()).toEqual([]));

    expect(bundleScripts()).toEqual([]);
  });
});
