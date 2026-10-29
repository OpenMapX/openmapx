import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createQueryWrapper, render, screen, userEvent, waitFor } from "@/test";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());
vi.mock("@/integration-api/runtime/useFullScreenOnMobile", () => ({
  mobileFullScreenDialogPaperSx: {},
  useFullScreenOnMobile: () => false,
}));
vi.mock("@/integration-api/runtime/useDateTimeFormat", () => ({
  useDateTimeFormat: () => ({ date: (value: Date) => value.toISOString() }),
}));
vi.mock("./MangroveAccountSection", () => ({ MangroveAccountSection: () => null }));
vi.mock("./PrivacyDataSection", () => ({ PrivacyDataSection: () => null }));
vi.mock("./SharedLinksSection", () => ({ SharedLinksSection: () => null }));
vi.mock("./TimelineConnectionSection", async () => {
  const { forwardRef, useState } = await import("react");
  return {
    TimelineConnectionSection: forwardRef<HTMLHeadingElement, { ownerId: string }>(
      function TimelineSection({ ownerId }, ref) {
        const [apiKey, setApiKey] = useState("");
        const [instanceUrl, setInstanceUrl] = useState("");
        return (
          <section>
            <h2 ref={ref} id="account-timeline-heading" tabIndex={-1}>
              account.timeline.heading
            </h2>
            <span>{ownerId}</span>
            <input
              aria-label="timeline fixture API key"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
            />
            <input
              aria-label="timeline fixture instance URL"
              value={instanceUrl}
              onChange={(event) => setInstanceUrl(event.target.value)}
            />
          </section>
        );
      },
    ),
  };
});
const credentials = vi.hoisted(() => ({
  listPasskeys: vi.fn(),
  listAccounts: vi.fn(),
  add: vi.fn(),
  remove: vi.fn(),
  link: vi.fn(),
  unlink: vi.fn(),
  requestEmail: vi.fn(),
  changeEmail: vi.fn(),
}));
vi.mock("@openmapx/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openmapx/core")>();
  return {
    ...actual,
    authClient: {
      passkey: {
        listUserPasskeys: credentials.listPasskeys,
        addPasskey: credentials.add,
        deletePasskey: credentials.remove,
      },
      listAccounts: credentials.listAccounts,
      linkSocial: credentials.link,
      unlinkAccount: credentials.unlink,
      emailOtp: {
        requestEmailChange: credentials.requestEmail,
        changeEmail: credentials.changeEmail,
      },
    },
    getInitials: () => "AT",
    oauthProviders: [{ providerId: "openstreetmap", name: "OpenStreetMap", icon: "/osm-logo.svg" }],
    proxyImageUrl: (url: string) => url,
  };
});

const emailOk = { data: { success: true }, error: null };

beforeEach(() => {
  for (const mock of Object.values(credentials)) mock.mockReset();
  credentials.listPasskeys.mockResolvedValue({ data: [] });
  credentials.listAccounts.mockResolvedValue({ data: [] });
  credentials.add.mockResolvedValue({ data: { id: "new-key", name: "New passkey" }, error: null });
  credentials.remove.mockResolvedValue({ data: { status: true }, error: null });
  credentials.link.mockResolvedValue({ data: { url: "/oauth", redirect: true }, error: null });
  credentials.unlink.mockResolvedValue({ data: { status: true }, error: null });
  credentials.requestEmail.mockResolvedValue(emailOk);
  credentials.changeEmail.mockResolvedValue(emailOk);
});

import { AccountSettingsDialog } from "./AccountSettingsDialog";

const user = {
  id: "user-a",
  name: "Alice Timeline",
  email: "alice@example.test",
  emailVerified: true,
  image: null,
  twoFactorEnabled: null,
  banned: false,
  createdAt: new Date(),
  updatedAt: new Date(),
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.location.hash = "";
});

