import {
  PersonalTimelineApiError,
  type PersonalTimelineDayV1,
  type TimelineConnectionView,
  usePersonalTimelineStore,
  useSidebarStore,
} from "@openmapx/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAccountSettingsStore } from "@/stores/accountSettingsStore";
import { act, render, screen, userEvent, waitFor } from "@/test";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

const session = {
  current: {
    data: { user: { id: "user-a" } } as unknown,
    isPending: false,
  },
};
const refetchConnection = vi.fn();
const refetchDay = vi.fn();
const testConnection = vi.fn();
const dayHook = vi.fn();
const connectionState = {
  data: null as TimelineConnectionView | null,
  isPending: false,
  isFetching: false,
  error: null as PersonalTimelineApiError | null,
  refetch: refetchConnection,
};
const dayState = {
  data: null as PersonalTimelineDayV1 | null,
  isPending: false,
  isFetching: false,
  error: null as PersonalTimelineApiError | null,
  refetch: refetchDay,
};
const testState = {
  mutateAsync: testConnection,
  isPending: false,
  error: null as PersonalTimelineApiError | null,
  reset: vi.fn(),
};

vi.mock("@openmapx/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openmapx/core")>();
  return {
    ...actual,
    useSession: () => session.current,
    useTimelineConnection: () => connectionState,
    usePersonalTimelineDay: (...args: unknown[]) => {
      dayHook(...args);
      return dayState;
    },
    useTestTimelineConnection: () => testState,
  };
});

import { SIDEBAR_PANELS } from "../panel-map";
import { TimelinePanelContent } from "./TimelinePanelContent";

const disconnected: TimelineConnectionView = {
  connected: false,
  connection: null,
  managed: { available: false, healthy: false, publicOrigin: null, reason: "disabled" },
};

const connected = (status: "connected" | "degraded" | "invalid" = "connected") =>
  ({
    connected: true,
    connection: {
      mode: "external",
      publicOrigin: "https://dawarich.example.test",
      displayName: "Dawarich",
      upstreamEmail: null,
      timeZone: "Europe/Berlin",
      distanceUnit: "km",
      status,
      validatedAt: "2026-08-09T10:00:00.000Z",
      lastReadAt: null,
    },
    managed: { available: false, healthy: false, publicOrigin: null, reason: "disabled" },
  }) satisfies TimelineConnectionView;

const populatedDay: PersonalTimelineDayV1 = {
  version: 1,
  date: "2026-08-09",
  timeZone: "Europe/Berlin",
  distanceUnit: "km",
  summary: { totalDistance: 3.2, placesVisited: 1, movingMinutes: 20, stationaryMinutes: 60 },
  bounds: [13.3, 52.4, 13.5, 52.6],
  entries: [
    {
      type: "visit",
      id: "visit-1",
      name: "Museum",
      status: null,
      startedAt: "2026-08-09T08:00:00.000Z",
      endedAt: "2026-08-09T09:00:00.000Z",
      durationMinutes: 60,
      tags: [],
      location: { longitude: 13.4, latitude: 52.5 },
    },
  ],
  map: {
    tracks: { type: "FeatureCollection", features: [] },
    visits: { type: "FeatureCollection", features: [] },
  },
  capabilities: { trackGeometry: false, elevation: false },
  warnings: ["TRACK_GEOMETRY_UNAVAILABLE", "PARTIAL_TRACK_PAGE_LIMIT"],
};

beforeEach(() => {
  session.current = { data: { user: { id: "user-a" } }, isPending: false };
  connectionState.data = connected();
  connectionState.isPending = false;
  connectionState.isFetching = false;
  connectionState.error = null;
  dayState.data = populatedDay;
  dayState.isPending = false;
  dayState.isFetching = false;
  dayState.error = null;
  testState.isPending = false;
  testState.error = null;
  testConnection.mockResolvedValue(connected());
  usePersonalTimelineStore.getState().setSelectedDate("2026-08-09");
});

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  act(() => {
    usePersonalTimelineStore.getState().resetForSession();
    useAccountSettingsStore.getState().close();
    useSidebarStore.getState().closeAll();
  });
});

