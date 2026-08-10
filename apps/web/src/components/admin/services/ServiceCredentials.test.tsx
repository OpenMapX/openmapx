import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServiceCredentialsResponse } from "@/hooks/useServices";

const setCredential = vi.fn();
const deleteCredential = vi.fn();
const showToast = vi.fn();
const query: {
  isLoading: boolean;
  isError: boolean;
  data: ServiceCredentialsResponse;
} = {
  isLoading: false,
  isError: false,
  data: {
    serviceId: "dawarich-app",
    secretsConfigured: true,
    credentials: [
      {
        key: "OIDC_CLIENT_SECRET",
        title: "OpenMapX OIDC client secret",
        source: "vault" as const,
        managedBy: "dawarich-provisioning" as const,
      },
    ],
  },
};

vi.mock("@/hooks/useServices", () => ({
  useServiceCredentials: () => query,
  useSetServiceCredential: () => ({ mutateAsync: setCredential, isPending: false }),
  useDeleteServiceCredential: () => ({ mutateAsync: deleteCredential, isPending: false }),
}));

vi.mock("../shared/AdminToast", () => ({ useAdminToast: () => showToast }));

import { ServiceCredentials } from "./ServiceCredentials";

describe("ServiceCredentials", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    query.data = {
      serviceId: "dawarich-app",
      secretsConfigured: true,
      credentials: [
        {
          key: "OIDC_CLIENT_SECRET",
          title: "OpenMapX OIDC client secret",
          source: "vault",
          managedBy: "dawarich-provisioning",
        },
      ],
    };
  });

  it("shows managed ownership without generic set, rotate, or remove controls", () => {
    render(<ServiceCredentials serviceId="dawarich-app" />);

    expect(screen.getByText("Managed")).toBeInTheDocument();
    expect(screen.getByText(/Managed Dawarich setup owns this credential/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Set" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Rotate" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
  });

  it("preserves generic credential controls for non-managed services", () => {
    query.data = {
      serviceId: "openconditions-ingest",
      secretsConfigured: true,
      credentials: [
        {
          key: "NY_511_API_KEY",
          title: "511NY API key",
          source: "missing",
          managedBy: undefined,
        },
      ],
    };
    render(<ServiceCredentials serviceId="openconditions-ingest" />);

    fireEvent.click(screen.getByRole("button", { name: "Set" }));
    expect(screen.getByLabelText("Value")).toHaveAttribute("type", "password");
  });
});
