import { en } from "@openmapx/i18n";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, createQueryWrapper, fireEvent, render, screen } from "@/test";
import { AdminLayout } from "./AdminLayout";

vi.mock("@/integration-api/runtime/EnvProvider", () => ({
  useEnv: () => ({ apiUrl: "http://admin.test" }),
}));
vi.mock(
  "next/navigation",
  async () => (await import("@/test/adminNavigation")).adminNavigationMock,
);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("keeps the desktop sidebar preference independent of mobile drawer navigation", () => {
  let wide = true;
  const listeners = new Set<() => void>();
  vi.stubGlobal("matchMedia", () => ({
    get matches() {
      return wide;
    },
    addEventListener: (_name: string, fn: () => void) => {
      listeners.add(fn);
    },
    removeEventListener: (_name: string, fn: () => void) => {
      listeners.delete(fn);
    },
  }));
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <AdminLayout
        user={{ id: "admin", name: "Example", email: "admin@example.test", role: "admin" }}
        selfHosted={true}
      >
        <div>Page</div>
      </AdminLayout>
    </NextIntlClientProvider>,
    { wrapper: createQueryWrapper() },
  );
  const toggle = screen.getByRole("button", { name: "Toggle navigation" });
  expect(toggle).toHaveAttribute("aria-expanded", "true");
  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  act(() => {
    wide = false;
    for (const listener of listeners) listener();
  });
  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute("aria-expanded", "true");
  const link = screen.getAllByRole("link", { name: "Overview" })[0];
  document.addEventListener("click", (event) => event.preventDefault(), { once: true });
  fireEvent.click(link);
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  act(() => {
    wide = true;
    for (const listener of listeners) listener();
  });
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute("aria-expanded", "true");
  act(() => {
    wide = false;
    for (const listener of listeners) listener();
  });
  expect(toggle).toHaveAttribute("aria-expanded", "false");
});