describe("TimelinePanelContent", () => {
  it("is registered as a built-in sidebar panel", () => {
    expect(SIDEBAR_PANELS.timeline).toBeDefined();
  });

  it("defensively closes if the settled session is signed out", async () => {
    session.current = { data: null, isPending: false };
    act(() => useSidebarStore.getState().openSidebar("timeline"));
    render(<TimelinePanelContent />);

    await waitFor(() => expect(useSidebarStore.getState().activeSidebarId).toBeNull());
    expect(dayHook).not.toHaveBeenCalled();
  });

  it("onboards an unconfigured user into Timeline account settings", async () => {
    connectionState.data = disconnected;
    const user = userEvent.setup();
    render(<TimelinePanelContent />);

    expect(screen.getByText("timeline.onboardingReadOnly")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "timeline.openSettings" }));
    expect(useAccountSettingsStore.getState()).toMatchObject({ open: true, section: "timeline" });
  });

  it("initializes a null date to today in the connection timezone", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-28T23:30:00.000Z"));
    usePersonalTimelineStore.getState().resetForSession();
    render(<TimelinePanelContent />);

    await act(async () => {});
    expect(usePersonalTimelineStore.getState().selectedDate).toBe("2026-03-29");
    expect(dayHook).toHaveBeenLastCalledWith("user-a", "2026-03-29", true);
  });

  it.each([
    ["invalid", false],
    ["degraded", true],
  ] as const)(
    "keeps the selected date and shows recovery actions for %s",
    async (status, enabled) => {
      connectionState.data = connected(status);
      const user = userEvent.setup();
      render(<TimelinePanelContent />);

      expect(screen.getByText(`timeline.connection.${status}`)).toBeInTheDocument();
      expect(usePersonalTimelineStore.getState().selectedDate).toBe("2026-08-09");
      expect(dayHook).toHaveBeenLastCalledWith("user-a", "2026-08-09", enabled);
      await user.click(screen.getByRole("button", { name: "timeline.replaceConnection" }));
      expect(useAccountSettingsStore.getState()).toMatchObject({ open: true, section: "timeline" });
      await user.click(screen.getByRole("button", { name: "timeline.testConnection" }));
      expect(testConnection).toHaveBeenCalledTimes(1);
    },
  );

  it("renders loading skeleton feedback", () => {
    dayState.data = null;
    dayState.isPending = true;
    render(<TimelinePanelContent />);

    expect(screen.getByRole("status")).toHaveTextContent("timeline.loadingDay");
  });

  it("renders an empty-day state without summary cards", () => {
    dayState.data = { ...populatedDay, entries: [], warnings: [] };
    render(<TimelinePanelContent />);

    expect(screen.getByText("timeline.emptyDay")).toBeInTheDocument();
    expect(screen.queryByText("timeline.summary.distance")).toBeNull();
  });

  it.each([
    "TIMELINE_NOT_CONNECTED",
    "TIMELINE_MANAGED_DISABLED",
    "TIMELINE_CREDENTIAL_INVALID",
    "TIMELINE_INSTANCE_UNSUPPORTED",
    "TIMELINE_PLAN_RESTRICTED",
    "TIMELINE_RATE_LIMITED",
    "TIMELINE_UPSTREAM_UNAVAILABLE",
    "TIMELINE_RESPONSE_INVALID",
  ] as const)("maps day error %s to safe localized recovery copy", async (code) => {
    dayState.data = null;
    dayState.error = new PersonalTimelineApiError(503, code, 17);
    const user = userEvent.setup();
    render(<TimelinePanelContent />);

    expect(screen.getByRole("alert")).toHaveTextContent(`timeline.errors.${code}`);
    expect(screen.queryByText("private upstream response")).toBeNull();
    await user.click(screen.getByRole("button", { name: "common.retry" }));
    expect(refetchDay).toHaveBeenCalledTimes(1);
  });

  it("maps an unknown day error code to safe fallback copy", () => {
    dayState.data = null;
    dayState.error = new PersonalTimelineApiError(401, null, null);
    render(<TimelinePanelContent />);

    expect(screen.getByRole("alert")).toHaveTextContent("timeline.errors.unknown");
    expect(screen.getByRole("button", { name: "common.retry" })).toHaveStyle({
      minHeight: "44px",
      minWidth: "44px",
    });
    expect(screen.queryByText("private auth response")).toBeNull();
  });

  it("maps an unknown connection error code to safe fallback copy", () => {
    connectionState.data = null;
    connectionState.error = new PersonalTimelineApiError(401, null, null);
    render(<TimelinePanelContent />);

    expect(screen.getByRole("alert")).toHaveTextContent("timeline.errors.unknown");
    expect(screen.getByRole("button", { name: "common.retry" })).toHaveStyle({
      minHeight: "44px",
      minWidth: "44px",
    });
    expect(screen.queryByText("private auth response")).toBeNull();
  });

  it.each([
    "TIMELINE_NOT_CONNECTED",
    "TIMELINE_MANAGED_DISABLED",
    "TIMELINE_CREDENTIAL_INVALID",
  ] as const)("offers connection recovery actions when a day read returns %s", (code) => {
    dayState.data = null;
    dayState.error = new PersonalTimelineApiError(422, code, null);
    render(<TimelinePanelContent />);

    expect(screen.getByRole("button", { name: "timeline.testConnection" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "timeline.replaceConnection" })).toBeInTheDocument();
    expect(usePersonalTimelineStore.getState().selectedDate).toBe("2026-08-09");
  });

  it("renders summary, chronological cards and both partial warnings", () => {
    render(<TimelinePanelContent />);

    expect(screen.getByText("3.2 km")).toBeInTheDocument();
    expect(screen.getByText("Museum")).toBeInTheDocument();
    expect(screen.getByText("timeline.warnings.TRACK_GEOMETRY_UNAVAILABLE")).toBeInTheDocument();
    expect(screen.getByText("timeline.warnings.PARTIAL_TRACK_PAGE_LIMIT")).toBeInTheDocument();
  });

  it("declares narrow-safe layout while keeping navigation, content and recovery context", () => {
    const originalWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    window.dispatchEvent(new Event("resize"));

    try {
      render(<TimelinePanelContent />);

      expect(screen.getByTestId("timeline-panel-root")).toHaveStyle({ minWidth: "0" });
      expect(screen.getByTestId("timeline-day-controls")).toHaveStyle({ flexWrap: "wrap" });
      expect(screen.getByRole("button", { name: "timeline.previousDay" })).toBeInTheDocument();
      expect(screen.getByLabelText("timeline.datePicker")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "timeline.nextDay" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "timeline.today" })).toBeInTheDocument();
      expect(screen.getByText("Museum")).toBeInTheDocument();
      expect(screen.getByText("timeline.warnings.TRACK_GEOMETRY_UNAVAILABLE")).toBeInTheDocument();
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: originalWidth });
      window.dispatchEvent(new Event("resize"));
    }
  });

  it("shows a future-date state and does not fetch the day", () => {
    usePersonalTimelineStore.getState().setSelectedDate("2999-01-01");
    render(<TimelinePanelContent />);

    expect(screen.getByText("timeline.futureDay")).toBeInTheDocument();
    expect(dayHook).toHaveBeenLastCalledWith("user-a", "2999-01-01", false);
  });
});
