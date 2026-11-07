import { en } from "@openmapx/i18n";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@/test";
import { AdminSidebar } from "./AdminSidebar";

vi.mock("next/navigation", () => ({ usePathname: () => "/admin/services" }));
beforeEach(() =>
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  })),
);
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
it.each(["admin", "privacy_admin"])(
  "does not expose host navigation for explicitly hosted %s",
  (role) => {
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <AdminSidebar open={true} onClose={() => {}} selfHosted={false} role={role} />
      </NextIntlClientProvider>,
    );
    expect(document.querySelector('a[href="/admin/system/services"]')).toBeNull();
    if (role === "admin") {
      expect(screen.getAllByRole("link", { name: "System" })[0]).toHaveAttribute(
        "href",
        "/admin/system/cache",
      );
    } else {
      expect(screen.queryByRole("link", { name: "System" })).toBeNull();
    }
  },
);
it("keeps privacy-admin access restricted during unknown deployment", () => {
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <AdminSidebar
        open={true}
        onClose={() => {}}
        selfHosted={null}
        {...{ role: "privacy_admin" }}
      />
    </NextIntlClientProvider>,
  );
  expect(screen.queryByRole("link", { name: "System" })).toBeNull();
  expect(screen.getAllByRole("link", { name: "Privacy" })[0]).toHaveAttribute(
    "href",
    "/admin/privacy",
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
  const close = vi.fn();
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <AdminSidebar open={true} onClose={close} selfHosted={true} />
    </NextIntlClientProvider>,
  );
  document.addEventListener("click", (event) => event.preventDefault(), { once: true });
  screen.getAllByRole("link", { name: "System" })[0].click();
  expect(close).toHaveBeenCalledTimes(1);
});
