import { act, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useAuthPromptStore } from "@/stores/authPromptStore";

vi.mock("./AuthDialog", () => ({
  AuthDialog: ({ open, onClose }: { open: boolean; onClose: () => void }) =>
    open ? (
      <button type="button" onClick={onClose}>
        sign-in dialog
      </button>
    ) : null,
}));

const { AuthPromptHost } = await import("./AuthPromptHost");

afterEach(() => act(() => useAuthPromptStore.getState().close()));

it("opens the sign-in dialog on request and keeps it open across a remount", () => {
  const view = render(<AuthPromptHost key="signed-in" />);
  expect(screen.queryByRole("button", { name: "sign-in dialog" })).not.toBeInTheDocument();

  act(() => useAuthPromptStore.getState().show());
  expect(screen.getByRole("button", { name: "sign-in dialog" })).toBeInTheDocument();

  // The session boundary remounts its subtree when the refreshed session arrives.
  view.rerender(<AuthPromptHost key="anonymous" />);
  expect(screen.getByRole("button", { name: "sign-in dialog" })).toBeInTheDocument();

  act(() => screen.getByRole("button", { name: "sign-in dialog" }).click());
  expect(useAuthPromptStore.getState().open).toBe(false);
});
