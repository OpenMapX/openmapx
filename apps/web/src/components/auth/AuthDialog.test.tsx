import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, userEvent, waitFor } from "@/test";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());
vi.mock("@/integration-api/runtime/useFullScreenOnMobile", () => ({
  mobileFullScreenDialogPaperSx: {},
  useFullScreenOnMobile: () => true,
}));

const signInEmail = vi.fn();
const signInSocial = vi.fn();
vi.mock("@openmapx/core", () => ({
  authClient: {
    signIn: {
      email: signInEmail,
      passkey: vi.fn(),
      social: signInSocial,
    },
    signUp: { email: vi.fn() },
    twoFactor: { verifyBackupCode: vi.fn(), verifyTotp: vi.fn() },
    emailOtp: { requestPasswordReset: vi.fn(), resetPassword: vi.fn() },
  },
  oauthProviders: [{ providerId: "openstreetmap", name: "OpenStreetMap", icon: "/osm.svg" }],
}));

beforeEach(() => {
  vi.clearAllMocks();
  signInEmail.mockResolvedValue({ data: {}, error: null });
});

describe("AuthDialog dismissal policy", () => {
  it("passes the hosting contribution return path to social sign-in", async () => {
    const { AuthDialog } = await import("./AuthDialog");
    const callbackPath = "/?place=osm%3Anode%3A12&at=13.4%2C52.5&osm-contribute=1";
    render(<AuthDialog open onClose={vi.fn()} callbackPath={callbackPath} />);
    await userEvent.click(screen.getByRole("button", { name: "auth.continueWith" }));
    expect(signInSocial).toHaveBeenCalledWith({
      provider: "openstreetmap",
      callbackURL: new URL(callbackPath, window.location.origin).href,
    });
  });

  it("dismisses without reporting successful authentication", async () => {
    const { AuthDialog } = await import("./AuthDialog");
    const onClose = vi.fn();
    const onAuthenticated = vi.fn();
    render(<AuthDialog open onClose={onClose} onAuthenticated={onAuthenticated} />);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onAuthenticated).not.toHaveBeenCalled();
  });

  it("distinguishes successful authentication from dismissal", async () => {
    const { AuthDialog } = await import("./AuthDialog");
    const onClose = vi.fn();
    const onAuthenticated = vi.fn();
    render(<AuthDialog open onClose={onClose} onAuthenticated={onAuthenticated} />);
    await userEvent.type(screen.getByRole("textbox", { name: /auth\.email/ }), "ada@example.com");
    await userEvent.type(screen.getByLabelText(/auth\.password/), "fixture-password");
    await userEvent.click(screen.getByRole("button", { name: "auth.signIn" }));
    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledTimes(1));
    expect(onClose).not.toHaveBeenCalled();
  });

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
