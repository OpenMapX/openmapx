import { en } from "@openmapx/i18n";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@/test";
import { AdminSidebar } from "./AdminSidebar";

vi.mock("next/navigation", () => ({ usePathname: () => "/admin/system/services" }));
// jsdom lays CSS out at a fixed 1024px viewport, where only the docked desktop
// drawer is displayed; matchMedia has to agree with that layout.
const stubWide = (matches: boolean) =>
  vi.stubGlobal("matchMedia", () => ({
    matches,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
beforeEach(() => stubWide(true));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it.each([true, null])(
  "preserves troubleshooting navigation for admin deployment %s",
  (selfHosted) => {
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <AdminSidebar open={true} onClose={() => {}} selfHosted={selfHosted} />
      </NextIntlClientProvider>,
    );
    expect(screen.getAllByRole("link", { name: "System" })[0]).toHaveAttribute(
      "href",
      "/admin/system/services",
    );
  },
);
it("does not expose host navigation for an explicitly hosted administrator", () => {
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <AdminSidebar open={true} onClose={() => {}} selfHosted={false} {...{ role: "admin" }} />
    </NextIntlClientProvider>,
  );
  expect(document.querySelector('a[href="/admin/system/services"]')).toBeNull();
  expect(screen.getAllByRole("link", { name: "System" })[0]).toHaveAttribute(
    "href",
    "/admin/system/cache",
  );
});

it("shows privacy casework to full administrators", () => {
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <AdminSidebar open={true} onClose={() => {}} {...{ role: "admin" }} />
    </NextIntlClientProvider>,
  );
  expect(screen.getAllByRole("link", { name: "Privacy" })[0]).toHaveAttribute(
    "href",
    "/admin/privacy",
  );
});

it("closes mobile navigation on an ordinary destination selection", () => {
  stubWide(false);
  const close = vi.fn();
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <AdminSidebar open={true} onClose={close} selfHosted={true} />
    </NextIntlClientProvider>,
  );
  document.addEventListener("click", (event) => event.preventDefault(), { once: true });
  // The phone drawer is open, but its `display: { md: "none" }` still applies
  // at jsdom's 1024px layout viewport, so reach the link through the hidden tree.
  const drawer = document.querySelector<HTMLElement>(".MuiDrawer-modal") as HTMLElement;
  within(drawer).getByRole("link", { name: "System", hidden: true }).click();
  expect(close).toHaveBeenCalledTimes(1);
});
