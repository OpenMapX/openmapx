import { createApiClient } from "@openmapx/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useMemo } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@/test";
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
