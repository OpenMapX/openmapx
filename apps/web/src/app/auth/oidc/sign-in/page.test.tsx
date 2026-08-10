import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@/test";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());
vi.mock("@/lib/useFullScreenOnMobile", () => ({
  mobileFullScreenDialogPaperSx: {},
  useFullScreenOnMobile: () => false,
}));

const sessionState = {
  current: { data: null as unknown, isPending: false, error: null as unknown },
};
const oauthContinue = vi.fn();

vi.mock("@openmapx/core", () => ({
  authClient: {
    useSession: () => sessionState.current,
    oauth2: { continue: oauthContinue },
    signIn: { email: vi.fn(), passkey: vi.fn(), oauth2: vi.fn() },
    signUp: { email: vi.fn() },
    twoFactor: { verifyBackupCode: vi.fn(), verifyTotp: vi.fn() },
    emailOtp: { requestPasswordReset: vi.fn(), resetPassword: vi.fn() },
  },
  oauthProviders: [],
}));

beforeEach(() => {
  vi.clearAllMocks();
  sessionState.current = { data: null, isPending: false, error: null };
  window.history.replaceState({}, "", "/auth/oidc/sign-in");
});

describe("OIDC sign-in continuation page", () => {
  it("shows progress until the session check settles", async () => {
    sessionState.current = { data: null, isPending: true, error: null };
    const { default: Page } = await import("./page");

    render(<Page />);

    expect(screen.getByRole("progressbar")).not.toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("uses the existing non-dismissible auth dialog while signed out", async () => {
    const { default: Page } = await import("./page");

    render(<Page />);

    expect(screen.getByText("auth.oidcProvider.signInTitle")).not.toBeNull();
    expect(screen.getByRole("dialog")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "common.close" })).toBeNull();
  });

  it("never calls empty oauth2.continue or follows a hostile query redirect", async () => {
    window.history.replaceState(
      {},
      "",
      "/auth/oidc/sign-in?redirect_uri=https%3A%2F%2Fevil.example%2Fsteal",
    );
    sessionState.current = {
      data: { user: { id: "u-1" }, session: { id: "s-1" } },
      isPending: false,
      error: null,
    };
    const { default: Page } = await import("./page");

    render(<Page />);

    expect(oauthContinue).not.toHaveBeenCalled();
    expect(screen.getByText("auth.oidcProvider.alreadySignedInTitle")).not.toBeNull();
    expect(
      screen.getByRole("link", { name: "auth.oidcProvider.backToOpenMapX" }).getAttribute("href"),
    ).toBe("/");
    expect(document.body.innerHTML).not.toContain("evil.example");
  });

  it("shows a safe retry/root fallback when the session check fails", async () => {
    sessionState.current = { data: null, isPending: false, error: new Error("offline") };
    const { default: Page } = await import("./page");

    render(<Page />);

    expect(screen.getByRole("alert").textContent).toContain("auth.oidcProvider.sessionError");
    expect(screen.getByRole("button", { name: "common.retry" })).not.toBeNull();
    expect(
      screen.getByRole("link", { name: "auth.oidcProvider.backToOpenMapX" }).getAttribute("href"),
    ).toBe("/");
    expect(oauthContinue).not.toHaveBeenCalled();
  });
});