describe("AccountSettingsDialog timeline targeting", () => {
  it("focuses and scrolls the stable Timeline heading after opening", async () => {
    const scrollIntoView = vi.spyOn(Element.prototype, "scrollIntoView");

    render(<AccountSettingsDialog open onClose={vi.fn()} user={user} initialSection="timeline" />, {
      wrapper: createQueryWrapper(),
    });

    const heading = await screen.findByRole("heading", {
      name: "account.timeline.heading",
    });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(heading).toHaveAttribute("id", "account-timeline-heading");
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "start", behavior: "smooth" });
  });

  it("targets the Timeline heading without smooth motion when reduced motion is requested", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true })),
    );
    const scrollIntoView = vi.spyOn(Element.prototype, "scrollIntoView");

    render(<AccountSettingsDialog open onClose={vi.fn()} user={user} initialSection="timeline" />, {
      wrapper: createQueryWrapper(),
    });

    const heading = await screen.findByRole("heading", { name: "account.timeline.heading" });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "start", behavior: "auto" });
  });

  it("remounts Timeline settings so an A-to-B identity replacement cannot retain form secrets", async () => {
    const interaction = userEvent.setup();
    const view = render(
      <AccountSettingsDialog open onClose={vi.fn()} user={user} initialSection="timeline" />,
      { wrapper: createQueryWrapper() },
    );
    const profileName = screen.getByLabelText("account.name");
    await interaction.clear(profileName);
    await interaction.type(profileName, "Private A Name");
    await interaction.type(screen.getByLabelText("timeline fixture API key"), "private-a-key");
    await interaction.type(
      screen.getByLabelText("timeline fixture instance URL"),
      "https://private-a.example.test",
    );

    view.rerender(
      <AccountSettingsDialog
        open
        onClose={vi.fn()}
        user={{ ...user, id: "user-b", name: "Bob Timeline" }}
        initialSection="timeline"
      />,
    );

    expect(screen.getByText("user-b")).toBeInTheDocument();
    expect(screen.getByLabelText("account.name")).toHaveValue("Bob Timeline");
    expect(screen.getByLabelText("timeline fixture API key")).toHaveValue("");
    expect(screen.getByLabelText("timeline fixture instance URL")).toHaveValue("");
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function renderAccount() {
  return render(
    <AccountSettingsDialog open onClose={vi.fn()} user={user} initialSection={null} />,
    {
      wrapper: createQueryWrapper(),
    },
  );
}

async function seedCredentials() {
  credentials.listPasskeys.mockResolvedValue({ data: [{ id: "key-a", name: "Primary passkey" }] });
  credentials.listAccounts.mockResolvedValue({
    data: [{ id: "account-a", providerId: "openstreetmap" }],
  });
  const view = renderAccount();
  await screen.findByText("Primary passkey");
  await screen.findByText("account.connected");
  return view;
}

async function unlinkProvider() {
  const interaction = userEvent.setup();
  await interaction.click(await screen.findByRole("button", { name: "account.unlink" }));
  await interaction.click(screen.getByRole("button", { name: "common.confirm" }));
}

describe("AccountSettingsDialog credential actions", () => {
  it.each(["resolved", "thrown"])(
    "keeps a passkey and reports a %s deletion error",
    async (mode) => {
      if (mode === "resolved")
        credentials.remove.mockResolvedValue({ data: null, error: { message: "denied" } });
      else credentials.remove.mockRejectedValue(new Error("offline"));
      await seedCredentials();
      await userEvent.click(screen.getByRole("button", { name: "account.removePasskey" }));
      expect(await screen.findByText("account.failedRemovePasskey")).toBeInTheDocument();
      expect(screen.getByText("Primary passkey")).toBeInTheDocument();
      expect(screen.queryByText("account.passkeyRemoved")).not.toBeInTheDocument();
    },
  );

  it.each(["resolved", "thrown"])(
    "keeps provider confirmation and reports a %s unlink error",
    async (mode) => {
      if (mode === "resolved")
        credentials.unlink.mockResolvedValue({ data: null, error: { message: "last credential" } });
      else credentials.unlink.mockRejectedValue(new Error("offline"));
      await seedCredentials();
      await unlinkProvider();
      expect(await screen.findByText("account.failedUnlink")).toBeInTheDocument();
      expect(screen.getByText("account.connected")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "common.confirm" })).not.toBeDisabled();
      expect(screen.queryByText("account.accountUnlinked")).not.toBeInTheDocument();
    },
  );

  it("removes only a successfully deleted passkey", async () => {
    await seedCredentials();
    await userEvent.click(screen.getByRole("button", { name: "account.removePasskey" }));
    expect(await screen.findByText("account.passkeyRemoved")).toBeInTheDocument();
    expect(screen.queryByText("Primary passkey")).not.toBeInTheDocument();
    expect(screen.getByText("account.connected")).toBeInTheDocument();
  });

  it("unlinks the listed Better Auth record and closes confirmation on success", async () => {
    await seedCredentials();
    await unlinkProvider();
    expect(await screen.findByText("account.accountUnlinked")).toBeInTheDocument();
    expect(screen.getByText("account.notConnected")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "common.confirm" })).not.toBeInTheDocument();
    expect(credentials.unlink).toHaveBeenCalledWith({ accountId: "account-a" });
  });

  it.each(["resolved", "thrown"])(
    "reports a %s link failure without showing a connected account",
    async (mode) => {
      if (mode === "resolved")
        credentials.link.mockResolvedValue({ data: null, error: { message: "denied" } });
      else credentials.link.mockRejectedValue(new Error("offline"));
      renderAccount();
      await userEvent.click(await screen.findByRole("button", { name: "account.connect" }));
      expect(await screen.findByText("account.failedLink")).toBeInTheDocument();
      expect(screen.getByText("account.notConnected")).toBeInTheDocument();
    },
  );

  it("publishes the confirmed new passkey without depending on a second read", async () => {
    renderAccount();
    await userEvent.click(screen.getByRole("button", { name: "account.addPasskey" }));
    expect(await screen.findByText("New passkey")).toBeInTheDocument();
    expect(screen.getByText("account.passkeyAdded")).toBeInTheDocument();
  });

  it("prevents two submissions in the same render and releases the controls after failure", async () => {
    const pending = deferred<{ data: null; error: { message: string } }>();
    credentials.remove.mockReturnValue(pending.promise);
    await seedCredentials();
    const remove = screen.getByRole("button", { name: "account.removePasskey" });
    act(() => {
      remove.click();
      remove.click();
    });
    expect(credentials.remove).toHaveBeenCalledTimes(1);
    expect(remove).toBeDisabled();
    expect(screen.getByRole("button", { name: "account.addPasskey" })).toBeDisabled();
    await act(async () => {
      pending.resolve({ data: null, error: { message: "denied" } });
    });
    expect(await screen.findByText("account.failedRemovePasskey")).toBeInTheDocument();
    expect(remove).not.toBeDisabled();
  });

  it.each(["account", "close", "ABA"])(
    "ignores a late removal failure after %s replacement",
    async (replacement) => {
      const pending = deferred<{ data: null; error: { message: string } }>();
      credentials.remove.mockReturnValue(pending.promise);
      const view = await seedCredentials();
      await userEvent.click(screen.getByRole("button", { name: "account.removePasskey" }));
      const props = { onClose: vi.fn(), initialSection: null };
      view.rerender(
        <AccountSettingsDialog
          {...props}
          open={replacement !== "close"}
          user={{ ...user, id: replacement === "close" ? user.id : "user-b" }}
        />,
      );
      if (replacement !== "account")
        view.rerender(<AccountSettingsDialog {...props} open user={user} />);
      await screen.findByText("Primary passkey");
      await act(async () => {
        pending.resolve({ data: null, error: { message: "old account" } });
      });
      expect(screen.queryByText("account.failedRemovePasskey")).not.toBeInTheDocument();
      expect(screen.getByText("Primary passkey")).toBeInTheDocument();
    },
  );
  it("retries a rejected removal only on another deliberate click", async () => {
    credentials.remove.mockResolvedValue({ data: null, error: { message: "denied" } });
    await seedCredentials();
    await userEvent.click(screen.getByRole("button", { name: "account.removePasskey" }));
    await screen.findByText("account.failedRemovePasskey");
    credentials.remove.mockResolvedValue({ data: { status: true }, error: null });
    await userEvent.click(screen.getByRole("button", { name: "account.removePasskey" }));
    expect(await screen.findByText("account.passkeyRemoved")).toBeInTheDocument();
    expect(credentials.remove).toHaveBeenCalledTimes(2);
  });

  it.each(["resolved", "thrown"])(
    "reports a %s passkey registration failure without a new row",
    async (mode) => {
      if (mode === "resolved")
        credentials.add.mockResolvedValue({
          data: null,
          error: { message: "private backend detail" },
        });
      else credentials.add.mockRejectedValue(new Error("offline"));
      renderAccount();
      await userEvent.click(screen.getByRole("button", { name: "account.addPasskey" }));
      expect(await screen.findByText("account.failedAddPasskey")).toBeInTheDocument();
      expect(screen.queryByText("New passkey")).not.toBeInTheDocument();
      expect(screen.queryByText("account.passkeyAdded")).not.toBeInTheDocument();
    },
  );

  it("does not publish an old successful registration after an account change", async () => {
    const pending = deferred<{ data: { id: string; name: string }; error: null }>();
    credentials.add.mockReturnValue(pending.promise);
    const view = await seedCredentials();
    await userEvent.click(screen.getByRole("button", { name: "account.addPasskey" }));
    view.rerender(
      <AccountSettingsDialog
        open
        onClose={vi.fn()}
        user={{ ...user, id: "user-b" }}
        initialSection={null}
      />,
    );
    await screen.findByText("Primary passkey");
    await act(async () => {
      pending.resolve({ data: { id: "old-key", name: "Old account passkey" }, error: null });
    });
    expect(screen.queryByText("Old account passkey")).not.toBeInTheDocument();
    expect(screen.queryByText("account.passkeyAdded")).not.toBeInTheDocument();
  });

  it("does not unlink the replacement account when an old request succeeds", async () => {
    const pending = deferred<{ data: { status: boolean }; error: null }>();
    credentials.unlink.mockReturnValue(pending.promise);
    const view = await seedCredentials();
    await unlinkProvider();
    view.rerender(
      <AccountSettingsDialog
        open
        onClose={vi.fn()}
        user={{ ...user, id: "user-b" }}
        initialSection={null}
      />,
    );
    await screen.findByText("account.connected");
    await act(async () => {
      pending.resolve({ data: { status: true }, error: null });
    });
    expect(screen.getByText("account.connected")).toBeInTheDocument();
    expect(screen.queryByText("account.accountUnlinked")).not.toBeInTheDocument();
  });

  it("starts the owned OAuth redirect only after a successful link response", async () => {
    credentials.link.mockResolvedValue({
      data: { url: `${window.location.origin}/#oauth-current`, redirect: false },
      error: null,
    });
    renderAccount();
    await userEvent.click(await screen.findByRole("button", { name: "account.connect" }));
    await waitFor(() => expect(window.location.hash).toBe("#oauth-current"));
    expect(credentials.link).toHaveBeenCalledWith({
      provider: "openstreetmap",
      callbackURL: window.location.origin,
      disableRedirect: true,
    });
  });

  it("does not redirect or show errors from a retired link request", async () => {
    const pending = deferred<{ data: { url: string; redirect: boolean }; error: null }>();
    credentials.link.mockReturnValue(pending.promise);
    const view = renderAccount();
    await userEvent.click(await screen.findByRole("button", { name: "account.connect" }));
    view.rerender(
      <AccountSettingsDialog
        open
        onClose={vi.fn()}
        user={{ ...user, id: "user-b" }}
        initialSection={null}
      />,
    );
    await act(async () => {
      pending.resolve({
        data: { url: `${window.location.origin}/#oauth-retired`, redirect: false },
        error: null,
      });
    });
    expect(window.location.hash).toBe("");
    expect(screen.queryByText("account.failedLink")).not.toBeInTheDocument();
  });
  it("keeps a delayed account inventory when a passkey changes", async () => {
    const pending = deferred<{ data: { id: string; providerId: string }[] }>();
    credentials.listAccounts.mockReturnValue(pending.promise);
    credentials.listPasskeys.mockResolvedValue({
      data: [{ id: "key-a", name: "Primary passkey" }],
    });
    renderAccount();
    await screen.findByText("Primary passkey");
    await userEvent.click(screen.getByRole("button", { name: "account.removePasskey" }));
    await screen.findByText("account.passkeyRemoved");
    await act(async () => {
      pending.resolve({ data: [{ id: "account-a", providerId: "openstreetmap" }] });
    });
    expect(screen.getByText("account.connected")).toBeInTheDocument();
  });

  it("keeps a delayed passkey inventory when a provider changes", async () => {
    const pending = deferred<{ data: { id: string; name: string }[] }>();
    credentials.listPasskeys.mockReturnValue(pending.promise);
    credentials.listAccounts.mockResolvedValue({
      data: [{ id: "account-a", providerId: "openstreetmap" }],
    });
    renderAccount();
    await screen.findByText("account.connected");
    await unlinkProvider();
    await screen.findByText("account.accountUnlinked");
    await act(async () => {
      pending.resolve({ data: [{ id: "key-a", name: "Primary passkey" }] });
    });
    expect(screen.getByText("Primary passkey")).toBeInTheDocument();
  });
  it.each(["resolved", "thrown"])(
    "handles %s inventory failures without an unhandled rejection",
    async (mode) => {
      if (mode === "resolved") {
        credentials.listPasskeys.mockResolvedValue({
          data: null,
          error: { message: "unavailable" },
        });
        credentials.listAccounts.mockResolvedValue({
          data: null,
          error: { message: "unavailable" },
        });
      } else {
        credentials.listPasskeys.mockRejectedValue(new Error("offline"));
        credentials.listAccounts.mockRejectedValue(new Error("offline"));
      }
      renderAccount();
      expect(await screen.findByText("account.unexpectedError")).toBeInTheDocument();
      expect(screen.queryByText("account.passkeyRemoved")).not.toBeInTheDocument();
    },
  );

  it("retires the first inventory read during StrictMode effect replay", async () => {
    const pending = deferred<{ data: { id: string; name: string }[] }>();
    let first = true;
    credentials.listPasskeys.mockImplementation(() => {
      if (first) {
        first = false;
        return pending.promise;
      }
      return Promise.resolve({ data: [{ id: "current", name: "Current passkey" }] });
    });
    const QueryWrapper = createQueryWrapper();
    render(
      <StrictMode>
        <QueryWrapper>
          <AccountSettingsDialog open onClose={vi.fn()} user={user} initialSection={null} />
        </QueryWrapper>
      </StrictMode>,
    );
    await screen.findByText("Current passkey");
    await act(async () => {
      pending.resolve({ data: [{ id: "old", name: "Retired passkey" }] });
    });
    expect(screen.getByText("Current passkey")).toBeInTheDocument();
    expect(screen.queryByText("Retired passkey")).not.toBeInTheDocument();
  });

  it("ignores inventory responses from a replaced account", async () => {
    const pending = deferred<{ data: { id: string; name: string }[] }>();
    credentials.listPasskeys.mockReturnValue(pending.promise);
    const view = renderAccount();
    credentials.listPasskeys.mockResolvedValue({ data: [{ id: "b", name: "Account B passkey" }] });
    view.rerender(
      <AccountSettingsDialog
        open
        onClose={vi.fn()}
        user={{ ...user, id: "user-b" }}
        initialSection={null}
      />,
    );
    await screen.findByText("Account B passkey");
    await act(async () => {
      pending.resolve({ data: [{ id: "a", name: "Account A passkey" }] });
    });
    expect(screen.getByText("Account B passkey")).toBeInTheDocument();
    expect(screen.queryByText("Account A passkey")).not.toBeInTheDocument();
  });
});

