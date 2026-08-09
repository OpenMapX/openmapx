import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mutateProvision = vi.fn();
const mutateRotate = vi.fn();
const hookState = {
  statusQuery: {
    data: {
      installed: true,
      selected: false,
      running: false,
      healthy: false,
      publicOrigin: "https://timeline.example.test",
      oauthClient: {
        present: true,
        clientId: "public-client-id",
        redirectUriMatches: true,
        settingsMatch: true,
        recoveryRequired: false,
      },
      secrets: {
        databasePassword: "consistent",
        secretKeyBase: "consistent",
        oidcClientSecret: "consistent",
      },
      configReady: true,
      readyToStart: true,
      needsApply: true,
    },
    isLoading: false,
    isError: false,
    error: null as Error | null,
  },
  provision: {
    mutateAsync: mutateProvision,
    isPending: false,
    error: null as Error | null,
    reset: vi.fn(),
  },
  rotate: {
    mutateAsync: mutateRotate,
    isPending: false,
    error: null as Error | null,
    reset: vi.fn(),
  },
};

vi.mock("@/hooks/useDawarichProvisioning", () => ({
  useDawarichProvisioning: () => hookState,
  DawarichProvisioningApiError: class DawarichProvisioningApiError extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  },
}));

import { ManagedDawarichSetup } from "./ManagedDawarichSetup";

describe("ManagedDawarichSetup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hookState.statusQuery.data = {
      installed: true,
      selected: false,
      running: false,
      healthy: false,
      publicOrigin: "https://timeline.example.test",
      oauthClient: {
        present: true,
        clientId: "public-client-id",
        redirectUriMatches: true,
        settingsMatch: true,
        recoveryRequired: false,
      },
      secrets: {
        databasePassword: "consistent",
        secretKeyBase: "consistent",
        oidcClientSecret: "consistent",
      },
      configReady: true,
      readyToStart: true,
      needsApply: true,
    };
    hookState.statusQuery.isLoading = false;
    hookState.statusQuery.isError = false;
    hookState.statusQuery.error = null;
    hookState.provision.error = null;
    hookState.rotate.error = null;
    mutateProvision.mockResolvedValue(hookState.statusQuery.data);
    mutateRotate.mockResolvedValue(hookState.statusQuery.data);
  });

  it("shows safe readiness states and directs a ready operator to existing apply controls", () => {
    render(<ManagedDawarichSetup />);

    expect(screen.getByRole("heading", { name: "Managed Dawarich setup" })).toBeInTheDocument();
    expect(screen.getByText("Bundle installed")).toBeInTheDocument();
    expect(screen.getByText("OAuth client")).toBeInTheDocument();
    expect(screen.getByText("Database secret")).toBeInTheDocument();
    expect(screen.getByText("Rails secret")).toBeInTheDocument();
    expect(screen.getByText("OIDC secret")).toBeInTheDocument();
    expect(screen.getByText("https://timeline.example.test")).toBeInTheDocument();
    expect(
      screen.getByText(/Apply changes to both Dawarich Timeline and Dawarich Sidekiq/i),
    ).toBeInTheDocument();
    expect(screen.queryByText("public-client-id")).not.toBeInTheDocument();
  });

  it("confirms the full app and worker bundle after the durable apply check clears", () => {
    hookState.statusQuery.data.selected = true;
    hookState.statusQuery.data.running = true;
    hookState.statusQuery.data.healthy = true;
    hookState.statusQuery.data.needsApply = false;

    render(<ManagedDawarichSetup />);

    expect(
      screen.getByText(/current configuration is applied to both the app and worker/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Apply changes to both/i)).not.toBeInTheDocument();
  });

  it("shows a drifted OAuth client as not ready for reconciliation", () => {
    hookState.statusQuery.data.oauthClient.settingsMatch = false;
    hookState.statusQuery.data.readyToStart = false;

    render(<ManagedDawarichSetup />);

    const oauthRow = screen.getByText("OAuth client").parentElement;
    expect(oauthRow).not.toBeNull();
    expect(within(oauthRow as HTMLElement).getByText("Pending")).toBeInTheDocument();
    expect(within(oauthRow as HTMLElement).queryByText("Ready")).not.toBeInTheDocument();
  });

  it("directs an incomplete OIDC recovery back to reconciliation instead of Apply", () => {
    hookState.statusQuery.data.oauthClient.recoveryRequired = true;
    hookState.statusQuery.data.readyToStart = false;

    render(<ManagedDawarichSetup />);

    expect(screen.getByText(/OIDC recovery is incomplete/i)).toBeInTheDocument();
    expect(screen.queryByText(/Apply changes to both/i)).not.toBeInTheDocument();
  });

  it("validates a hostname before provisioning and sends only the normalized hostname", async () => {
    render(<ManagedDawarichSetup />);
    const hostname = screen.getByRole("textbox", { name: "Public hostname (optional)" });
    fireEvent.change(hostname, { target: { value: "https://timeline.example.test/path" } });
    fireEvent.click(screen.getByRole("button", { name: "Provision/reconcile" }));
    expect(
      await screen.findByText("Enter a DNS hostname without a scheme, path, or port."),
    ).toBeInTheDocument();
    expect(mutateProvision).not.toHaveBeenCalled();

    fireEvent.change(hostname, { target: { value: "Timeline.Example.Test." } });
    fireEvent.click(screen.getByRole("button", { name: "Provision/reconcile" }));
    await waitFor(() => expect(mutateProvision).toHaveBeenCalledWith("timeline.example.test"));
  });

  it("surfaces stable conflict errors without rendering secret material", () => {
    hookState.provision.error = Object.assign(new Error("DAWARICH_DATABASE_SECRET_CONFLICT"), {
      code: "DAWARICH_DATABASE_SECRET_CONFLICT",
    });
    render(<ManagedDawarichSetup />);
    expect(screen.getByText(/database password copies conflict/i)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("password-value");
  });

  it("requires the exact typed confirmation in the collapsed recovery area", async () => {
    render(<ManagedDawarichSetup />);
    fireEvent.click(screen.getByText("OIDC secret recovery"));
    const confirmation = await screen.findByRole("textbox", { name: "Type confirmation" });
    const rotate = screen.getByRole("button", { name: "Rotate OIDC secret" });
    expect(rotate).toBeDisabled();
    fireEvent.change(confirmation, { target: { value: "ROTATE DAWARICH OIDC SECRET" } });
    expect(rotate).not.toBeDisabled();
    fireEvent.click(rotate);
    await waitFor(() => expect(mutateRotate).toHaveBeenCalledTimes(1));
    expect(screen.getByText(/old secret becomes invalid immediately/i)).toBeInTheDocument();
  });
});
