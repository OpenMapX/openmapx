import { en } from "@openmapx/i18n";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, createQueryWrapper, render, screen, waitFor } from "@/test";
import { adminTestHistory } from "@/test/adminNavigation";
import { SettingsWorkspace } from "./SettingsWorkspace";

vi.mock(
  "next/navigation",
  async () => (await import("@/test/adminNavigation")).adminNavigationMock,
);
vi.mock("@/integration-api/runtime/EnvProvider", () => ({
  useEnv: () => ({ apiUrl: "http://api.test" }),
}));
vi.mock("./AuthPolicySettings", () => ({
  AuthPolicySettings: () => <div>Effective authentication policy</div>,
}));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const groups = ["general", "auth", "email", "map", "policy", "legal"].map((group) => ({
  id: group,
  label: group,
  settings: [
    {
      group,
      key: `${group}Field`,
      label: `${group} field`,
      value: "saved",
      type: "string",
      secret: false,
      source: "default",
      envOverride: false,
    },
  ],
}));
it.each([
  ["general", "general"],
  ["authentication", "auth"],
  ["email", "email"],
  ["map", "map"],
  ["data-use", "policy"],
] as const)("renders only the owning ordinary settings for %s", async (topic, group) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ groups })),
  );
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <SettingsWorkspace topic={topic} />
    </NextIntlClientProvider>,
    { wrapper: createQueryWrapper() },
  );
  await screen.findByLabelText(`${group} field`);
  for (const other of groups.filter((entry) => entry.id !== group))
    expect(screen.queryByLabelText(`${other.id} field`)).toBeNull();
  expect(screen.queryAllByText("Effective authentication policy")).toHaveLength(
    topic === "authentication" ? 1 : 0,
  );
  expect(screen.queryByText("Platform configuration")).toBeNull();
  expect(screen.queryByText("Export settings")).toBeNull();
});
it("reveals and focuses an addressable setting", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ groups })),
  );
  adminTestHistory.reset("/admin/settings/email?field=emailField");
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <SettingsWorkspace topic="email" />
    </NextIntlClientProvider>,
    { wrapper: createQueryWrapper() },
  );
  await waitFor(() => expect(screen.getByLabelText("email field")).toHaveFocus());
});
