import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@/test";
import { adminTestHistory as history } from "@/test/adminNavigation";
import { ActivityTabs } from "./ActivityTabs";

vi.mock(
  "next/navigation",
  async () => (await import("@/test/adminNavigation")).adminNavigationMock,
);
vi.mock("./JobList", () => ({ JobList: () => <div>Job inventory</div> }));
vi.mock("./AuditLog", () => ({ AuditLog: () => <div>Audit inventory</div> }));
vi.mock("./AppLogViewer", () => ({ AppLogViewer: () => <div>Application stream</div> }));
afterEach(cleanup);
it("restores the selected view from its URL and Back, keeping the job filter", () => {
  history.reset("/admin/activity?tab=audit&status=failed");
  render(<ActivityTabs />);
  expect(screen.getByText("Audit inventory")).toBeInTheDocument();
  expect(screen.getByRole("tabpanel", { name: "Audit Log" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("tab", { name: "Application Logs" }));
  expect(screen.getByText("Application stream")).toBeInTheDocument();
  expect(history.read()).toBe("/admin/activity?tab=logs&status=failed");
  act(history.back);
  expect(screen.getByText("Audit inventory")).toBeInTheDocument();
  expect(screen.getByRole("tabpanel", { name: "Audit Log" })).toBeInTheDocument();
});
it("defaults an unknown view to Jobs", () => {
  history.reset("/admin/activity?tab=unknown");
  render(<ActivityTabs />);
  expect(screen.getByText("Job inventory")).toBeInTheDocument();
});
