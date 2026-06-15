import type { FormEvent } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, userEvent } from "@/test";

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
vi.mock("./AccountMenu", () => ({ AccountMenu: () => null }));
vi.mock("./AccountSettingsDialog", () => ({ AccountSettingsDialog: () => null }));
vi.mock("./ResetPasswordDialog", () => ({ ResetPasswordDialog: () => null }));

import { AccountAvatarButton } from "./AccountAvatarButton";

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
});
