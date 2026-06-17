// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueryWrapper, render, screen, userEvent, waitFor } from "@/test";

vi.mock("@/lib/EnvProvider", () => ({
  useEnv: () => ({ apiUrl: "http://test.local" }),
}));

// recharts' ResponsiveContainer measures its parent with ResizeObserver, which
// reports 0x0 in jsdom — the chart then renders nothing. Force a fixed size so
// the chart mounts and data-driven labels (tooltip, ticks) are assertable.
vi.mock("recharts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("recharts")>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
      <div style={{ width: 600, height: 220 }} data-testid="chart-container">
        <actual.ResponsiveContainer width={600} height={220}>
          {children}
        </actual.ResponsiveContainer>
      </div>
    ),
  };
});

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

import { HealthHistoryChart } from "../HealthHistoryChart";

const TIMELINE = [
  {
    hour: "2026-06-17T08:00:00.000Z",
    total: 6,
    healthy: 6,
    uptimePercent: 100,
    avgResponseTime: 120,
  },
  {
    hour: "2026-06-17T09:00:00.000Z",
    total: 6,
    healthy: 3,
    uptimePercent: 50,
    avgResponseTime: null,
  },
];

/** Build a response body matching the route shape: { integrationId, hours, timeline }. */
function bodyFor(url: string) {
  const hours = new URL(url).searchParams.get("hours") ?? "24";
  return { integrationId: "demo", hours: Number(hours), timeline: TIMELINE };
}

/** Query-string `hours` values across all fetch calls. */
function requestedHours(): string[] {
  return fetchMock.mock.calls.map((c) => new URL(String(c[0])).searchParams.get("hours") ?? "");
}

afterEach(() => {
  fetchMock.mockReset();
});

describe("HealthHistoryChart", () => {
  it("renders the chart for a populated timeline", async () => {
    fetchMock.mockImplementation((...args: unknown[]) =>
      Promise.resolve({ ok: true, json: async () => bodyFor(String(args[0])) }),
    );

    render(<HealthHistoryChart integrationId="demo" />, { wrapper: createQueryWrapper() });

    // The chart container mounts once data arrives (no skeleton, no empty state).
    await screen.findByTestId("chart-container");
    expect(screen.queryByText("No health history yet")).toBeNull();
    // Default window queries 24 hours.
    expect(requestedHours()).toContain("24");
  });

  it("re-queries with hours=168 when the 7d toggle is clicked", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation((...args: unknown[]) =>
      Promise.resolve({ ok: true, json: async () => bodyFor(String(args[0])) }),
    );

    render(<HealthHistoryChart integrationId="demo" />, { wrapper: createQueryWrapper() });
    await screen.findByTestId("chart-container");

    await user.click(screen.getByRole("button", { name: "Last 7 days" }));

    await waitFor(() => expect(requestedHours()).toContain("168"));
  });

  it("shows an empty state when the timeline is empty", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ integrationId: "demo", hours: 24, timeline: [] }),
    });

    render(<HealthHistoryChart integrationId="demo" />, { wrapper: createQueryWrapper() });

    await screen.findByText("No health history yet");
    expect(screen.queryByTestId("chart-container")).toBeNull();
  });
});
