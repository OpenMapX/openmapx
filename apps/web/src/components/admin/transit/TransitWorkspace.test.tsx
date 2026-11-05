import { beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@/test";
import { adminTestHistory } from "@/test/adminNavigation";
import { TransitWorkspace } from "./TransitWorkspace";

const continuation = vi.hoisted(() => ({ current: null as null | { proposalId?: string } }));
vi.mock(
  "next/navigation",
  async () => (await import("@/test/adminNavigation")).adminNavigationMock,
);
vi.mock("@/lib/admin/accountAdmin", () => ({
  useAccountAdmin: () => ({ actorId: "actor", apiUrl: "http://data.test" }),
}));
vi.mock("../services/TransitSourcesSection", () => ({
  TransitSourcesSection: () => <div>Source editor</div>,
}));
vi.mock("../services/TransitCredentialsSection", () => ({
  readTransitCredentialContinuation: () => continuation.current,
  TransitCredentialsSection: ({ proposalId }: { proposalId?: string }) => (
    <div>Credential editor {proposalId}</div>
  ),
}));
vi.mock("./LockfileCard", () => ({ LockfileCard: () => <div>Pin editor</div> }));
vi.mock("./TransitPipelinePage", () => ({ TransitPipelinePage: () => <div>Pipeline status</div> }));
beforeEach(() => {
  continuation.current = null;
  adminTestHistory.reset("/admin/data/transit");
});
it("has one mounted owner at a time and respects tab history", () => {
  render(<TransitWorkspace />);
  expect(screen.getByText("Source editor")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("tab", { name: "Catalog" }));
  expect(screen.getByText("Pin editor")).toBeInTheDocument();
  expect(screen.queryByText("Source editor")).toBeNull();
  act(() => adminTestHistory.back());
  expect(screen.getByText("Source editor")).toBeInTheDocument();
});
it("restores a completed matching credential continuation once, then permits explicit navigation", () => {
  continuation.current = { proposalId: "reviewed-proposal" };
  render(<TransitWorkspace />);
  expect(screen.getByText("Credential editor reviewed-proposal")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("tab", { name: "Sources" }));
  expect(screen.getByText("Source editor")).toBeInTheDocument();
});
