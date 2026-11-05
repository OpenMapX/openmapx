import { en } from "@openmapx/i18n";
import { NextIntlClientProvider } from "next-intl";
import { useContext } from "react";
import { afterEach, expect, it, vi } from "vitest";
import {
  AdminDraftContext,
  AdminDraftProvider,
  useBindAdminDraftOwner,
} from "@/lib/admin/AdminDraftProvider";
import { cleanup, createQueryWrapper, fireEvent, render, screen, waitFor } from "@/test";
import { adminTestHistory } from "@/test/adminNavigation";
import { AdminSearch } from "./AdminSearch";

vi.mock(
  "next/navigation",
  async () => (await import("@/test/adminNavigation")).adminNavigationMock,
);
vi.mock("@/integration-api/runtime/EnvProvider", () => ({
  useEnv: () => ({ apiUrl: "http://api.test" }),
}));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function mount(role = "admin") {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <AdminSearch role={role} actorId="actor-a" selfHosted={true} />
    </NextIntlClientProvider>,
    { wrapper: createQueryWrapper() },
  );
}
it("loads metadata only on open and navigates by keyboard without executing an operation", async () => {
  const fetch = vi.fn(async (input: unknown) =>
    String(input).endsWith("/settings")
      ? Response.json({
          groups: [
            {
              settings: [
                { group: "email", key: "smtpHost", label: "SMTP host", value: "private-host" },
              ],
            },
          ],
        })
      : Response.json({ error: "unavailable" }, { status: 503 }),
  );
  vi.stubGlobal("fetch", fetch);
  adminTestHistory.reset("/admin");
  const navigate = vi.spyOn(adminTestHistory, "push");
  mount();
  expect(fetch).not.toHaveBeenCalled();
  fireEvent.keyDown(window, { key: "k", ctrlKey: true });
  const input = await screen.findByRole("combobox");
  fireEvent.change(input, { target: { value: "SMTP host" } });
  await screen.findByRole("option", { name: /SMTP host/ });
  fireEvent.keyDown(input, { key: "ArrowDown" });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() =>
    expect(navigate).toHaveBeenCalledWith("/admin/settings/email?field=smtpHost"),
  );
  expect(
    fetch.mock.calls.every(
      (call) => call.length === 1 || !call[1] || (call[1] as RequestInit).method !== "POST",
    ),
  ).toBe(true);
  expect(screen.queryByText("private-host")).toBeNull();
});
it("offers no search or metadata requests for a privacy administrator", () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  mount("privacy_admin");
  fireEvent.keyDown(window, { key: "k", ctrlKey: true });
  expect(screen.queryByRole("combobox")).toBeNull();
  expect(screen.queryByRole("button", { name: "Search administration" })).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});
it("removes search before requesting metadata after a confirmed role change", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  function Shell() {
    useBindAdminDraftOwner({ apiUrl: "http://api.test", actorId: "actor-a", role: "admin" });
    const store = useContext(AdminDraftContext);
    return (
      <>
        <button
          type="button"
          onClick={() =>
            store?.observeSession({
              data: {
                user: { id: "actor-a", role: "privacy_admin" },
                session: { id: "session-a" },
              },
              isPending: false,
            })
          }
        >
          Change role
        </button>
        <AdminSearch {...{ role: "admin" }} actorId="actor-a" selfHosted={true} />
      </>
    );
  }
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <AdminDraftProvider>
        <Shell />
      </AdminDraftProvider>
    </NextIntlClientProvider>,
    { wrapper: createQueryWrapper() },
  );
  expect(await screen.findByRole("button", { name: "Search administration" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Change role" }));
  fireEvent.keyDown(window, { key: "k", ctrlKey: true });
  expect(screen.queryByRole("button", { name: "Search administration" })).toBeNull();
  expect(screen.queryByRole("combobox")).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});
