import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, userEvent, waitFor } from "@/test";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());
vi.mock("@/lib/useFullScreenOnMobile", () => ({
  mobileFullScreenDialogPaperSx: {},
  useFullScreenOnMobile: () => false,
}));
vi.mock("@/lib/useDateTimeFormat", () => ({
  useDateTimeFormat: () => ({ date: (value: Date) => value.toISOString() }),
}));
vi.mock("./MangroveAccountSection", () => ({ MangroveAccountSection: () => null }));
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
vi.mock("@openmapx/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openmapx/core")>();
  return {
    ...actual,
    authClient: {
      passkey: {
        listUserPasskeys: vi.fn().mockResolvedValue({ data: [] }),
      },
      listAccounts: vi.fn().mockResolvedValue({ data: [] }),
    },
    getInitials: () => "AT",
    oauthProviders: [],
    proxyImageUrl: (url: string) => url,
  };
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
});

describe("AccountSettingsDialog timeline targeting", () => {
  it("focuses and scrolls the stable Timeline heading after opening", async () => {
    const scrollIntoView = vi.spyOn(Element.prototype, "scrollIntoView");

    render(<AccountSettingsDialog open onClose={vi.fn()} user={user} initialSection="timeline" />);

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

    render(<AccountSettingsDialog open onClose={vi.fn()} user={user} initialSection="timeline" />);

    const heading = await screen.findByRole("heading", { name: "account.timeline.heading" });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "start", behavior: "auto" });
  });

  it("remounts Timeline settings so an A-to-B identity replacement cannot retain form secrets", async () => {
    const interaction = userEvent.setup();
    const view = render(
      <AccountSettingsDialog open onClose={vi.fn()} user={user} initialSection="timeline" />,
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