type EmailResult = { data: { success: boolean } | null; error: { message?: string } | null };
type Outcome = "success" | "error" | "thrown";
const outcomes: Outcome[] = ["success", "error", "thrown"];
const staleError = "stale server error";

function pendingEmail() {
  return deferred<EmailResult>();
}

/** Serves the given results to successive calls of an email endpoint, in order. */
function serve(
  mock: typeof credentials.requestEmail,
  ...results: (Promise<EmailResult> | (() => Promise<EmailResult>))[]
) {
  const queue = [...results];
  mock.mockImplementation(() => {
    const next = queue.shift();
    return typeof next === "function" ? next() : next;
  });
}

async function settle(pending: ReturnType<typeof pendingEmail>, outcome: Outcome) {
  await act(async () => {
    if (outcome === "success") pending.resolve(emailOk);
    else if (outcome === "error") pending.resolve({ data: null, error: { message: staleError } });
    else pending.reject(new Error("stale offline"));
  });
}

const addressField = () => screen.queryByLabelText("account.newEmailAddress");
const codeField = () => screen.queryByLabelText("account.verificationCode");
const addressValue = () =>
  (screen.getByLabelText("account.newEmailAddress") as HTMLInputElement).value;
const sendButton = () => screen.getByRole("button", { name: "account.sendVerificationCode" });
const confirmButton = () => screen.getByRole("button", { name: "account.confirmChange" });
const emailCalls = (mock: typeof credentials.requestEmail) => mock.mock.calls.map(([arg]) => arg);

