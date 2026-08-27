import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, userEvent, waitFor } from "@/test";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

const signOut = vi.fn();
const clearKeypair = vi.fn();
const removeQueries = vi.fn();

vi.mock("@openmapx/core", () => ({
  authClient: { signOut },
  getInitials: () => "AA",
  proxyImageUrl: (url: string) => url,
}));
vi.mock("@openmapx/mangrove-react", () => ({
  MANGROVE_KEYPAIR_QUERY_KEY: ["mangrove-keypair"],
  useKeypairStore: { getState: () => ({ clear: clearKeypair }) },
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ removeQueries }),
}));
beforeEach(() => {
  vi.clearAllMocks();
  signOut.mockResolvedValue(undefined);
});

describe("AccountMenu sign-out", () => {
  it("clears in-memory secrets before signing out", async () => {
    const { AccountMenu } = await import("./AccountMenu");
    const user = userEvent.setup();

    render(
      <AccountMenu
        anchorEl={document.body}
        onClose={vi.fn()}
        user={{
          id: "user-a",
          name: "Ada",
          email: "ada@example.test",
          emailVerified: true,
          createdAt: new Date("2026-08-24T00:00:00Z"),
          updatedAt: new Date("2026-08-24T00:00:00Z"),
          twoFactorEnabled: false,
          role: "user",
          banned: false,
          banReason: null,
          banExpires: null,
        }}
        onOpenSettings={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("menuitem", { name: "account.signOut" }));
    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1));
    expect(clearKeypair).toHaveBeenCalledTimes(1);
    expect(removeQueries).toHaveBeenCalledWith({ queryKey: ["mangrove-keypair"] });
  });
});
