import type { FormEvent } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAccountSettingsStore } from "@/stores/accountSettingsStore";
import { act, render, screen, userEvent } from "@/test";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

const sessionState = { current: { data: null as unknown, isPending: false } };
vi.mock("@openmapx/core", () => ({
  useSession: () => sessionState.current,
  getInitials: () => "AB",
  proxyImageUrl: (url: string) => url,
}));

// The avatar's child dialogs pull in auth clients/stores we don't exercise
// here; stub them so the test isolates the button itself.
vi.mock("./AuthDialog", () => ({ AuthDialog: () => null }));
vi.mock("./AccountMenu", () => ({
  AccountMenu: ({ onOpenSettings }: { onOpenSettings: () => void }) => (
    <button type="button" onClick={onOpenSettings}>
      open account settings
    </button>
  ),
}));
vi.mock("./AccountSettingsDialog", () => ({
  AccountSettingsDialog: ({
    open,
    initialSection,
  }: {
    open: boolean;
    initialSection: string | null;
  }) =>
    open ? <div data-testid="account-settings-dialog" data-section={initialSection ?? ""} /> : null,
}));
vi.mock("./ResetPasswordDialog", () => ({ ResetPasswordDialog: () => null }));

import { AccountAvatarButton } from "./AccountAvatarButton";

afterEach(() => {
  sessionState.current = { data: null, isPending: false };
  act(() => useAccountSettingsStore.getState().close());
});

describe("AccountAvatarButton", () => {
  it("renders an explicit non-submit button", () => {
    render(<AccountAvatarButton />);
    // A <button> with no type defaults to submit. Inside the mobile search
    // <form> that fired handleSubmit (opening the search) instead of the
    // account UI, so the type must be explicit.
    expect(screen.getByRole("button", { name: "map.account" }).getAttribute("type")).toBe("button");
  });

  it("does not submit a surrounding form when tapped", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          onSubmit();
        }}
      >
        <AccountAvatarButton />
      </form>,
    );

    await user.click(screen.getByRole("button", { name: "map.account" }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("opens one account dialog from the signed-in account menu", async () => {
    sessionState.current = {
      data: { user: { id: "user-a", name: "Alice", email: "alice@example.test" } },
      isPending: false,
    };
    const user = userEvent.setup();
    render(<AccountAvatarButton />);

    await user.click(screen.getByRole("button", { name: "open account settings" }));

    expect(screen.getAllByTestId("account-settings-dialog")).toHaveLength(1);
    expect(screen.getByTestId("account-settings-dialog")).toHaveAttribute("data-section", "");
  });

  it("opens the same dialog targeted at Timeline from the shared store", () => {
    sessionState.current = {
      data: { user: { id: "user-a", name: "Alice", email: "alice@example.test" } },
      isPending: false,
    };
    render(<AccountAvatarButton />);

    act(() => useAccountSettingsStore.getState().show("timeline"));

    expect(screen.getAllByTestId("account-settings-dialog")).toHaveLength(1);
    expect(screen.getByTestId("account-settings-dialog")).toHaveAttribute(
      "data-section",
      "timeline",
    );
  });
});
