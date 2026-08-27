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

vi.mock("./AuthDialog", () => ({ AuthDialog: () => null }));
vi.mock("./AccountMenu", () => ({
  AccountMenu: ({
    onOpenSettings,
    user,
  }: {
    onOpenSettings: () => void;
    user: { id: string; name?: string | null };
  }) => (
    <div data-testid="private-account-menu" data-user-id={user.id}>
      <span>{user.name}</span>
      <button type="button" onClick={onOpenSettings}>
        open account settings
      </button>
    </div>
  ),
}));
vi.mock("./AccountSettingsDialog", () => ({
  AccountSettingsDialog: ({
    open,
    initialSection,
    user,
  }: {
    open: boolean;
    initialSection: string | null;
    user: { id: string };
  }) =>
    open ? (
      <div
        data-testid="account-settings-dialog"
        data-section={initialSection ?? ""}
        data-user-id={user.id}
      />
    ) : null,
}));
vi.mock("./ResetPasswordDialog", () => ({ ResetPasswordDialog: () => null }));

const { AccountAvatarButton } = await import("./AccountAvatarButton");
const { SessionAuthorityBoundary } = await import("@/providers/SessionAuthorityBoundary");

function AuthorityBoundAvatar() {
  return (
    <SessionAuthorityBoundary>
      <AccountAvatarButton />
    </SessionAuthorityBoundary>
  );
}

function signedInSession(userId: string, sessionId: string, name = `User ${userId}`) {
  return {
    user: { id: userId, name, email: `${userId}@example.test` },
    session: { id: sessionId },
  };
}

afterEach(() => {
  sessionState.current = { data: null, isPending: false };
  act(() => useAccountSettingsStore.getState().close());
});

describe("AccountAvatarButton", () => {
  it("renders an explicit non-submit button", () => {
    render(<AuthorityBoundAvatar />);

    expect(screen.getByRole("button", { name: "map.account" }).getAttribute("type")).toBe("button");
  });

  it("does not submit a surrounding form when tapped", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <form
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <AuthorityBoundAvatar />
      </form>,
    );

    await user.click(screen.getByRole("button", { name: "map.account" }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("renders the current signed-in account", async () => {
    sessionState.current = {
      data: signedInSession("user-a", "session-a", "Alice"),
      isPending: false,
    };

    render(<AuthorityBoundAvatar />);

    expect(await screen.findByTestId("private-account-menu")).toHaveAttribute(
      "data-user-id",
      "user-a",
    );
  });

  it("opens one account dialog from the signed-in account menu", async () => {
    sessionState.current = {
      data: signedInSession("user-a", "session-a", "Alice"),
      isPending: false,
    };
    const user = userEvent.setup();
    render(<AuthorityBoundAvatar />);

    await user.click(await screen.findByRole("button", { name: "open account settings" }));

    expect(screen.getAllByTestId("account-settings-dialog")).toHaveLength(1);
    expect(screen.getByTestId("account-settings-dialog")).toHaveAttribute("data-section", "");
  });

  it("opens the same dialog targeted at Timeline from the shared store", async () => {
    sessionState.current = {
      data: signedInSession("user-a", "session-a", "Alice"),
      isPending: false,
    };
    render(<AuthorityBoundAvatar />);
    await screen.findByTestId("private-account-menu");

    act(() => useAccountSettingsStore.getState().show("timeline"));

    expect(screen.getAllByTestId("account-settings-dialog")).toHaveLength(1);
    expect(screen.getByTestId("account-settings-dialog")).toHaveAttribute(
      "data-section",
      "timeline",
    );
  });

  it("closes account UI and renders a replacement identity immediately", async () => {
    sessionState.current = {
      data: signedInSession("user-a", "session-a", "Alice"),
      isPending: false,
    };
    const view = render(<AuthorityBoundAvatar />);
    await screen.findByTestId("private-account-menu");
    act(() => useAccountSettingsStore.getState().show("timeline"));

    sessionState.current = {
      data: signedInSession("user-b", "session-b", "Bob"),
      isPending: false,
    };
    view.rerender(<AuthorityBoundAvatar />);

    expect(await screen.findByTestId("private-account-menu")).toHaveAttribute(
      "data-user-id",
      "user-b",
    );
    expect(screen.queryByText("Alice")).toBeNull();
    expect(useAccountSettingsStore.getState()).toMatchObject({ open: false, section: null });
  });
});
