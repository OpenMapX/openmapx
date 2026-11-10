import { useSettingsStore } from "@openmapx/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@/test";
import { AuditLog } from "../AuditLog";
import { JobList } from "../JobList";
import { job } from "./fixtures";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());
vi.mock("@/integration-api/runtime/EnvProvider", () => ({
  useEnv: () => ({ apiUrl: "http://api.test" }),
}));
vi.mock(
  "next/navigation",
  async () => (await import("@/test/adminNavigation")).adminNavigationMock,
);

const NOW = Date.parse("2026-11-10T12:00:00Z");
const hoursAgo = (hours: number) => new Date(NOW - hours * 3_600_000).toISOString();
const DATE_AND_TIME = /\d{4}-\d{2}-\d{2}, \d{2}:\d{2}/;

const actor = (name: string) => ({
  actor: { id: name, name, email: `${name}@example.test` },
  createdBy: name,
  actorLabel: name,
});

function mount(ui: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  useSettingsStore.setState({ dateFormat: "ymd", timeFormat: "24h" });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("activity timestamps", () => {
  it("lists a job relatively within a day and by date and time after that", async () => {
    vi.stubGlobal("fetch", async () => {
      const { result: _, logs: __, stages: ___, ...row } = job();
      return Response.json({
        jobs: [
          { ...row, id: "recent", createdAt: hoursAgo(3), ...actor("Recent actor") },
          { ...row, id: "older", createdAt: hoursAgo(26), ...actor("Older actor") },
        ],
        total: 2,
      });
    });
    mount(<JobList />);
    await screen.findByText("Older actor");
    expect(screen.getByText("3 hours ago")).toBeInTheDocument();
    const dated = screen.getAllByText(DATE_AND_TIME);
    expect(dated).toHaveLength(1);
    expect(screen.queryByText(/26 hours ago|yesterday/)).toBeNull();
  });

  it("lists an audit entry relatively within a day and by date and time after that", async () => {
    vi.stubGlobal("fetch", async () =>
      Response.json({
        entries: [
          {
            id: "a",
            actorId: null,
            actor: null,
            targetId: null,
            targetType: null,
            action: "settings.update",
            details: null,
            ipAddress: null,
            createdAt: hoursAgo(23),
          },
          {
            id: "b",
            actorId: null,
            actor: null,
            targetId: null,
            targetType: null,
            action: "settings.update",
            details: null,
            ipAddress: null,
            createdAt: hoursAgo(25),
          },
        ],
        total: 2,
      }),
    );
    mount(<AuditLog />);
    expect(await screen.findByText("23 hours ago")).toBeInTheDocument();
    expect(screen.getAllByText(DATE_AND_TIME)).toHaveLength(1);
    expect(screen.queryByText(/25 hours ago|yesterday/)).toBeNull();
  });

  it("honours the date-format preference after a day", async () => {
    useSettingsStore.setState({ dateFormat: "dmy", timeFormat: "24h" });
    vi.stubGlobal("fetch", async () =>
      Response.json({
        entries: [
          {
            id: "b",
            actorId: null,
            actor: null,
            targetId: null,
            targetType: null,
            action: "settings.update",
            details: null,
            ipAddress: null,
            createdAt: hoursAgo(48),
          },
        ],
        total: 1,
      }),
    );
    mount(<AuditLog />);
    expect(await screen.findByText(/^08[./-]11[./-]2026, \d{2}:\d{2}$/)).toBeInTheDocument();
  });
});
