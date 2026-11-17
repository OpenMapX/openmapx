import { PANEL, useMenuStore, useSidebarStore } from "@openmapx/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, userEvent } from "@/test";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());
vi.mock("next/link", () => ({
  default: ({ children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a {...props}>{children}</a>
  ),
}));
vi.mock("@/components/auth/AuthDialog", () => ({ AuthDialog: () => null }));
vi.mock("@/components/auth/useSignOut", () => ({ useSignOut: () => vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/components/pwa/InstallEntry", () => ({
  InstallEntry: () => null,
  IosInstallHintDialog: () => null,
}));
// Module evaluations and component mounts, to prove each dialog loads on first
// open and then stays mounted across close/reopen like the always-rendered one did.
const dialogLoads = vi.hoisted(() => ({ settings: 0, storage: 0 }));
const dialogMounts = vi.hoisted(() => ({ settings: 0, storage: 0 }));
vi.mock("@/components/settings/SettingsDialog", async () => {
  dialogLoads.settings += 1;
  const { useEffect } = await import("react");
  return {
    SettingsDialog: ({ open, onClose }: { open: boolean; onClose: () => void }) => {
      useEffect(() => {
        dialogMounts.settings += 1;
      }, []);
      return open ? (
        <div data-testid="settings-dialog">
          <button type="button" onClick={onClose}>
            close settings
          </button>
        </div>
      ) : null;
    },
  };
});
vi.mock("@/components/settings/StorageDialog", async () => {
  dialogLoads.storage += 1;
  const { useEffect } = await import("react");
  return {
    StorageDialog: ({ open, onClose }: { open: boolean; onClose: () => void }) => {
      useEffect(() => {
        dialogMounts.storage += 1;
      }, []);
      return open ? (
        <div data-testid="storage-dialog">
          <button type="button" onClick={onClose}>
            close storage
          </button>
        </div>
      ) : null;
    },
  };
});
vi.mock("@/lib/deepLink", () => ({ shareCurrentUrl: vi.fn() }));
vi.mock("@/lib/importGeoFile", () => ({
  IMPORT_ACCEPT: ".gpx",
  importGeoFromFile: vi.fn(),
}));

const session = { current: { data: null as unknown, isPending: false } };
const phone = vi.hoisted(() => ({ current: false }));
vi.mock("@mui/material/useMediaQuery", () => ({ default: () => phone.current }));
const parked = vi.hoisted(() => ({ current: { data: [] as unknown[] } }));
vi.mock("@openmapx/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openmapx/core")>();
  // The Parking entry is gated on a stored record; this suite is about the
  // menu, not the garage, so it stays empty unless a case says otherwise.
  return { ...actual, useSession: () => session.current, useParkedLocations: () => parked.current };
});

import { HamburgerMenu } from "./HamburgerMenu";

afterEach(() => {
  session.current = { data: null, isPending: false };
  phone.current = false;
  act(() => {
    useMenuStore.getState().close();
    useSidebarStore.getState().closeAll();
  });
});

function openMenu() {
  act(() => useMenuStore.getState().open());
  return render(<HamburgerMenu />);
}

// Kept first: a mocked module is evaluated once per file, so the "not loaded
// yet" assertion must run before any test opens a dialog. jsdom has no
// navigator.serviceWorker, so the idle warm-up never loads them here.
describe("HamburgerMenu dialogs load on first open", () => {
  beforeEach(() => {
    dialogMounts.settings = 0;
    dialogMounts.storage = 0;
  });

  it("does not load the Settings or Storage dialog before it is opened", () => {
    openMenu();
    expect(screen.getByRole("button", { name: "menu.settings" })).toBeInTheDocument();
    expect(dialogLoads).toEqual({ settings: 0, storage: 0 });
  });

  it.each([
    ["menu.settings", "settings-dialog", "close settings", "settings"],
    ["menu.storage", "storage-dialog", "close storage", "storage"],
  ] as const)(
    "opens %s on first click and keeps one instance across close and reopen",
    async (row, testId, closeLabel, key) => {
      const user = userEvent.setup();
      openMenu();
      await user.click(screen.getByRole("button", { name: row }));
      expect(useMenuStore.getState().isOpen).toBe(false);
      expect(await screen.findByTestId(testId)).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: closeLabel }));
      expect(screen.queryByTestId(testId)).toBeNull();

      act(() => useMenuStore.getState().open());
      await user.click(await screen.findByRole("button", { name: row }));
      expect(await screen.findByTestId(testId)).toBeInTheDocument();
      expect(dialogLoads[key]).toBe(1);
      expect(dialogMounts[key]).toBe(1);
    },
  );
});

describe("HamburgerMenu personal timeline navigation", () => {
  it("hides Your timeline while signed out or while session identity is pending", () => {
    const { rerender } = openMenu();
    expect(screen.queryByRole("button", { name: "menu.timeline" })).toBeNull();

    session.current = { data: { user: { id: "user-a" } }, isPending: true };
    rerender(<HamburgerMenu />);
    expect(screen.queryByRole("button", { name: "menu.timeline" })).toBeNull();
  });

  it("shows Your timeline to a settled signed-in user even without connection state", () => {
    session.current = { data: { user: { id: "user-a" } }, isPending: false };
    openMenu();

    expect(screen.getByRole("button", { name: "menu.timeline" })).toBeVisible();
  });

  it("opens the timeline sidebar and closes the menu on click", async () => {
    session.current = { data: { user: { id: "user-a" } }, isPending: false };
    const user = userEvent.setup();
    openMenu();

    await user.click(screen.getByRole("button", { name: "menu.timeline" }));

    expect(useSidebarStore.getState().activeSidebarId).toBe(PANEL.TIMELINE);
    expect(useMenuStore.getState().isOpen).toBe(false);
  });

  it.each(["{Enter}", " "])("supports keyboard activation with %s", async (key) => {
    session.current = { data: { user: { id: "user-a" } }, isPending: false };
    const user = userEvent.setup();
    openMenu();
    const item = screen.getByRole("button", { name: "menu.timeline" });
    item.focus();

    await user.keyboard(key);

    expect(useSidebarStore.getState().activeSidebarId).toBe(PANEL.TIMELINE);
    expect(useMenuStore.getState().isOpen).toBe(false);
  });
});

describe("HamburgerMenu on a phone, where the avatar opens it", () => {
  it("leads with signing in while signed out", () => {
    phone.current = true;
    openMenu();
    expect(screen.getByRole("button", { name: "map.signIn" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "account.signOut" })).toBeNull();
  });

  it("names the account and offers its settings and signing out", () => {
    phone.current = true;
    session.current = {
      data: { user: { id: "user-a", name: "Ada Lovelace", email: "ada@example.test" } },
      isPending: false,
    };
    openMenu();
    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "account.accountSettings" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "account.signOut" })).toBeInTheDocument();
  });

  it("keeps the desktop menu free of the account, which has its own avatar menu", () => {
    session.current = { data: { user: { id: "user-a", name: "Ada" } }, isPending: false };
    openMenu();
    expect(screen.queryByText("Ada")).toBeNull();
    expect(screen.queryByRole("button", { name: "account.signOut" })).toBeNull();
  });
});
