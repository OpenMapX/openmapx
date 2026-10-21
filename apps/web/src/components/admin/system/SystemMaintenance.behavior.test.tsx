import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { job } from "../activity/__tests__/fixtures";
import { SystemMaintenance } from "./SystemMaintenance";

vi.mock("@/integration-api/runtime/EnvProvider", () => ({
  useEnv: () => ({ apiUrl: "http://api.test" }),
}));
vi.mock("../shared/AdminToast", () => ({ useAdminToast: () => vi.fn() }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("continues maintenance polling through cancel_pending until terminal completion", async () => {
  vi.useFakeTimers();
  let reads = 0;
  let posts = 0;
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts += 1;
      return Response.json({ jobId: "check-job" });
    }
    if (input.includes("/check-job?source=application")) {
      reads += 1;
      return Response.json({
        ...job({ id: "check-job", cancelable: false }),
        status: reads < 3 ? "cancel_pending" : "success",
      });
    }
    return Response.json({
      deployment: {
        dockerAvailable: true,
        composeRendered: true,
        hostControlConfigured: true,
        maintenanceReady: true,
      },
      release: { currentReleaseId: "current" },
      images: [],
    });
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  try {
    render(
      <QueryClientProvider client={client}>
        <SystemMaintenance />
      </QueryClientProvider>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(screen.getByText("cancel_pending")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check for updates" })).toBeDisabled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(reads).toBe(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(reads).toBeGreaterThanOrEqual(3);
    expect(screen.getByRole("button", { name: "Check for updates" })).not.toBeDisabled();
    const completedReads = reads;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });
    expect(reads).toBe(completedReads);
    expect(posts).toBe(1);
  } finally {
    cleanup();
    client.clear();
  }
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
      if (url.includes("/apply-job?source=application"))
        return Response.json(
          job({
            id: "apply-job",
            status: "failed",
            error: "Operations request failed",
            result: { errorCode: "host_update_required" },
            cancelable: false,
          }),
        );
      if (url.includes("/check-job?source=application"))
        return Response.json(
          job({
            id: "check-job",
            status: "success",
            error: null,
            result: ["checked", { nested: true }],
            cancelable: false,
          }),
        );
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
    expect(screen.getByRole("alert")).toHaveTextContent("previous agent keeps running");
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
