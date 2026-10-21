import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const systemStatus = {
  deployment: {
    dockerAvailable: true,
    composeRendered: true,
    hostControlConfigured: true,
    maintenanceReady: true,
  },
  release: {
    configuredSelector: "preview",
    currentReleaseId: "prebaseline",
    availableReleaseId: "v0.1.0-alpha.1",
    availableVersion: "0.1.0-alpha.1",
    availableDigest: "a".repeat(64),
  },
  images: [
    {
      id: "app-api",
      name: "OpenMapX API",
      image: "ghcr.io/openmapx/api:latest",
      containerState: "running",
      runningImageId: "sha256:old-image",
      localImageId: "sha256:new-image",
      updateAvailable: true,
      status: "update-available" as "update-available" | "up-to-date",
    },
    {
      id: "ops-agent",
      name: "Operations agent",
      image: "ghcr.io/openmapx/ops-agent:latest",
      containerState: "running",
      runningImageId: "sha256:agent",
      localImageId: "sha256:agent",
      updateAvailable: false,
      status: "up-to-date" as "up-to-date" | "update-available" | "unknown" | "not-running",
    },
  ],
};

vi.mock("@/integration-api/runtime/EnvProvider", () => ({
  useEnv: () => ({ apiUrl: "http://api.test" }),
}));
vi.mock("../shared/AdminToast", () => ({ useAdminToast: () => vi.fn() }));
vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQuery: (options: { queryKey: unknown[] }) =>
    options.queryKey[1] === "system"
      ? {
          data: systemStatus,
          isError: false,
        }
      : { data: undefined, isError: false },
}));

afterEach(() => {
  cleanup();
  systemStatus.images[1].status = "up-to-date";
  systemStatus.images[1].updateAvailable = false;
  systemStatus.images[0].runningImageId = "sha256:old-image";
  systemStatus.images[0].localImageId = "sha256:new-image";
  systemStatus.images[0].updateAvailable = true;
  systemStatus.images[0].status = "update-available";
  systemStatus.release.currentReleaseId = "prebaseline";
});

describe("SystemMaintenance", () => {
  it("renders staged image state and safe operator actions", async () => {
    const { SystemMaintenance } = await import("./SystemMaintenance");
    const markup = renderToStaticMarkup(<SystemMaintenance />);
    expect(markup).toContain("System maintenance");
    expect(markup).toContain("Configured channel: preview");
    expect(markup).toContain("v0.1.0-alpha.1");
    expect(markup).toContain("Check for updates");
    expect(markup).toContain("Update OpenMapX");
    expect(markup).toContain("Update available");
    expect(markup).toContain("1 update available");
    expect(markup).toContain("Deep diagnostics");
    expect(markup).toContain("Host-control readiness");
  });

  it("lets the update replace an outdated agent first", async () => {
    systemStatus.images[1].status = "update-available";
    systemStatus.images[1].updateAvailable = true;
    const { SystemMaintenance } = await import("./SystemMaintenance");
    render(<SystemMaintenance />);
    expect(screen.getByRole("button", { name: "Update OpenMapX" })).not.toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("updates the operations agent");
    expect(screen.getByRole("alert")).not.toHaveTextContent("Host update required");
  });

  it.each(["unknown", "not-running"] as const)(
    "requires a host update when agent and helper readiness is %s",
    async (status) => {
      systemStatus.images[1].status = status;
      const { SystemMaintenance } = await import("./SystemMaintenance");
      render(<SystemMaintenance />);
      expect(screen.getByRole("button", { name: "Update OpenMapX" })).toBeDisabled();
      expect(screen.getByRole("alert")).toHaveTextContent("Host update required");
      expect(screen.getByRole("alert")).toHaveTextContent("pnpm openmapx compose release");
      expect(screen.getByRole("alert")).toHaveTextContent(
        "pnpm openmapx services update app-api app-web data-manager ops-agent transitous-runner",
      );
      expect(screen.getByRole("button", { name: "Check for updates" })).not.toBeDisabled();
    },
  );

  it("blocks updates if the agent inspection is missing", async () => {
    const agent = systemStatus.images[1];
    systemStatus.images.splice(1, 1);
    try {
      const { SystemMaintenance } = await import("./SystemMaintenance");
      render(<SystemMaintenance />);
      expect(screen.getByRole("button", { name: "Update OpenMapX" })).toBeDisabled();
      expect(screen.getByRole("alert")).toHaveTextContent("could not be verified");
    } finally {
      systemStatus.images.push(agent);
    }
  });

  it("copies the host update commands", async () => {
    systemStatus.images[1].status = "unknown";
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const { SystemMaintenance } = await import("./SystemMaintenance");
    render(<SystemMaintenance />);
    fireEvent.click(screen.getByRole("button", { name: "Copy commands" }));
    expect(writeText).toHaveBeenCalledWith(
      "pnpm openmapx compose release\npnpm openmapx services update app-api app-web data-manager ops-agent transitous-runner",
    );
  });

  it("allows application updates when agent and helper already match", async () => {
    const { SystemMaintenance } = await import("./SystemMaintenance");
    render(<SystemMaintenance />);
    expect(screen.getByRole("button", { name: "Update OpenMapX" })).not.toBeDisabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("does not send a JSON content type for bodyless maintenance actions", async () => {
    const { buildSystemJobRequestInit } = await import("./SystemMaintenance");

    expect(buildSystemJobRequestInit()).toEqual({
      method: "POST",
      credentials: "include",
    });
    expect(buildSystemJobRequestInit({ confirmation: "UPDATE OPENMAPX" })).toEqual({
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmation: "UPDATE OPENMAPX" }),
    });
  });

  it("disables application updates when every core image is current", async () => {
    systemStatus.images[0].runningImageId = "sha256:current-image";
    systemStatus.images[0].localImageId = "sha256:current-image";
    systemStatus.images[0].updateAvailable = false;
    systemStatus.images[0].status = "up-to-date";
    systemStatus.release.currentReleaseId = "v0.1.0-alpha.1";

    const { SystemMaintenance } = await import("./SystemMaintenance");
    const markup = renderToStaticMarkup(<SystemMaintenance />);

    expect(
      /<button[^>]*disabled=""[^>]*title="Check for a release with changes before updating"[^>]*>[\s\S]*?Update OpenMapX/.test(
        markup,
      ),
    ).toBe(true);
  });
});
