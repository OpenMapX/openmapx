import { en } from "@openmapx/i18n";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nth } from "@/test";

const sessionState: { data: unknown; isPending: boolean } = { data: null, isPending: false };
const deleteCalls: unknown[] = [];
let deleteResult: { error?: unknown } = {};

vi.mock("@openmapx/core", () => ({
  FRESH_SIGN_IN_REQUIRED: "FRESH_SIGN_IN_REQUIRED",
  IMPERSONATION_NOT_ALLOWED: "IMPERSONATION_NOT_ALLOWED",
  useSession: () => sessionState,
  authClient: {
    deleteUser: async (input: unknown) => {
      deleteCalls.push(input);
      return deleteResult;
    },
  },
}));

const { DeleteAccountActions } = await import("./DeleteAccountActions");
const DeleteAccountPage = (await import("./page")).default;

vi.mock("next-intl/server", async () => {
  const { en: catalogue } = await import("@openmapx/i18n");
  return {
    getTranslations: async (namespace: string) => (key: string) =>
      (catalogue as unknown as Record<string, Record<string, string>>)[namespace]?.[key],
  };
});

beforeEach(() => {
  sessionState.data = { user: { id: "user-A" } };
  sessionState.isPending = false;
  deleteCalls.length = 0;
  deleteResult = {};
});

afterEach(cleanup);

const renderActions = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <NextIntlClientProvider locale="en" messages={en} timeZone="Europe/Berlin">
        <DeleteAccountActions />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
};

describe("DeleteAccountActions", () => {
  it("asks for confirmation before deleting anything", () => {
    const view = renderActions();

    fireEvent.click(view.getByRole("button", { name: en.legal.deleteAccountButton }));

    expect(deleteCalls).toEqual([]);
    const warning = view.getByText(en.account.deleteAccountWarning);
    expect(warning).toBeInTheDocument();
    expect(warning.textContent).toContain("Mangrove");
    expect(warning.textContent).toContain("Dawarich");
  });

  it("deletes once confirmed", async () => {
    const view = renderActions();
    fireEvent.click(view.getByRole("button", { name: en.legal.deleteAccountButton }));

    const buttons = view.getAllByRole("button", { name: en.legal.deleteAccountButton });
    fireEvent.click(nth(buttons, -1));

    await waitFor(() => expect(deleteCalls).toEqual([{}]));
    await view.findByRole("status");
  });

  it("asks for a new sign-in when the last one is too old, without retrying", async () => {
    // The same for password, two-factor, passkey-only and provider accounts:
    // no password field, a recent sign-in is the confirmation.
    deleteResult = { error: { code: "FRESH_SIGN_IN_REQUIRED", status: 401 } };
    const view = renderActions();
    fireEvent.click(view.getByRole("button", { name: en.legal.deleteAccountButton }));
    expect(view.container.querySelector('input[type="password"]')).toBeNull();

    const buttons = view.getAllByRole("button", { name: en.legal.deleteAccountButton });
    fireEvent.click(nth(buttons, -1));

    const signIn = await view.findByText(en.account.freshSignIn.signInAgain);
    expect(view.getByText(en.account.freshSignIn.notice)).toBeInTheDocument();
    expect(signIn.closest("a")?.getAttribute("href")).toBe(
      "/auth/confirm?return=%2Fdelete-account",
    );
    expect(view.queryByText(en.account.failedDeleteAccount)).toBeNull();
    expect(deleteCalls).toHaveLength(1);
  });

  it("explains that an impersonation session cannot delete the account", async () => {
    deleteResult = { error: { code: "IMPERSONATION_NOT_ALLOWED", status: 403 } };
    const view = renderActions();
    fireEvent.click(view.getByRole("button", { name: en.legal.deleteAccountButton }));
    const buttons = view.getAllByRole("button", { name: en.legal.deleteAccountButton });
    fireEvent.click(nth(buttons, -1));

    expect(await view.findByText(en.account.freshSignIn.impersonating)).toBeInTheDocument();
    expect(view.queryByText(en.account.freshSignIn.signInAgain)).toBeNull();
  });

  it("reports a failure rather than claiming success", async () => {
    deleteResult = { error: { message: "nope" } };
    const view = renderActions();
    fireEvent.click(view.getByRole("button", { name: en.legal.deleteAccountButton }));

    const buttons = view.getAllByRole("button", { name: en.legal.deleteAccountButton });
    fireEvent.click(nth(buttons, -1));

    await view.findByRole("alert");
  });

  it("offers sign-in rather than a reinstall when signed out", () => {
    sessionState.data = null;

    const view = renderActions();

    // The page has to work for somebody who already uninstalled the app.
    expect(view.getByText(en.legal.deleteAccountSignedOut)).toBeInTheDocument();
    expect(view.queryByRole("button", { name: en.legal.deleteAccountButton })).toBeNull();
  });
});

describe("DeleteAccountPage", () => {
  it("names what is deleted and what is not", async () => {
    const view = render(
      <QueryClientProvider client={new QueryClient()}>
        <NextIntlClientProvider locale="en" messages={en} timeZone="Europe/Berlin">
          {await DeleteAccountPage()}
        </NextIntlClientProvider>
      </QueryClientProvider>,
    );

    expect(view.getByText(en.legal.deleteAccountWhatBody)).toBeInTheDocument();
    // A page that only listed what is deleted would be the misleading half.
    expect(view.getByText(en.legal.deleteAccountKeptBody)).toBeInTheDocument();
    expect(view.getByText(en.legal.deleteAccountTimingBody)).toBeInTheDocument();
  });
});
