import { useSyncExternalStore } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@/test";
import { ActivityTabs } from "./ActivityTabs";

const history = vi.hoisted(() => {
  let entries = ["/admin/activity?tab=audit&status=failed"],
    index = 0;
  const listeners = new Set<() => void>();
  return {
    read: () => entries[index],
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    push: (url: string) => {
      entries = [...entries.slice(0, index + 1), url];
      index++;
      listeners.forEach((fn) => {
        fn();
      });
    },
    replace: (url: string) => {
      entries[index] = url;
      listeners.forEach((fn) => {
        fn();
      });
    },
    back: () => {
      index = Math.max(0, index - 1);
      listeners.forEach((fn) => {
        fn();
      });
    },
    reset: (url: string) => {
      entries = [url];
      index = 0;
    },
  };
});
vi.mock("next/navigation", () => ({
  usePathname: () => new URL(history.read(), "http://test").pathname,
  useSearchParams: () =>
    new URLSearchParams(useSyncExternalStore(history.subscribe, history.read).split("?")[1]),
  useRouter: () => ({ push: history.push, replace: history.replace }),
}));
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
