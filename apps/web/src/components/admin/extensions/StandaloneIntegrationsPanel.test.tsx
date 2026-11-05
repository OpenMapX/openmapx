import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AdminJobEffectsProvider } from "@/lib/admin/adminJobEffects";
import { act, cleanup, createTestQueryClient, fireEvent, render, screen, waitFor } from "@/test";
import { deferred } from "@/test/extensionAdmin";
import { job } from "../activity/__tests__/fixtures";
import { StandaloneIntegrationsPanel } from "./StandaloneIntegrationsPanel";

let apiUrl = "https://admin.example";
vi.mock("@/integration-api/runtime/EnvProvider", () => ({
  useEnv: () => ({ apiUrl }),
}));
const requests: Array<{ url: URL; init: RequestInit }> = [],
  queries: ReturnType<typeof createTestQueryClient>[] = [];
const entry = {
  integrationId: "legacy-map",
  version: "1.0",
  ownership: "unmanaged",
  extensionId: null,
  contentDigest: "a".repeat(64),
  provenance: "legacy_unknown",
  adoptable: true,
  removable: true,
  denialReason: null,
};
const jobId = "a56bdfc1-f66e-4b9d-926a-5b442fa74834",
  operationId = "07439c52-4ebd-4d77-a5c2-4a15a7eb2661";
beforeEach(() => {
  apiUrl = "https://admin.example";
  requests.length = 0;
  vi.stubGlobal("fetch", async (raw: string, init: RequestInit) => {
    const url = new URL(raw);
    requests.push({ url, init });
    if (url.pathname.includes("/catalog")) throw Error("offline catalog");
    if (url.pathname.endsWith("/standalone-integrations"))
      return Response.json({
        entries: [
          entry,
          {
            ...entry,
            integrationId: "catalog-map",
            ownership: "extension",
            adoptable: false,
            removable: false,
            denialReason: "Managed by a catalog extension",
          },
        ],
      });
    if (url.pathname.endsWith("/adopt") || url.pathname.endsWith("/remove"))
      return Response.json({ jobId, operationId }, { status: 202 });
    if (url.pathname.endsWith(jobId))
      return Response.json(
        job({
          id: jobId,
          status: "success",
          cancelable: false,
          result: {
            operationId,
            outcome: "committed",
            action: "adopt",
            integrationId: entry.integrationId,
          },
        }),
      );
    throw Error(`Unexpected ${url.pathname}`);
  });
});
afterEach(() => {
  cleanup();
  for (const query of queries.splice(0)) query.clear();
  vi.unstubAllGlobals();
});
function mount() {
  const query = createTestQueryClient();
  queries.push(query);
  render(
    <QueryClientProvider client={query}>
      <AdminJobEffectsProvider>
        <StandaloneIntegrationsPanel />
      </AdminJobEffectsProvider>
    </QueryClientProvider>,
  );
}
it("shows local legacy inventory independently of the catalog and adopts only reviewed bytes", async () => {
  mount();
  await screen.findByText("legacy-map");
  expect(screen.getAllByText(/Source unknown/)[0]).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Adopt legacy-map" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm adoption" }));
  await screen.findByText(/Ownership change completed/);
  const mutation = requests.find((x) => x.url.pathname.endsWith("/adopt"));
  expect(JSON.parse(String(mutation?.init.body))).toEqual({
    expectedContentDigest: entry.contentDigest,
  });
  expect(new Headers(mutation?.init.headers).get("idempotency-key")).toMatch(/^[a-f0-9-]{36}$/);
  expect(requests.some((x) => x.url.pathname.includes("/catalog"))).toBe(false);
  expect(screen.queryByRole("button", { name: "Remove catalog-map" })).not.toBeInTheDocument();
});
it("requires an explicit removal confirmation and submits only the exact current digest", async () => {
  mount();
  await screen.findByText("legacy-map");
  fireEvent.click(screen.getByRole("button", { name: "Remove legacy-map" }));
  expect(requests.some((x) => x.init.method === "POST")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Confirm removal" }));
  await waitFor(() => expect(requests.some((x) => x.url.pathname.endsWith("/remove"))).toBe(true));
  expect(
    JSON.parse(String(requests.find((x) => x.url.pathname.endsWith("/remove"))?.init.body)),
  ).toEqual({ expectedContentDigest: entry.contentDigest });
});

it("retires a late mutation acknowledgement across A to B to A navigation", async () => {
  const query = createTestQueryClient();
  queries.push(query);
  const ui = () => (
    <QueryClientProvider client={query}>
      <AdminJobEffectsProvider>
        <StandaloneIntegrationsPanel />
      </AdminJobEffectsProvider>
    </QueryClientProvider>
  );
  const original = globalThis.fetch,
    held = deferred<Response>();
  vi.stubGlobal("fetch", async (raw: string, init: RequestInit) =>
    new URL(raw).pathname.endsWith("/adopt") ? held.promise : original(raw, init),
  );
  const view = render(ui());
  await screen.findByText("legacy-map");
  fireEvent.click(screen.getByRole("button", { name: "Adopt legacy-map" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm adoption" }));
  apiUrl = "https://other.example";
  view.rerender(ui());
  await screen.findByText("legacy-map");
  apiUrl = "https://admin.example";
  view.rerender(ui());
  await screen.findByText("legacy-map");
  await act(async () => held.resolve(Response.json({ jobId, operationId }, { status: 202 })));
  expect(screen.queryByText(/Ownership change completed/)).not.toBeInTheDocument();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
