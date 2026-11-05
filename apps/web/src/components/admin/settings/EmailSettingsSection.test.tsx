import { afterEach, expect, it, vi } from "vitest";
import { cleanup, createQueryWrapper, fireEvent, render, screen, waitFor } from "@/test";
import { savedEmailProvider } from "./EmailSettingsSection";
import { SystemSettings } from "./SystemSettings";

vi.mock("@/integration-api/runtime/EnvProvider", () => ({
  useEnv: () => ({ apiUrl: "http://api.test" }),
}));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const fields = [
  ["smtpFromAddress", "common", "From Address", "sender@example.test", false],
  ["emailLabsAppKey", "emaillabs", "App Key", "***", true],
  ["emailLabsSecretKey", "emaillabs", "Secret Key", "***", true],
  ["emailLabsSmtpAccount", "emaillabs", "SMTP Account", "account", false],
  ["lettermintApiToken", "lettermint", "API Token", "***", true],
  ["smtpHost", "smtp", "Host", "smtp.example.test", false],
].map(([key, subgroup, label, value, secret]) => ({
  group: "email",
  key,
  subgroup,
  label,
  value,
  secret,
  type: "string",
  source: "database",
  envOverride: false,
}));
function mount(focusKey?: string) {
  const fetch = vi.fn(async (_input: unknown, init: unknown) =>
    (init as RequestInit | undefined)?.method === "PATCH"
      ? Response.json({ ok: true })
      : Response.json({ groups: [{ id: "email", label: "Email", settings: fields }] }),
  );
  vi.stubGlobal("fetch", fetch);
  render(
    <SystemSettings
      showHeader={false}
      showTransfer={false}
      focusKey={focusKey}
      sections={[{ id: "email", groupId: "email", label: "Email", defaultExpanded: true }]}
    />,
    { wrapper: createQueryWrapper() },
  );
  return fetch;
}
it("keeps the existing provider priority without an exclusive provider setting", () => {
  expect(
    savedEmailProvider({
      emailLabsAppKey: "***",
      emailLabsSecretKey: "***",
      emailLabsSmtpAccount: "account",
      lettermintApiToken: "***",
    }),
  ).toBe("emaillabs");
  expect(
    savedEmailProvider({
      emailLabsAppKey: "***",
      emailLabsSecretKey: "***",
      lettermintApiToken: "***",
    }),
  ).toBe("lettermint");
  expect(savedEmailProvider({})).toBe("smtp");
});
it("opens a collapsed SMTP provider and focuses its search result", async () => {
  mount("smtpHost");
  await waitFor(() => expect(screen.getByLabelText("Host")).toHaveFocus());
  expect(screen.getByText(/Saved provider: EmailLabs/)).toBeInTheDocument();
});
it("preserves explicit edits when a provider closes and skips unchanged masked credentials", async () => {
  const fetch = mount();
  fireEvent.change(await screen.findByLabelText("App Key"), { target: { value: "typed-key" } });
  fireEvent.click(screen.getByText("EmailLabs (priority 1)"));
  fireEvent.click(screen.getByRole("button", { name: "Save Email" }));
  await waitFor(() =>
    expect(
      fetch.mock.calls.some((call) => (call[1] as RequestInit | undefined)?.method === "PATCH"),
    ).toBe(true),
  );
  const request = fetch.mock.calls.find(
    (call) => (call[1] as RequestInit | undefined)?.method === "PATCH",
  );
  expect(JSON.parse(String((request?.[1] as RequestInit).body))).toEqual({
    emailLabsAppKey: "typed-key",
  });
});
