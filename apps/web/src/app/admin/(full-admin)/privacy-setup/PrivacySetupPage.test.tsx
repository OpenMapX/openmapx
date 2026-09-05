// @vitest-environment jsdom

import { afterEach, expect, it, vi } from "vitest";
import { createQueryWrapper, fireEvent, render, screen, waitFor, within } from "@/test";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());
vi.mock("@/integration-api/runtime/EnvProvider", () => ({
  useEnv: () => ({ apiUrl: "http://test.local" }),
}));

import { PrivacySetupPage } from "./PrivacySetupPage";

const fetchMock = vi.fn((...args: unknown[]) => {
  const url = String(args[0]);
  if (url.endsWith("/api/admin/settings")) {
    return Promise.resolve(
      new Response(
        JSON.stringify({
          groups: [
            {
              id: "legal",
              label: "Legal",
              settings: [
                {
                  group: "legal",
                  subgroup: "operator",
                  key: "legalControllerName",
                  label: "Controller name",
                  type: "string",
                  secret: false,
                  value: "Example GmbH",
                  source: "database",
                  envOverride: false,
                },
                {
                  group: "legal",
                  subgroup: "retention",
                  key: "legalExportArtifactRetentionHours",
                  label: "Artifact retention",
                  type: "number",
                  secret: false,
                  value: 168,
                  source: "default",
                  envOverride: false,
                },
                {
                  group: "legal",
                  subgroup: "sources",
                  key: "legalPrivacySources",
                  label: "Privacy sources",
                  type: "object",
                  secret: false,
                  value: [],
                  source: "default",
                  envOverride: false,
                },
              ],
            },
            {
              id: "email",
              label: "Email",
              settings: [
                {
                  group: "email",
                  subgroup: "common",
                  key: "smtpFromAddress",
                  label: "From address",
                  type: "string",
                  secret: false,
                  value: "privacy@example.com",
                  source: "env",
                  envVar: "EMAIL_FROM",
                  envOverride: true,
                },
              ],
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  }
  if (url.endsWith("/api/privacy/admin/readiness")) {
    return Promise.resolve(
      new Response(
        JSON.stringify({
          ready: false,
          checkedAt: "2026-09-05T00:00:00.000Z",
          evidenceVersion: "v1",
          checks: [
            {
              id: "notification-health",
              status: "fail",
              detailCode: "notification-unavailable",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  }
  throw new Error(`Unexpected request: ${url}`);
});

vi.stubGlobal("fetch", fetchMock);

afterEach(() => {
  fetchMock.mockClear();
});

it("groups setup fields, preserves environment locks, and links failed readiness checks", async () => {
  render(<PrivacySetupPage />, { wrapper: createQueryWrapper() });

  expect(await screen.findByRole("heading", { name: "privacySetup.title" })).toBeInTheDocument();
  expect(
    await screen.findByRole("heading", { name: /privacySetup.steps.operator.title/ }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("heading", { name: /privacySetup.steps.notifications.title/ }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("heading", { name: /privacySetup.steps.retention.title/ }),
  ).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: /privacySetup.steps.notifications.title/ }));
  const fromAddress = await screen.findByLabelText("privacySetup.settings.smtpFromAddress.label");
  expect(fromAddress).toBeDisabled();

  expect(
    await screen.findByRole("link", {
      name: "privacySetup.readiness.checks.notification-health.action",
    }),
  ).toHaveAttribute("href", "/admin/privacy-setup#notifications");

  fireEvent.change(screen.getByLabelText("privacySetup.settings.legalControllerName.label"), {
    target: { value: "Updated GmbH" },
  });
  fireEvent.click(screen.getAllByRole("button", { name: "privacySetup.editor.save" })[0]);
  await waitFor(() =>
    expect(
      fetchMock.mock.calls.filter(([input]) =>
        String(input).endsWith("/api/privacy/admin/readiness"),
      ).length,
    ).toBeGreaterThanOrEqual(2),
  );
});

it("preserves an edited source declaration when readiness refreshes", async () => {
  render(<PrivacySetupPage />, { wrapper: createQueryWrapper() });
  fireEvent.click(
    await screen.findByRole("button", { name: /privacySetup.steps.retention.title/ }),
  );
  const source = '[{"title":"Regulator","url":"https://example.test/privacy"}]';
  const sourceEditor = await screen.findByLabelText(
    "privacySetup.settings.legalPrivacySources.label",
  );
  fireEvent.change(sourceEditor, {
    target: { value: source },
  });

  fireEvent.click(screen.getByRole("button", { name: "privacySetup.readiness.refresh" }));
  await waitFor(() =>
    expect(
      fetchMock.mock.calls.filter(([input]) =>
        String(input).endsWith("/api/privacy/admin/readiness"),
      ).length,
    ).toBeGreaterThanOrEqual(2),
  );
  expect(screen.getByLabelText("privacySetup.settings.legalPrivacySources.label")).toHaveValue(
    source,
  );

  const retentionPanel = sourceEditor.closest(".MuiAccordion-root");
  expect(retentionPanel).not.toBeNull();
  fireEvent.click(
    within(retentionPanel as HTMLElement).getByRole("button", {
      name: "privacySetup.editor.save",
    }),
  );
  await waitFor(() =>
    expect(
      fetchMock.mock.calls.some(([, init]) => {
        if ((init as RequestInit | undefined)?.method !== "PATCH") return false;
        const body = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>;
        return JSON.stringify(body.legalPrivacySources) === source;
      }),
    ).toBe(true),
  );
});
