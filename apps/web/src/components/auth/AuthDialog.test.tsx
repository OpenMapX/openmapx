import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, userEvent, waitFor } from "@/test";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());
vi.mock("@/lib/useFullScreenOnMobile", () => ({
  mobileFullScreenDialogPaperSx: {},
  useFullScreenOnMobile: () => true,
}));

const signInEmail = vi.fn();
vi.mock("@openmapx/core", () => ({
  authClient: {
    signIn: {
      email: signInEmail,
      passkey: vi.fn(),
      oauth2: vi.fn(),
    },
    signUp: { email: vi.fn() },
    twoFactor: { verifyBackupCode: vi.fn(), verifyTotp: vi.fn() },
    emailOtp: { requestPasswordReset: vi.fn(), resetPassword: vi.fn() },
  },
  oauthProviders: [],
}));

beforeEach(() => {
  vi.clearAllMocks();
  signInEmail.mockResolvedValue({ data: {}, error: null });
});

describe("AuthDialog dismissal policy", () => {
  it("remains dismissible by default", async () => {
    const { AuthDialog } = await import("./AuthDialog");
    const onClose = vi.fn();
    render(<AuthDialog open onClose={onClose} />);

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("cannot be dismissed by Escape, backdrop or a close action when disabled", async () => {
    const { AuthDialog } = await import("./AuthDialog");
    const onClose = vi.fn();
    render(<AuthDialog open onClose={onClose} dismissible={false} />);

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    const backdrop = document.querySelector(".MuiBackdrop-root");
    expect(backdrop).not.toBeNull();
    fireEvent.mouseDown(backdrop as Element);
    fireEvent.click(backdrop as Element);

    expect(screen.queryByRole("button", { name: "common.close" })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("keeps successful email sign-in behavior unchanged", async () => {
    const { AuthDialog } = await import("./AuthDialog");
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<AuthDialog open onClose={onClose} />);

    await user.type(screen.getByRole("textbox", { name: /auth\.email/ }), "ada@example.com");
    await user.type(screen.getByLabelText(/auth\.password/), "fixture-password");
    await user.click(screen.getByRole("button", { name: "auth.signIn" }));

    await waitFor(() => {
      expect(signInEmail).toHaveBeenCalledWith({
        email: "ada@example.com",
        password: "fixture-password",
      });
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
