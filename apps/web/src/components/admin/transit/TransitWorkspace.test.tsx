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
  TransitCredentialsSection: ({
    proposalId,
    onReviewFinished,
  }: {
    proposalId?: string;
    onReviewFinished?: () => void;
  }) => (
    <>
      <div>Credential editor {proposalId}</div>
      <button type="button" onClick={onReviewFinished}>
        Finish review
      </button>
    </>
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

it("returns Credentials to the active catalog after the reviewed continuation finishes", () => {
  continuation.current = { proposalId: "reviewed-proposal" };
  render(<TransitWorkspace />);
  expect(screen.getByText("Credential editor reviewed-proposal")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Finish review" }));
  fireEvent.click(screen.getByRole("tab", { name: "Sources" }));
  fireEvent.click(screen.getByRole("tab", { name: "Credentials" }));
  expect(screen.getByText("Credential editor")).toBeInTheDocument();
  expect(screen.queryByText("Credential editor reviewed-proposal")).toBeNull();
});

it("retires a finished proposal when history leaves and returns to Credentials", () => {
  continuation.current = { proposalId: "reviewed-proposal" };
  render(<TransitWorkspace />);
  fireEvent.click(screen.getByRole("tab", { name: "Sources" }));
  fireEvent.click(screen.getByRole("tab", { name: "Credentials" }));
  fireEvent.click(screen.getByRole("button", { name: "Finish review" }));
  act(() => adminTestHistory.back());
  expect(screen.getByText("Source editor")).toBeInTheDocument();
  act(() => adminTestHistory.push("/admin/data/transit?tab=credentials"));
  expect(screen.getByText("Credential editor")).toBeInTheDocument();
  expect(screen.queryByText("Credential editor reviewed-proposal")).toBeNull();
});
