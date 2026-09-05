// @vitest-environment jsdom

import { createElement } from "react";
import { expect, it, vi } from "vitest";
import { render, screen } from "@/test";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());
vi.mock("next/navigation", () => ({ usePathname: () => "/admin/privacy-setup" }));

import { AdminSidebar } from "./AdminSidebar";

it("shows privacy setup to full administrators", () => {
  render(createElement(AdminSidebar, { open: true, onClose: () => undefined, role: "admin" }));

  expect(screen.getAllByRole("link", { name: "privacySetup.navigationLabel" })[0]).toHaveAttribute(
    "href",
    "/admin/privacy-setup",
  );
});

it("does not offer privacy setup to privacy administrators", () => {
  render(
    createElement(AdminSidebar, {
      open: true,
      onClose: () => undefined,
      role: "privacy_admin",
    }),
  );

  expect(screen.queryByRole("link", { name: "privacySetup.navigationLabel" })).toBeNull();
});
