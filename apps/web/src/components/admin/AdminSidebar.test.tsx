import { en } from "@openmapx/i18n";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@/test";
import { AdminSidebar } from "./AdminSidebar";

vi.mock("next/navigation", () => ({ usePathname: () => "/admin/services" }));
afterEach(cleanup);
it.each([true, null])(
  "preserves troubleshooting navigation for admin deployment %s",
  (selfHosted) => {
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <AdminSidebar open={true} onClose={() => {}} selfHosted={selfHosted} />
      </NextIntlClientProvider>,
    );
    expect(screen.getAllByText("Services").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Maintenance").length).toBeGreaterThan(0);
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
    expect(screen.queryByText("Services")).not.toBeInTheDocument();
    expect(screen.queryByText("Maintenance")).not.toBeInTheDocument();
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
  expect(screen.queryByText("Services")).not.toBeInTheDocument();
  expect(screen.queryByText("Maintenance")).not.toBeInTheDocument();
});

it("shows privacy setup to full administrators", () => {
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <AdminSidebar open={true} onClose={() => {}} {...{ role: "admin" }} />
    </NextIntlClientProvider>,
  );
  expect(screen.getAllByRole("link", { name: "Privacy setup" })[0]).toHaveAttribute(
    "href",
    "/admin/privacy-setup",
  );
});
it("does not offer privacy setup to privacy administrators", () => {
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <AdminSidebar open={true} onClose={() => {}} {...{ role: "privacy_admin" }} />
    </NextIntlClientProvider>,
  );
  expect(screen.queryByRole("link", { name: "Privacy setup" })).toBeNull();
});
