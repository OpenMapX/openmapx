import { PANEL, useMenuStore, useSidebarStore } from "@openmapx/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, userEvent } from "@/test";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());
vi.mock("next/link", () => ({
  default: ({ children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a {...props}>{children}</a>
  ),
}));
vi.mock("@/components/auth/AuthDialog", () => ({ AuthDialog: () => null }));
vi.mock("@/components/pwa/InstallEntry", () => ({
  InstallEntry: () => null,
  IosInstallHintDialog: () => null,
}));
vi.mock("@/components/settings/SettingsDialog", () => ({ SettingsDialog: () => null }));
vi.mock("@/components/settings/StorageDialog", () => ({ StorageDialog: () => null }));
vi.mock("@/lib/deepLink", () => ({ shareCurrentUrl: vi.fn() }));
vi.mock("@/lib/importGeoFile", () => ({
  IMPORT_ACCEPT: ".gpx",
  importGeoFromFile: vi.fn(),
}));

const session = { current: { data: null as unknown, isPending: false } };
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
  act(() => {
    useMenuStore.getState().close();
    useSidebarStore.getState().closeAll();
  });
});

function openMenu() {
  act(() => useMenuStore.getState().open());
  return render(<HamburgerMenu />);
}

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
