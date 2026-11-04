import { createApiClient } from "@openmapx/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useMemo } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@/test";
import { ArtifactTransfersSection } from "./ArtifactTransfersSection";

const fixture = vi.hoisted(() => ({ url: "http://artifact.test" }));
vi.mock("../activity/activityQueries", () => ({
  useActivityClient: () => {
    const apiUrl = fixture.url;
    return { apiUrl, client: useMemo(() => createApiClient({ baseUrl: apiUrl }), []) };
  },
}));
vi.mock("@/lib/admin/adminJobEffects", () => ({ useAdminJobRegistration: () => vi.fn() }));
function view() {
  return (
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ArtifactTransfersSection apiUrl={fixture.url} />
    </QueryClientProvider>
  );
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (window as unknown as Record<string, unknown>).showSaveFilePicker;
});
const downloadable = {
  stageId: "9b0f4718-062d-4b5f-8048-55381380aeac",
  purpose: "prepared-artifact",
  direction: "download",
  state: "ready",
  bytes: 4,
  sha256: "a".repeat(64),
  expiresAt: "2030-12-01T00:00:00.000Z",
  cleanup: "pending",
};
function transferResponses(items = [downloadable]) {
  const content = vi.fn(
    async () =>
      new Response(new Uint8Array([0, 255, 128, 7]), {
        headers: {
          "content-type": "application/octet-stream",
          "content-length": "4",
          "content-disposition": 'attachment; filename="openmapx-artifact.tar"',
          "x-artifact-sha256": "a".repeat(64),
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        },
      }),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (raw) => {
      const url = String(raw);
      if (url.endsWith("/content")) return content();
      return Response.json(
        url.endsWith("capabilities")
          ? {
              limits: {
                maxUploadBytes: 1024,
                maxExpandedBytes: 2048,
                maxStageBytes: 4096,
                stageMs: 100000,
                downloadRetentionMs: 10000,
              },
              freeBytes: 8000,
              freeInodes: 500,
              reservedBytes: 4,
              targets: [],
            }
          : { items, total: items.length, limit: 50, offset: 0 },
      );
    }),
  );
  return content;
}
it("aborts a late save sink without downloading after the transfer view is disposed", async () => {
  const content = transferResponses();
  let resolvePicker!: (handle: {
    createWritable(): Promise<{
      write: ReturnType<typeof vi.fn>;
      close: ReturnType<typeof vi.fn>;
      abort: ReturnType<typeof vi.fn>;
    }>;
  }) => void;
  const picker = vi.fn(
    () =>
      new Promise((resolve) => {
        resolvePicker = resolve;
      }),
  );
  Object.defineProperty(window, "showSaveFilePicker", { configurable: true, value: picker });
  const rendered = render(view());
  fireEvent.click(await screen.findByRole("button", { name: "Download bundle" }));
  await waitFor(() => expect(picker).toHaveBeenCalledTimes(1));
  rendered.unmount();
  const writable = { write: vi.fn(), close: vi.fn(), abort: vi.fn(async () => undefined) };
  await act(async () => {
    resolvePicker({ createWritable: async () => writable });
  });
  await waitFor(() => expect(writable.abort).toHaveBeenCalledTimes(1));
  expect(content).not.toHaveBeenCalled();
  expect(writable.close).not.toHaveBeenCalled();
});
it("enables cancellation for the sink download after its save picker resolves", async () => {
  const content = transferResponses();
  let entered!: () => void, release!: () => void;
  const writing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const writable = {
    write: vi.fn(async () => {
      entered();
      await pending;
    }),
    close: vi.fn(),
    abort: vi.fn(async () => {
      release();
    }),
  };
  Object.defineProperty(window, "showSaveFilePicker", {
    configurable: true,
    value: async () => ({ createWritable: async () => writable }),
  });
  render(view());
  fireEvent.click(await screen.findByRole("button", { name: "Download bundle" }));
  await act(async () => {
    await writing;
  });
  expect(screen.getByRole("button", { name: "Cancel byte transfer" })).not.toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel byte transfer" }));
  await waitFor(() => expect(writable.abort).toHaveBeenCalledTimes(1));
  expect(content).toHaveBeenCalledTimes(1);
  expect(writable.close).not.toHaveBeenCalled();
});
it("keeps prepared validation and import actions off integration upload stages", async () => {
  transferResponses([
    { ...downloadable, purpose: "integration-artifact", direction: "upload", state: "uploaded" },
    {
      ...downloadable,
      stageId: "eaa852c6-c4cf-40b4-89b3-e6f74a7b722a",
      purpose: "integration-artifact",
      direction: "upload",
    },
    { ...downloadable, stageId: "bdc999c3-44fa-4a5f-834e-06851f0bb93e", direction: "upload" },
  ]);
  render(view());
  await screen.findByText(/bdc999c3-44fa-4a5f-834e-06851f0bb93e/);
  expect(screen.getAllByRole("button", { name: "Validate" })).toHaveLength(1);
  expect(screen.getAllByRole("button", { name: "Preview import" })).toHaveLength(1);
  expect(screen.getAllByRole("button", { name: "Delete stage" })).toHaveLength(3);
});
it("shows deployment limits and unavailable export reasons without offering a doomed action", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (raw) =>
      Response.json(
        String(raw).endsWith("capabilities")
          ? {
              limits: {
                maxUploadBytes: 1024,
                maxExpandedBytes: 2048,
                maxStageBytes: 4096,
                stageMs: 100000,
                downloadRetentionMs: 10000,
              },
              freeBytes: 8000,
              freeInodes: 500,
              reservedBytes: 0,
              targets: [
                {
                  serviceId: "osrm",
                  available: false,
                  reason: "Stop osrm before exporting.",
                  artifactFingerprint: null,
                },
              ],
            }
          : { items: [], total: 0, limit: 50, offset: 0 },
      ),
    ),
  );
  render(view());
  await waitFor(() => expect(screen.getByText("Stop osrm before exporting.")).toBeInTheDocument());
  expect(screen.getByRole("button", { name: "Queue export" })).toBeDisabled();
  expect(screen.getByText(/Upload limit/)).toHaveTextContent("1.0 KB");
});
it("retains a queued validation as a job and never calls the upload imported", async () => {
  const stage = {
    stageId: "9b0f4718-062d-4b5f-8048-55381380aeac",
    purpose: "prepared-artifact",
    direction: "upload",
    state: "uploaded",
    bytes: 4,
    sha256: "a".repeat(64),
    expiresAt: "2026-12-01T00:00:00.000Z",
    cleanup: "pending",
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (raw) => {
      const url = String(raw);
      if (url.endsWith("capabilities"))
        return Response.json({
          limits: {
            maxUploadBytes: 1024,
            maxExpandedBytes: 2048,
            maxStageBytes: 4096,
            stageMs: 100000,
            downloadRetentionMs: 10000,
          },
          freeBytes: 8000,
          freeInodes: 500,
          reservedBytes: 4,
          targets: [],
        });
      if (url.endsWith("validate"))
        return Response.json(
          { ok: true, jobId: "bf5e4237-d7f2-41be-8111-55e339968ad3" },
          { status: 202 },
        );
      return Response.json({ items: [stage], total: 1, limit: 50, offset: 0 });
    }),
  );
  render(view());
  fireEvent.click(await screen.findByRole("button", { name: "Validate" }));
  await waitFor(() => expect(screen.getByText(/Queued validation/)).toBeInTheDocument());
  expect(screen.queryByText("Imported successfully")).toBeNull();
  expect(screen.getByRole("link", { name: /Open Activity/ })).toHaveAttribute(
    "href",
    expect.stringContaining("/admin/activity"),
  );
});
