import { en } from "@openmapx/i18n";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sessionState: { data: unknown; isPending: boolean } = { data: null, isPending: false };

vi.mock("@openmapx/core", () => ({
  useSession: () => sessionState,
}));
vi.mock("@/lib/EnvProvider", () => ({
  useEnv: () => ({ apiUrl: "https://api.example.test" }),
}));
// The page is a server component; its async translator has no jsdom equivalent,
// so it reads the same catalogue the client half renders from.
vi.mock("next-intl/server", async () => {
  const { en } = await import("@openmapx/i18n");
  return {
    getTranslations: async (namespace: string) => (key: string) =>
      (en as unknown as Record<string, Record<string, string>>)[namespace][key],
  };
});

const { MobileAuthClient } = await import("./MobileAuthClient");
const MobileAuthPage = (await import("./page")).default;

const STATE = "s".repeat(22);
const CHALLENGE = "c".repeat(43);

const replaced: string[] = [];

beforeEach(() => {
  sessionState.data = { user: { id: "user-A" } };
  sessionState.isPending = false;
  replaced.length = 0;
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { replace: (url: string) => replaced.push(url), href: "https://openmapx.test/" },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderClient(props: Record<string, unknown> = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={en} timeZone="Europe/Berlin">
      <MobileAuthClient
        purpose="sign-in"
        state={STATE}
        codeChallenge={CHALLENGE}
        callbackScheme="openmapx"
        {...props}
      />
    </NextIntlClientProvider>,
  );
}

function stubIssue(response: { ok: boolean; body?: unknown }) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return {
      ok: response.ok,
      status: response.ok ? 200 : 400,
      json: async () => response.body ?? {},
    };
  });
  return calls;
}

describe("MobileAuthClient", () => {
  it("issues a handoff and redirects to the compiled callback scheme", async () => {
    const calls = stubIssue({ ok: true, body: { callbackCode: "code-value" } });
    const view = renderClient();

    fireEvent.click(view.getByRole("button", { name: en.mobileAuth.continueToApp }));

    await waitFor(() => expect(replaced).toHaveLength(1));
    const callback = new URL(replaced[0]);
    expect(callback.protocol).toBe("openmapx:");
    expect(callback.searchParams.get("code")).toBe("code-value");
    expect(callback.searchParams.get("state")).toBe(STATE);
    expect(calls[0].url).toBe("https://api.example.test/mobile-auth/issue");
  });

  it("puts no token or session data in the callback URL", async () => {
    stubIssue({ ok: true, body: { callbackCode: "code-value", token: "must-not-appear" } });
    const view = renderClient();

    fireEvent.click(view.getByRole("button", { name: en.mobileAuth.continueToApp }));

    await waitFor(() => expect(replaced).toHaveLength(1));
    // A one-time token in a URL is a token in browser history, in the OS log of
    // the routed intent, and in whatever the app was handed.
    expect(replaced[0]).not.toContain("must-not-appear");
    expect(replaced[0]).not.toContain(CHALLENGE);
  });

  it("sends the purpose, state and challenge and nothing else", async () => {
    const calls = stubIssue({ ok: true, body: { callbackCode: "code-value" } });
    const view = renderClient({ purpose: "add-passkey" });

    fireEvent.click(view.getByRole("button", { name: en.mobileAuth.continueToApp }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      purpose: "add-passkey",
      state: STATE,
      codeChallenge: CHALLENGE,
    });
    expect(calls[0].init.cache).toBe("no-store");
  });

  it("asks the user to sign in first when there is no session", () => {
    sessionState.data = null;
    const view = renderClient();

    expect(view.getByText(en.mobileAuth.signInFirst)).toBeInTheDocument();
    expect(view.getByRole("button", { name: en.mobileAuth.continueToApp })).toBeDisabled();
  });

  it("issues nothing when the server refuses", async () => {
    stubIssue({ ok: false });
    const view = renderClient();

    fireEvent.click(view.getByRole("button", { name: en.mobileAuth.continueToApp }));

    await view.findByRole("alert");
    // No redirect, so the app sees a dismissed browser rather than a bad code.
    expect(replaced).toEqual([]);
  });

  it("shows the localized purpose", () => {
    const view = renderClient({ purpose: "link-provider" });

    expect(view.getByText(en.mobileAuth.purposeLinkProvider)).toBeInTheDocument();
  });
});

describe("MobileAuthPage query validation", () => {
  const renderPage = async (params: Record<string, string>) =>
    render(
      <NextIntlClientProvider locale="en" messages={en} timeZone="Europe/Berlin">
        {await MobileAuthPage({ searchParams: Promise.resolve(params) })}
      </NextIntlClientProvider>,
    );

  it("renders the client for a well-formed request", async () => {
    const view = await renderPage({
      purpose: "sign-in",
      state: STATE,
      code_challenge: CHALLENGE,
      code_challenge_method: "S256",
    });

    expect(view.getByRole("button", { name: en.mobileAuth.continueToApp })).toBeInTheDocument();
  });

  it.each([
    { label: "no state", params: { code_challenge: CHALLENGE, code_challenge_method: "S256" } },
    {
      label: "a short state",
      params: { state: "abc", code_challenge: CHALLENGE, code_challenge_method: "S256" },
    },
    { label: "no challenge", params: { state: STATE, code_challenge_method: "S256" } },
    {
      label: "a plain challenge method",
      params: { state: STATE, code_challenge: CHALLENGE, code_challenge_method: "plain" },
    },
    {
      label: "a non-base64url challenge",
      params: {
        state: STATE,
        code_challenge: `${"a".repeat(42)}+/=`,
        code_challenge_method: "S256",
      },
    },
  ])("refuses $label", async ({ params }) => {
    const view = await renderPage(params as Record<string, string>);

    expect(view.getByRole("alert").textContent).toBe(en.mobileAuth.invalidRequest);
  });

  it("falls back to sign-in for an unknown purpose rather than honouring it", async () => {
    const view = await renderPage({
      purpose: "delete-account",
      state: STATE,
      code_challenge: CHALLENGE,
      code_challenge_method: "S256",
    });

    expect(view.getByText(en.mobileAuth.purposeSignIn)).toBeInTheDocument();
  });
});
