import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@/test";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());
vi.mock("@/lib/useFullScreenOnMobile", () => ({
  mobileFullScreenDialogPaperSx: {},
  useFullScreenOnMobile: () => false,
}));
vi.mock("@/lib/useDateTimeFormat", () => ({
  useDateTimeFormat: () => ({ date: (value: Date) => value.toISOString() }),
}));
vi.mock("./MangroveAccountSection", () => ({ MangroveAccountSection: () => null }));
vi.mock("./TimelineConnectionSection", async () => {
  const { forwardRef } = await import("react");
  return {
    TimelineConnectionSection: forwardRef<HTMLHeadingElement>(function TimelineSection(_, ref) {
      return (
        <h2 ref={ref} id="account-timeline-heading" tabIndex={-1}>
          account.timeline.heading
        </h2>
      );
    }),
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
});
