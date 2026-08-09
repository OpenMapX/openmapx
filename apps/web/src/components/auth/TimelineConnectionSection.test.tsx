import { ApiError, type TimelineConnectionView, usePersonalTimelineStore } from "@openmapx/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, userEvent, waitFor } from "@/test";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

const connect = vi.fn();
const testConnection = vi.fn();
const disconnect = vi.fn();
const refetch = vi.fn();

const timelineState = {
  connection: {
    data: null as TimelineConnectionView | null,
    isPending: false,
    isFetching: false,
    error: null as ApiError | null,
    refetch,
  },
  connect: {
    mutateAsync: connect,
    isPending: false,
    error: null as ApiError | null,
    reset: vi.fn(),
  },
  test: {
    mutateAsync: testConnection,
    isPending: false,
    error: null as ApiError | null,
    reset: vi.fn(),
  },
  disconnect: {
    mutateAsync: disconnect,
    isPending: false,
    error: null as ApiError | null,
    reset: vi.fn(),
  },
};

vi.mock("@openmapx/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openmapx/core")>();
  return {
    ...actual,
    useTimelineConnection: () => timelineState.connection,
    useConnectTimeline: () => timelineState.connect,
    useTestTimelineConnection: () => timelineState.test,
    useDisconnectTimeline: () => timelineState.disconnect,
  };
});

import { TimelineConnectionSection } from "./TimelineConnectionSection";

const unconfigured = (managed = true): TimelineConnectionView => ({
  connected: false,
  connection: null,
  managed: managed
    ? {
        available: true,
        healthy: true,
        publicOrigin: "https://timeline.example.test",
        reason: null,
      }
    : { available: false, healthy: false, publicOrigin: null, reason: "disabled" },
});

const connected: TimelineConnectionView = {
  connected: true,
  connection: {
    mode: "external",
    publicOrigin: "https://dawarich.example.test",
    displayName: "My Dawarich",
    upstreamEmail: "alice@example.test",
    timeZone: "Europe/Berlin",
    distanceUnit: "km",
    status: "connected",
    validatedAt: "2026-08-09T10:00:00.000Z",
    lastReadAt: null,
  },
  managed: {
    available: true,
    healthy: true,
    publicOrigin: "https://timeline.example.test",
    reason: null,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  usePersonalTimelineStore.getState().resetForSession();
  timelineState.connection.data = unconfigured();
  timelineState.connection.isPending = false;
  timelineState.connection.isFetching = false;
  timelineState.connection.error = null;
  timelineState.connect.isPending = false;
  timelineState.connect.error = null;
  timelineState.test.isPending = false;
  timelineState.test.error = null;
  timelineState.disconnect.isPending = false;
  timelineState.disconnect.error = null;
  connect.mockResolvedValue(connected);
  testConnection.mockResolvedValue(connected);
  disconnect.mockResolvedValue({ ok: true });
});