async function fillAddress(address: string) {
  const field = screen.getByLabelText("account.newEmailAddress");
  await userEvent.clear(field);
  await userEvent.type(field, address);
}

async function openEmailForm() {
  await userEvent.click(screen.getByRole("button", { name: "common.change" }));
}

async function requestCode(address: string) {
  await fillAddress(address);
  await userEvent.click(sendButton());
}

async function enterCode(code: string) {
  const field = await screen.findByLabelText("account.verificationCode");
  await userEvent.clear(field);
  await userEvent.type(field, code);
}

function replaceUser(view: ReturnType<typeof renderAccount>, props: { open: boolean; id: string }) {
  view.rerender(
    <AccountSettingsDialog
      open={props.open}
      onClose={vi.fn()}
      user={{ ...user, id: props.id }}
      initialSection={null}
    />,
  );
}

/** Each way the old email flow can stop being the current one. */
const retirements: Record<
  string,
  (view: ReturnType<typeof renderAccount>, onClose: () => void) => Promise<void>
> = {
  cancel: async () => {
    await userEvent.click(screen.getByRole("button", { name: "common.cancel" }));
  },
  "close button": async (_view, onClose) => {
    await userEvent.click(screen.getByRole("button", { name: "common.close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  },
  escape: async (_view, onClose) => {
    // A disabled pending button drops focus to the body, outside the dialog's key handler.
    await userEvent.click(screen.getByLabelText("account.newEmailAddress"));
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  },
  "close and reopen": async (view) => {
    replaceUser(view, { open: false, id: user.id });
    replaceUser(view, { open: true, id: user.id });
  },
  "account replacement": async (view) => replaceUser(view, { open: true, id: "user-b" }),
  "account A-B-A": async (view) => {
    replaceUser(view, { open: true, id: "user-b" });
    replaceUser(view, { open: true, id: user.id });
  },
};

describe("AccountSettingsDialog email change", () => {
  it("sends a code for the submitted address and confirms it with that code", async () => {
    renderAccount();
    await openEmailForm();
    await requestCode("new@example.test");
    expect(await screen.findByText("account.verificationCodeSent")).toBeInTheDocument();
    expect(emailCalls(credentials.requestEmail)).toEqual([{ newEmail: "new@example.test" }]);
    await enterCode("123456");
    await userEvent.click(confirmButton());
    expect(await screen.findByText("account.emailUpdated")).toBeInTheDocument();
    expect(emailCalls(credentials.changeEmail)).toEqual([
      { newEmail: "new@example.test", otp: "123456" },
    ]);
    expect(addressField()).not.toBeInTheDocument();
    expect(screen.getByText(user.email)).toBeInTheDocument();
  });

  it.each(["returned", "thrown"])(
    "keeps the form usable after a %s send failure and allows a deliberate retry",
    async (mode) => {
      serve(
        credentials.requestEmail,
        mode === "returned"
          ? Promise.resolve({ data: null, error: { message: "denied" } })
          : () => Promise.reject(new Error("offline")),
        Promise.resolve(emailOk),
      );
      renderAccount();
      await openEmailForm();
      await requestCode("new@example.test");
      expect(
        await screen.findByText(mode === "returned" ? "denied" : "account.failedChangeEmail"),
      ).toBeInTheDocument();
      expect(codeField()).not.toBeInTheDocument();
      expect(sendButton()).not.toBeDisabled();
      expect(credentials.requestEmail).toHaveBeenCalledTimes(1);
      await userEvent.click(sendButton());
      expect(await screen.findByText("account.verificationCodeSent")).toBeInTheDocument();
      expect(credentials.requestEmail).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["returned", "thrown"])(
    "keeps the code after a %s confirmation failure and allows a deliberate retry",
    async (mode) => {
      serve(
        credentials.changeEmail,
        mode === "returned"
          ? Promise.resolve({ data: null, error: { message: "wrong" } })
          : () => Promise.reject(new Error("offline")),
        Promise.resolve(emailOk),
      );
      renderAccount();
      await openEmailForm();
      await requestCode("new@example.test");
      await enterCode("123456");
      await userEvent.click(confirmButton());
      expect(
        await screen.findByText(mode === "returned" ? "wrong" : "account.failedChangeEmail"),
      ).toBeInTheDocument();
      expect(codeField()).toHaveValue("123456");
      expect(confirmButton()).not.toBeDisabled();
      expect(credentials.changeEmail).toHaveBeenCalledTimes(1);
      await userEvent.click(confirmButton());
      expect(await screen.findByText("account.emailUpdated")).toBeInTheDocument();
      expect(credentials.changeEmail).toHaveBeenCalledTimes(2);
    },
  );

  it("falls back to the translated message when a returned error has no text", async () => {
    serve(credentials.requestEmail, Promise.resolve({ data: null, error: {} }));
    renderAccount();
    await openEmailForm();
    await requestCode("new@example.test");
    expect(await screen.findByText("account.failedEmailChange")).toBeInTheDocument();
  });

  it("submits once when Send or Confirm is activated twice in the same render", async () => {
    const send = pendingEmail();
    const confirm = pendingEmail();
    serve(credentials.requestEmail, send.promise);
    serve(credentials.changeEmail, confirm.promise);
    renderAccount();
    await openEmailForm();
    await fillAddress("new@example.test");
    act(() => {
      sendButton().click();
      sendButton().click();
    });
    expect(credentials.requestEmail).toHaveBeenCalledTimes(1);
    expect(sendButton()).toBeDisabled();
    expect(screen.getByRole("button", { name: "common.cancel" })).not.toBeDisabled();
    await settle(send, "success");
    await enterCode("123456");
    act(() => {
      confirmButton().click();
      confirmButton().click();
    });
    expect(credentials.changeEmail).toHaveBeenCalledTimes(1);
    expect(confirmButton()).toBeDisabled();
    expect(codeField()).toBeDisabled();
    expect(screen.getByRole("button", { name: "common.cancel" })).not.toBeDisabled();
    await settle(confirm, "success");
    expect(await screen.findByText("account.emailUpdated")).toBeInTheDocument();
  });

  it("completes a current request under StrictMode effect replay", async () => {
    const QueryWrapper = createQueryWrapper();
    render(
      <StrictMode>
        <QueryWrapper>
          <AccountSettingsDialog open onClose={vi.fn()} user={user} initialSection={null} />
        </QueryWrapper>
      </StrictMode>,
    );
    await openEmailForm();
    await requestCode("new@example.test");
    expect(await screen.findByText("account.verificationCodeSent")).toBeInTheDocument();
    await enterCode("123456");
    await userEvent.click(confirmButton());
    expect(await screen.findByText("account.emailUpdated")).toBeInTheDocument();
  });

  it.each(outcomes)(
    "keeps a replacement send pending when an old send settles as %s after Cancel",
    async (outcome) => {
      const stale = pendingEmail();
      const current = pendingEmail();
      serve(credentials.requestEmail, stale.promise, current.promise);
      renderAccount();
      await openEmailForm();
      await requestCode("old@example.test");
      await userEvent.click(screen.getByRole("button", { name: "common.cancel" }));
      await openEmailForm();
      await requestCode("new@example.test");
      await settle(stale, outcome);
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(codeField()).not.toBeInTheDocument();
      expect(sendButton()).toBeDisabled();
      await settle(current, "success");
      expect(await screen.findByText("account.verificationCodeSent")).toBeInTheDocument();
      expect(emailCalls(credentials.requestEmail)).toEqual([
        { newEmail: "old@example.test" },
        { newEmail: "new@example.test" },
      ]);
    },
  );

  it.each(outcomes)(
    "keeps a replacement's sent code and message when an old send settles as %s",
    async (outcome) => {
      const stale = pendingEmail();
      serve(credentials.requestEmail, stale.promise, Promise.resolve(emailOk));
      renderAccount();
      await openEmailForm();
      await requestCode("old@example.test");
      await userEvent.click(screen.getByRole("button", { name: "common.cancel" }));
      await openEmailForm();
      await requestCode("new@example.test");
      await enterCode("654321");
      await settle(stale, outcome);
      expect(codeField()).toHaveValue("654321");
      expect(screen.getByText("account.verificationCodeSent")).toBeInTheDocument();
      expect(screen.getAllByRole("alert")).toHaveLength(1);
    },
  );

  it.each(outcomes)(
    "abandons a pending send when the address is edited and the old send settles as %s",
    async (outcome) => {
      const stale = pendingEmail();
      serve(credentials.requestEmail, stale.promise, Promise.resolve(emailOk));
      renderAccount();
      await openEmailForm();
      await requestCode("old@example.test");
      await fillAddress("other@example.test");
      expect(sendButton()).not.toBeDisabled();
      await settle(stale, outcome);
      expect(codeField()).not.toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      await userEvent.click(sendButton());
      expect(await screen.findByLabelText("account.verificationCode")).toBeInTheDocument();
      expect(emailCalls(credentials.requestEmail)).toEqual([
        { newEmail: "old@example.test" },
        { newEmail: "other@example.test" },
      ]);
    },
  );

  it("does not treat an A-B-A address edit as the original request", async () => {
    const stale = pendingEmail();
    serve(credentials.requestEmail, stale.promise, Promise.resolve(emailOk));
    renderAccount();
    await openEmailForm();
    await requestCode("a@example.test");
    await fillAddress("b@example.test");
    await fillAddress("a@example.test");
    await settle(stale, "success");
    expect(codeField()).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(sendButton()).not.toBeDisabled();
  });

  it("returns to Send and clears the code when a verified address is edited", async () => {
    renderAccount();
    await openEmailForm();
    await requestCode("a@example.test");
    await enterCode("123456");
    await fillAddress("b@example.test");
    expect(codeField()).not.toBeInTheDocument();
    expect(screen.queryByText("account.verificationCodeSent")).not.toBeInTheDocument();
    await userEvent.click(sendButton());
    expect(await screen.findByLabelText("account.verificationCode")).toHaveValue("");
    expect(emailCalls(credentials.requestEmail)).toEqual([
      { newEmail: "a@example.test" },
      { newEmail: "b@example.test" },
    ]);
  });

  describe.each(["send", "confirm"] as const)("owned %s failure", (step) => {
    const failures = {
      returned: () => Promise.resolve({ data: null, error: { message: "denied" } }),
      thrown: () => Promise.reject(new Error("offline")),
    };

    async function failEmailStep(mode: keyof typeof failures) {
      if (step === "send") serve(credentials.requestEmail, failures[mode]);
      else serve(credentials.changeEmail, failures[mode]);
      await openEmailForm();
      await requestCode("a@example.test");
      if (step === "confirm") {
        await enterCode("123456");
        await userEvent.click(confirmButton());
      }
      expect(
        await screen.findByText(mode === "returned" ? "denied" : "account.failedChangeEmail"),
      ).toBeInTheDocument();
    }

    it.each(["returned", "thrown"] as const)(
      "is cleared with its address when a %s error is followed by an address edit",
      async (mode) => {
        renderAccount();
        await failEmailStep(mode);
        await fillAddress("b@example.test");
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
        expect(codeField()).not.toBeInTheDocument();
        expect(sendButton()).not.toBeDisabled();
      },
    );

    it("leaves an unrelated credential message in place when the address is edited", async () => {
      credentials.remove.mockResolvedValue({ data: null, error: { message: "denied" } });
      await seedCredentials();
      await failEmailStep("returned");
      await userEvent.click(screen.getByRole("button", { name: "account.removePasskey" }));
      expect(await screen.findByText("account.failedRemovePasskey")).toBeInTheDocument();
      await fillAddress("b@example.test");
      expect(screen.getByText("account.failedRemovePasskey")).toBeInTheDocument();
    });
  });

  it("leaves a newer unrelated message in place when a pending send is abandoned by an edit", async () => {
    credentials.remove.mockResolvedValue({ data: null, error: { message: "denied" } });
    serve(credentials.requestEmail, pendingEmail().promise);
    await seedCredentials();
    await openEmailForm();
    await requestCode("a@example.test");
    await userEvent.click(screen.getByRole("button", { name: "account.removePasskey" }));
    expect(await screen.findByText("account.failedRemovePasskey")).toBeInTheDocument();
    await fillAddress("b@example.test");
    expect(screen.getByText("account.failedRemovePasskey")).toBeInTheDocument();
    expect(sendButton()).not.toBeDisabled();
  });

  it("keeps the email-updated message visible after a successful change", async () => {
    renderAccount();
    await openEmailForm();
    await requestCode("a@example.test");
    await enterCode("123456");
    await userEvent.click(confirmButton());
    expect(await screen.findByText("account.emailUpdated")).toBeInTheDocument();
    await openEmailForm();
    expect(screen.getByText("account.emailUpdated")).toBeInTheDocument();
  });

  it.each(outcomes)(
    "keeps a replacement send pending when an old confirmation settles as %s after an address edit",
    async (outcome) => {
      const stale = pendingEmail();
      const current = pendingEmail();
      serve(credentials.requestEmail, Promise.resolve(emailOk), current.promise);
      serve(credentials.changeEmail, stale.promise);
      renderAccount();
      await openEmailForm();
      await requestCode("a@example.test");
      await enterCode("123456");
      await userEvent.click(confirmButton());
      await requestCode("b@example.test");
      await settle(stale, outcome);
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(addressValue()).toBe("b@example.test");
      expect(codeField()).not.toBeInTheDocument();
      expect(sendButton()).toBeDisabled();
      expect(credentials.changeEmail).toHaveBeenCalledTimes(1);
      await settle(current, "success");
      expect(await screen.findByText("account.verificationCodeSent")).toBeInTheDocument();
      expect(codeField()).toHaveValue("");
    },
  );

  describe.each(Object.keys(retirements))("after %s", (retirement) => {
    it.each(outcomes)(
      "ignores an old send that settles as %s before any replacement starts",
      async (outcome) => {
        const stale = pendingEmail();
        serve(credentials.requestEmail, stale.promise);
        const onClose = vi.fn();
        const view = render(
          <AccountSettingsDialog open onClose={onClose} user={user} initialSection={null} />,
          { wrapper: createQueryWrapper() },
        );
        await openEmailForm();
        await requestCode("old@example.test");
        await retirements[retirement]?.(view, onClose);
        await settle(stale, outcome);
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
        if (!addressField()) await openEmailForm();
        expect(codeField()).not.toBeInTheDocument();
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      },
    );

    it.each(outcomes)("ignores an old send that settles as %s", async (outcome) => {
      const stale = pendingEmail();
      const current = pendingEmail();
      serve(credentials.requestEmail, stale.promise, current.promise);
      const onClose = vi.fn();
      const view = render(
        <AccountSettingsDialog open onClose={onClose} user={user} initialSection={null} />,
        { wrapper: createQueryWrapper() },
      );
      await openEmailForm();
      await requestCode("old@example.test");
      await retirements[retirement]?.(view, onClose);
      if (!addressField()) await openEmailForm();
      if (!addressValue()) await fillAddress("fresh@example.test");
      const address = addressValue();
      await userEvent.click(sendButton());
      expect(emailCalls(credentials.requestEmail)).toEqual([
        { newEmail: "old@example.test" },
        { newEmail: address },
      ]);
      await settle(stale, outcome);
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(codeField()).not.toBeInTheDocument();
      expect(sendButton()).toBeDisabled();
      await settle(current, "success");
      expect(await screen.findByText("account.verificationCodeSent")).toBeInTheDocument();
    });

    it.each(outcomes)("ignores an old confirmation that settles as %s", async (outcome) => {
      const stale = pendingEmail();
      const current = pendingEmail();
      serve(credentials.changeEmail, stale.promise, current.promise);
      const onClose = vi.fn();
      const view = render(
        <AccountSettingsDialog open onClose={onClose} user={user} initialSection={null} />,
        { wrapper: createQueryWrapper() },
      );
      await openEmailForm();
      await requestCode("old@example.test");
      await enterCode("111111");
      await userEvent.click(confirmButton());
      await retirements[retirement]?.(view, onClose);
      if (!addressField()) await openEmailForm();
      if (!addressValue()) await fillAddress("fresh@example.test");
      if (!codeField()) await userEvent.click(sendButton());
      await enterCode("222222");
      await userEvent.click(confirmButton());
      expect(credentials.changeEmail).toHaveBeenCalledTimes(2);
      await settle(stale, outcome);
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(addressField()).toBeInTheDocument();
      expect(codeField()).toHaveValue("222222");
      expect(confirmButton()).toBeDisabled();
      await settle(current, "success");
      expect(await screen.findByText("account.emailUpdated")).toBeInTheDocument();
      expect(addressField()).not.toBeInTheDocument();
    });
  });
});
