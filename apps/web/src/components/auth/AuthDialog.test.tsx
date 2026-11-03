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

// The installed app routes OAuth to the system browser; an ordinary browser
// keeps it in the page. Tests choose per case.
const systemAuth = {
  route: "in-page" as "in-page" | "system-browser",
  runSystemAuth: vi.fn(),
};
vi.mock("@/lib/mobile/useSystemAuth", () => ({
  useSystemAuth: () => ({
    routeFor: () => systemAuth.route,
    thirdPartyPrimarySignIn: true,
    runSystemAuth: systemAuth.runSystemAuth,
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  systemAuth.route = "in-page";
  signInEmail.mockResolvedValue({ data: {}, error: null });
});

describe("AuthDialog in the installed app", () => {
  it("is usable again after a cancelled system-browser sign-in", async () => {
    systemAuth.route = "system-browser";
    systemAuth.runSystemAuth.mockResolvedValue("cancelled");
    const { AuthDialog } = await import("./AuthDialog");
    render(<AuthDialog open onClose={vi.fn()} />);

    await userEvent.click(screen.getByRole("button", { name: "auth.continueWith" }));

    await screen.findByText("mobileAuth.systemAuthCancelled");
    expect(
      (screen.getByRole("button", { name: "auth.continueWith" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(
      (screen.getByRole("button", { name: "auth.signIn" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(signInSocial).not.toHaveBeenCalled();
  });

  it("reports a completed system-browser sign-in as authenticated", async () => {
    systemAuth.route = "system-browser";
    systemAuth.runSystemAuth.mockResolvedValue("ok");
    const { AuthDialog } = await import("./AuthDialog");
    const onAuthenticated = vi.fn();
    render(<AuthDialog open onClose={vi.fn()} onAuthenticated={onAuthenticated} />);

    await userEvent.click(screen.getByRole("button", { name: "auth.continueWith" }));

    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledTimes(1));
  });
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
