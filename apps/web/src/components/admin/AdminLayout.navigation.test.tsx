import { en } from "@openmapx/i18n";
import { NextIntlClientProvider } from "next-intl";
import { useContext } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { AdminDraftContext, AdminDraftProvider } from "@/lib/admin/AdminDraftProvider";
import { act, cleanup, createQueryWrapper, fireEvent, render, screen } from "@/test";
import { adminTestHistory } from "@/test/adminNavigation";
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
it.each([false, null])("guards direct host-topic entry for deployment %s", (selfHosted) => {
  adminTestHistory.reset("/admin/system/deployment");
  vi.stubGlobal("matchMedia", () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  }));
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <AdminLayout
        user={{ id: "admin", name: "Example", email: "admin@example.test", role: "admin" }}
        selfHosted={selfHosted}
      >
        <button type="button">Host mutation</button>
      </AdminLayout>
    </NextIntlClientProvider>,
    { wrapper: createQueryWrapper() },
  );
  if (selfHosted === false) {
    expect(screen.queryByRole("button", { name: "Host mutation" })).toBeNull();
    expect(screen.getAllByRole("link", { name: "Cache" }).length).toBeGreaterThan(0);
  } else expect(screen.getByRole("button", { name: "Host mutation" })).toBeInTheDocument();
});
it("retires the admin view and navigation after a confirmed authority change", async () => {
  function Child() {
    const store = useContext(AdminDraftContext);
    return (
      <button
        type="button"
        onClick={() =>
          store?.observeSession({
            data: { user: { id: "admin", role: "privacy_admin" }, session: { id: "session" } },
            isPending: false,
          })
        }
      >
        Change authority
      </button>
    );
  }
  vi.stubGlobal("matchMedia", () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  }));
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <AdminDraftProvider>
        <AdminLayout
          user={{ id: "admin", name: "Example", email: "admin@example.test", role: "admin" }}
          selfHosted={true}
        >
          <Child />
        </AdminLayout>
      </AdminDraftProvider>
    </NextIntlClientProvider>,
    { wrapper: createQueryWrapper() },
  );
  fireEvent.click(await screen.findByRole("button", { name: "Change authority" }));
  expect(screen.queryByRole("button", { name: "Change authority" })).toBeNull();
  expect(screen.queryByRole("link", { name: "System" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Administration jobs" })).toBeNull();
  expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
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

it("server-renders the desktop sidebar open without a hydration width shift", () => {
  const Wrapper = createQueryWrapper();
  const markup = renderToStaticMarkup(
    <Wrapper>
      <NextIntlClientProvider locale="en" messages={en}>
        <AdminLayout
          user={{ id: "admin", name: "Example", email: "admin@example.test", role: "admin" }}
          selfHosted={true}
        >
          <div>Page</div>
        </AdminLayout>
      </NextIntlClientProvider>
    </Wrapper>,
  );
  expect(markup).toContain('aria-expanded="true"');
});