describe("TimelineConnectionSection", () => {
  it("offers healthy managed mode first as recommended and one active form at a time", async () => {
    const user = userEvent.setup();
    render(<TimelineConnectionSection ownerId="user-a" />);

    const modes = screen.getAllByRole("radio");
    expect(modes[0]).toHaveAccessibleName("account.timeline.modeManaged");
    expect(modes[0]).toBeChecked();
    expect(screen.getByText("account.timeline.recommended")).toBeInTheDocument();
    expect(screen.getByLabelText("account.timeline.apiKey")).toHaveAttribute("type", "password");
    expect(screen.queryByLabelText("account.timeline.instanceUrl")).not.toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: "account.timeline.modeExternal" }));
    expect(screen.getByLabelText("account.timeline.instanceUrl")).toBeInTheDocument();
    expect(screen.getAllByLabelText("account.timeline.apiKey")).toHaveLength(1);
  });

  it("falls back to external mode when managed service is unavailable", () => {
    timelineState.connection.data = unconfigured(false);
    render(<TimelineConnectionSection ownerId="user-a" />);

    expect(screen.queryByRole("radio", { name: "account.timeline.modeManaged" })).toBeNull();
    expect(screen.getByRole("radio", { name: "account.timeline.modeExternal" })).toBeChecked();
    expect(screen.getByText("account.timeline.managedUnavailable")).toBeInTheDocument();
  });

  it("keeps first-time managed setup hidden until the enabled service is healthy", () => {
    timelineState.connection.data = {
      ...unconfigured(),
      managed: {
        available: true,
        healthy: false,
        publicOrigin: "https://timeline.example.test",
        reason: "unhealthy",
      },
    };

    render(<TimelineConnectionSection ownerId="user-a" />);

    expect(screen.queryByRole("radio", { name: "account.timeline.modeManaged" })).toBeNull();
    expect(screen.getByRole("radio", { name: "account.timeline.modeExternal" })).toBeChecked();
    expect(screen.getByText("account.timeline.managedUnavailable")).toBeInTheDocument();
    expect(screen.queryByText("account.timeline.managedSsoExplanation")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "account.timeline.openManagedSettings" }),
    ).toBeNull();
  });

  it("opens managed settings safely and explains SSO versus API-key authorization", async () => {
    const user = userEvent.setup();
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    render(<TimelineConnectionSection ownerId="user-a" />);

    await user.click(screen.getByRole("button", { name: "account.timeline.openManagedSettings" }));

    expect(open).toHaveBeenCalledWith(
      "https://timeline.example.test/users/edit",
      "_blank",
      "noopener,noreferrer",
    );
    expect(screen.getByText("account.timeline.managedSsoExplanation")).toBeInTheDocument();
    expect(screen.getByText("account.timeline.managedApiKeyStep")).toBeInTheDocument();
  });

  it("disables managed settings when the server supplies a non-HTTPS origin", async () => {
    timelineState.connection.data = {
      ...unconfigured(),
      managed: {
        available: true,
        healthy: true,
        publicOrigin: "javascript:alert(document.domain)",
        reason: null,
      },
    };
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    render(<TimelineConnectionSection ownerId="user-a" />);

    const button = screen.getByRole("button", {
      name: "account.timeline.openManagedSettings",
    });
    expect(button).toBeDisabled();
    expect(open).not.toHaveBeenCalled();
  });

  it("validates the external URL locally and preserves non-secret fields for retry", async () => {
    const user = userEvent.setup();
    render(<TimelineConnectionSection ownerId="user-a" />);
    await user.click(screen.getByRole("radio", { name: "account.timeline.modeExternal" }));
    await user.type(screen.getByLabelText("account.timeline.instanceUrl"), "http://localhost:3000");
    await user.type(screen.getByLabelText("account.timeline.displayName"), "Home server");
    await user.type(screen.getByLabelText("account.timeline.apiKey"), "secret-key");

    await user.click(screen.getByRole("button", { name: "account.timeline.connect" }));

    expect(connect).not.toHaveBeenCalled();
    expect(screen.getByText("account.timeline.validationHttps")).toBeInTheDocument();
    expect(screen.getByLabelText("account.timeline.instanceUrl")).toHaveValue(
      "http://localhost:3000",
    );
    expect(screen.getByLabelText("account.timeline.displayName")).toHaveValue("Home server");
  });

  it("clears key material after a successful connection and on mode switch", async () => {
    const user = userEvent.setup();
    render(<TimelineConnectionSection ownerId="user-a" />);
    const key = screen.getByLabelText("account.timeline.apiKey");
    await user.type(key, "managed-secret");
    await user.click(screen.getByRole("button", { name: "account.timeline.connect" }));

    await waitFor(() =>
      expect(connect).toHaveBeenCalledWith({ mode: "managed", apiKey: "managed-secret" }),
    );
    expect(key).toHaveValue("");
    expect(timelineState.connect.reset).toHaveBeenCalledTimes(2);

    await user.type(key, "never-retain-me");
    await user.click(screen.getByRole("radio", { name: "account.timeline.modeExternal" }));
    expect(screen.getByLabelText("account.timeline.apiKey")).toHaveValue("");
  });

  it("removes rejected key material from mutation state while retaining non-secret retry fields", async () => {
    const failure = new ApiError(
      "private upstream response",
      422,
      "TIMELINE_CREDENTIAL_INVALID",
      19,
    );
    connect.mockRejectedValueOnce(failure);
    const user = userEvent.setup();
    render(<TimelineConnectionSection ownerId="user-a" />);
    await user.click(screen.getByRole("radio", { name: "account.timeline.modeExternal" }));
    await user.type(
      screen.getByLabelText("account.timeline.instanceUrl"),
      "https://private.example.test",
    );
    await user.type(screen.getByLabelText("account.timeline.displayName"), "Private server");
    await user.type(screen.getByLabelText("account.timeline.apiKey"), "rejected-private-key");
    const resetsBeforeSubmit = timelineState.connect.reset.mock.calls.length;

    await user.click(screen.getByRole("button", { name: "account.timeline.connect" }));

    await waitFor(() => expect(connect).toHaveBeenCalledTimes(1));
    expect(timelineState.connect.reset).toHaveBeenCalledTimes(resetsBeforeSubmit + 2);
    expect(screen.getByLabelText("account.timeline.apiKey")).toHaveValue("");
    expect(screen.getByLabelText("account.timeline.instanceUrl")).toHaveValue(
      "https://private.example.test",
    );
    expect(screen.getByLabelText("account.timeline.displayName")).toHaveValue("Private server");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "account.timeline.errors.TIMELINE_CREDENTIAL_INVALID",
    );
    expect(screen.queryByText("private upstream response")).toBeNull();
  });

  it.each([
    "TIMELINE_CREDENTIAL_INVALID",
    "TIMELINE_INSTANCE_UNSUPPORTED",
    "TIMELINE_PLAN_RESTRICTED",
    "TIMELINE_RATE_LIMITED",
    "TIMELINE_UPSTREAM_UNAVAILABLE",
    "TIMELINE_RESPONSE_INVALID",
    "TIMELINE_MANAGED_DISABLED",
  ])("maps %s to stable actionable copy", (code) => {
    timelineState.connect.error = new ApiError("unsafe upstream body", 422, code, 17);
    render(<TimelineConnectionSection ownerId="user-a" />);

    expect(screen.getByRole("alert")).toHaveTextContent(`account.timeline.errors.${code}`);
    expect(screen.queryByText("unsafe upstream body")).toBeNull();
  });

  it("shows connected safe metadata and never redisplays a key field", () => {
    timelineState.connection.data = connected;
    render(<TimelineConnectionSection ownerId="user-a" />);

    expect(screen.getByText("My Dawarich")).toBeInTheDocument();
    expect(screen.getByText("https://dawarich.example.test")).toBeInTheDocument();
    expect(screen.getByText("Europe/Berlin")).toBeInTheDocument();
    expect(screen.getByText("alice@example.test")).toBeInTheDocument();
    expect(screen.getByText("account.timeline.upstreamAccount")).toBeInTheDocument();
    expect(screen.getByText("account.timeline.status.connected")).toBeInTheDocument();
    expect(screen.queryByLabelText("account.timeline.apiKey")).toBeNull();
    expect(screen.queryByText(/secret/i)).toBeNull();
  });

  it("never activates a hidden managed form when an existing managed service is unavailable", async () => {
    if (!connected.connection) {
      throw new Error("Connected fixture must include connection metadata");
    }
    timelineState.connection.data = {
      ...connected,
      connection: { ...connected.connection, mode: "managed" },
      managed: { available: false, healthy: false, publicOrigin: null, reason: "disabled" },
    };
    const user = userEvent.setup();
    render(<TimelineConnectionSection ownerId="user-a" />);

    await user.click(screen.getByRole("button", { name: "account.timeline.replace" }));

    expect(screen.queryByRole("radio", { name: "account.timeline.modeManaged" })).toBeNull();
    expect(screen.getByRole("radio", { name: "account.timeline.modeExternal" })).toBeChecked();
    expect(screen.getByLabelText("account.timeline.instanceUrl")).toBeInTheDocument();
    expect(screen.queryByText("account.timeline.managedSsoExplanation")).toBeNull();
  });

  it("tests, safely opens, replaces and switches a connected source", async () => {
    timelineState.connection.data = connected;
    const user = userEvent.setup();
    render(<TimelineConnectionSection ownerId="user-a" />);

    const openLink = screen.getByRole("link", { name: "account.timeline.openDawarich" });
    expect(openLink).toHaveAttribute("href", "https://dawarich.example.test");
    expect(openLink).toHaveAttribute("target", "_blank");
    expect(openLink).toHaveAttribute("rel", expect.stringContaining("noopener"));

    await user.click(screen.getByRole("button", { name: "account.timeline.test" }));
    expect(testConnection).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "account.timeline.replace" }));
    expect(screen.getByLabelText("account.timeline.instanceUrl")).toHaveValue(
      "https://dawarich.example.test",
    );
    expect(screen.getByLabelText("account.timeline.displayName")).toHaveValue("My Dawarich");
    expect(screen.getByLabelText("account.timeline.apiKey")).toHaveValue("");

    await user.click(screen.getByRole("button", { name: "account.timeline.cancelEdit" }));
    await user.click(screen.getByRole("button", { name: "account.timeline.switch" }));
    expect(screen.getByRole("radio", { name: "account.timeline.modeManaged" })).toBeChecked();
    expect(screen.getByLabelText("account.timeline.apiKey")).toHaveValue("");
  });

  it("requires focused confirmation before disconnecting and explains data is retained", async () => {
    timelineState.connection.data = connected;
    usePersonalTimelineStore.getState().setSelectedDate("2026-08-09");
    usePersonalTimelineStore.getState().selectEntry("private-entry");
    const user = userEvent.setup();
    render(<TimelineConnectionSection ownerId="user-a" />);

    await user.click(screen.getByRole("button", { name: "account.timeline.disconnect" }));
    const confirm = screen.getByRole("button", { name: "account.timeline.confirmDisconnect" });
    expect(confirm).toHaveFocus();
    expect(screen.getByText("account.timeline.disconnectKeepsHistory")).toBeInTheDocument();

    await user.click(confirm);
    await waitFor(() => expect(disconnect).toHaveBeenCalledTimes(1));
    expect(usePersonalTimelineStore.getState()).toMatchObject({
      selectedDate: null,
      selectedEntryId: null,
    });
  });

  it("shows loading and testing feedback without duplicate actions", () => {
    timelineState.connection.isPending = true;
    const { rerender } = render(<TimelineConnectionSection ownerId="user-a" />);
    expect(screen.getByRole("status")).toHaveTextContent("account.timeline.loading");

    timelineState.connection.isPending = false;
    timelineState.connection.data = connected;
    timelineState.test.isPending = true;
    rerender(<TimelineConnectionSection ownerId="user-a" />);
    expect(screen.getByRole("button", { name: "account.timeline.testing" })).toBeDisabled();
  });

  it("gives the connection-query retry action a 44px touch target", () => {
    timelineState.connection.data = null;
    timelineState.connection.error = new ApiError(
      "private upstream response",
      503,
      "TIMELINE_UPSTREAM_UNAVAILABLE",
      null,
    );
    render(<TimelineConnectionSection ownerId="user-a" />);

    expect(screen.getByRole("button", { name: "common.retry" })).toHaveStyle({
      minHeight: "44px",
      minWidth: "44px",
    });
  });
});
