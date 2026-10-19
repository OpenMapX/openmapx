import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SystemMaintenance } from "./SystemMaintenance";

vi.mock("@/integration-api/runtime/EnvProvider", () => ({
  useEnv: () => ({ apiUrl: "http://api.test" }),
}));
vi.mock("../shared/AdminToast", () => ({ useAdminToast: () => vi.fn() }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("keeps host instructions after a raced apply failure and clears them after a fresh successful check", async () => {
  const status = {
    deployment: {
      dockerAvailable: true,
      composeRendered: true,
      hostControlConfigured: true,
      maintenanceReady: true,
    },
    release: {
      currentReleaseId: "old",
      availableReleaseId: "release-123",
      availableDigest: "a".repeat(64),
    },
    images: [
      {
        id: "ops-agent",
        name: "Operations agent",
        image: "agent",
        containerState: "running",
        runningImageId: "agent",
        localImageId: "agent",
        updateAvailable: false,
        status: "up-to-date",
      },
    ],
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (...args: unknown[]) => {
      const url = String(args[0]);
      const init = args[1] as RequestInit | undefined;
      if (init?.method === "POST")
        return Response.json({ jobId: url.endsWith("/check") ? "check-job" : "apply-job" });
      if (url.endsWith("/apply-job"))
        return Response.json({
          id: "apply-job",
          status: "failed",
          error: "Operations request failed",
          result: { errorCode: "host_update_required" },
        });
      if (url.endsWith("/check-job"))
        return Response.json({ id: "check-job", status: "success", error: null });
      return Response.json(status);
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  try {
    render(
      <QueryClientProvider client={client}>
        <SystemMaintenance />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Update OpenMapX" })).not.toBeDisabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Update OpenMapX" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "UPDATE OPENMAPX" } });
    fireEvent.click(screen.getByRole("button", { name: "Update application" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Host update required"),
    );
    expect(screen.getByRole("button", { name: "Update OpenMapX" })).toBeDisabled();
    // The failed job is no longer tracked, but its instructions remain visible.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Check for updates" })).not.toBeDisabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Update OpenMapX" })).not.toBeDisabled();
  } finally {
    client.clear();
  }
});
