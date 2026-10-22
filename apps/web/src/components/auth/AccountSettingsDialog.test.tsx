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
    },
    getInitials: () => "AT",
    oauthProviders: [{ providerId: "openstreetmap", name: "OpenStreetMap", icon: "/osm-logo.svg" }],
    proxyImageUrl: (url: string) => url,
  };
});

beforeEach(() => {
  for (const mock of Object.values(credentials)) mock.mockReset();
  credentials.listPasskeys.mockResolvedValue({ data: [] });
  credentials.listAccounts.mockResolvedValue({ data: [] });
  credentials.add.mockResolvedValue({ data: { id: "new-key", name: "New passkey" }, error: null });
  credentials.remove.mockResolvedValue({ data: { status: true }, error: null });
  credentials.link.mockResolvedValue({ data: { url: "/oauth", redirect: true }, error: null });
  credentials.unlink.mockResolvedValue({ data: { status: true }, error: null });
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
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
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
