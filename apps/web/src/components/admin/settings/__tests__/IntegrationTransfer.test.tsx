import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  createTestQueryClient,
  fireEvent,
  render,
  screen,
  userEvent,
  waitFor,
} from "@/test";
import { AdminToastProvider } from "../../shared/AdminToast";
import { SystemSettings } from "../SystemSettings";

vi.mock("@/integration-api/runtime/EnvProvider", () => ({
  useEnv: () => ({ apiUrl: "http://admin.test" }),
}));
const exported = {
  integrations: [
    { integrationId: "demo", config: { enabled: false, endpoint: "https://provider.test" } },
  ],
  exportedAt: "2026-10-20T10:00:00.000Z",
  count: 1,
};
const clients: ReturnType<typeof createTestQueryClient>[] = [];
function mount(handler: (init: RequestInit) => Response) {
  const calls: RequestInit[] = [];
  vi.stubGlobal("fetch", (input: string, init: RequestInit) => {
    const url = new URL(input);
    expect(url.origin).toBe("http://admin.test");
    if (url.pathname === "/api/admin/settings") return Response.json({ groups: [] });
    if (url.pathname === "/api/admin/integrations/export") return Response.json(exported);
    if (url.pathname !== "/api/admin/integrations/import")
      throw new Error(`Unexpected request ${url}`);
    calls.push(init);
    return handler(init);
  });
  const client = createTestQueryClient();
  clients.push(client);
  const rendered = render(
    <QueryClientProvider client={client}>
      <AdminToastProvider>
        <SystemSettings />
      </AdminToastProvider>
    </QueryClientProvider>,
  );
  return { calls, client, ...rendered };
}
async function upload(container: HTMLElement, body: unknown) {
  await screen.findByRole("button", { name: "Import Integration Configs" });
  const inputs = container.querySelectorAll('input[type="file"]');
  const file = new File([JSON.stringify(body)], "integrations.json", { type: "application/json" });
  Object.defineProperty(file, "text", { value: async () => JSON.stringify(body) });
  fireEvent.change(inputs[1], { target: { files: [file] } });
}
afterEach(() => {
  cleanup();
  for (const c of clients.splice(0)) c.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe("integration config transfer", () => {
  it.each(["restored", "reconciliation_required"])(
    "never treats import 409 %s as success or retries it",
    async (recovery) => {
      const { container, calls } = mount(() =>
        Response.json(
          {
            ok: false,
            error: "Integration import failed",
            phase: "apply",
            recovery,
            database: recovery === "restored" ? "restored" : "retained",
            runtime: recovery === "restored" ? "unchanged" : "unknown",
          },
          { status: 409 },
        ),
      );
      await upload(container, exported);
      expect(
        await screen.findByText(
          recovery === "restored" ? /Import failed.*restored/i : /Import failed.*saved.*uncertain/i,
        ),
      ).toBeInTheDocument();
      expect(screen.queryByText(/Imported 1/)).not.toBeInTheDocument();
      expect(calls).toHaveLength(1);
      expect(document.body.textContent).not.toContain("reconciliation_required");
    },
  );
  it("shows useful manifest validation errors", async () => {
    const { container } = mount(() =>
      Response.json({ errors: ["demo: Unknown writable field endpoint"] }, { status: 400 }),
    );
    await upload(container, exported);
    expect(await screen.findByText(/demo: Unknown writable field endpoint/)).toBeInTheDocument();
  });
  it.each([
    { integrations: [] },
    { ...exported, unknown: true },
    { integrations: [{ integrationId: "demo", config: null }] },
  ])("rejects a malformed file before any mutation: %j", async (body) => {
    const { container, calls } = mount(() => {
      throw new Error("Malformed file reached server");
    });
    await upload(container, body);
    expect(
      await screen.findByText(/Import failed.*file|Import failed.*config/i),
    ).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });
  it("aborts an export body read on unmount", async () => {
    let signal: AbortSignal | null | undefined;
    let canceled = false;
    const mounted = mount(() => {
      throw new Error("No mutation expected");
    });
    vi.stubGlobal("fetch", (input: string, init: RequestInit) => {
      expect(input).toBe("http://admin.test/api/admin/integrations/export");
      signal = init.signal;
      return new Response(
        new ReadableStream({
          cancel: () => {
            canceled = true;
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    });
    await userEvent.click(
      await screen.findByRole("button", { name: "Export Integration Configs" }),
    );
    expect(signal).toBeInstanceOf(AbortSignal);
    mounted.unmount();
    await waitFor(() => expect(signal?.aborted).toBe(true));
    expect(canceled).toBe(true);
  });
  it("downloads the full validated export and imports that exact envelope", async () => {
    let blob: Blob | undefined;
    vi.stubGlobal("URL", URL);
    URL.createObjectURL = (value: Blob | MediaSource): string => {
      if (value instanceof Blob) blob = value;
      return "blob:test";
    };
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const { container, calls } = mount((init) => {
      expect(JSON.parse(String(init.body))).toEqual(exported);
      return Response.json({
        ok: true,
        message: "Reloaded",
        reloaded: 1,
        enabled: 0,
        imported: 1,
        skipped: [],
      });
    });
    await userEvent.click(
      await screen.findByRole("button", { name: "Export Integration Configs" }),
    );
    await screen.findByText("Exported 1 integration configs");
    expect(blob).toBeDefined();
    const exportedBlob = blob;
    if (!exportedBlob) throw new Error("No export file was created");
    const text = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(exportedBlob);
    });
    expect(JSON.parse(text)).toEqual(exported);
    await upload(container, JSON.parse(text));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(await screen.findByText("Imported 1 integration config(s)")).toBeInTheDocument();
  });
});
