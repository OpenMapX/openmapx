// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  createQueryWrapper,
  createTestQueryClient,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@/test";

vi.mock("@/integration-api/runtime/EnvProvider", () => ({
  useEnv: () => ({ apiUrl: "http://test.local" }),
}));

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

import { SystemSettings } from "../SystemSettings";

interface TestSetting {
  group: string;
  key: string;
  label: string;
  description?: string;
  type: string;
  options?: string[];
  secret: boolean;
  value: unknown;
  source: "default" | "database" | "env";
  envVar?: string;
  envOverride: boolean;
  showWhen?: { key: string; equals: unknown };
}

// The panel renders expanded only for the "general" group, so every fixture
// uses that id to make its fields (not just the summary badge) queryable.
function mockGroup(label: string, settings: TestSetting[]) {
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ groups: [{ id: "general", label, settings }] }),
  });
}

afterEach(() => {
  fetchMock.mockReset();
});

describe("SystemSettings env-override handling", () => {
  it("shows the env-overrides badge and disables a visible env-overridden field", async () => {
    mockGroup("Data-Use Policy", [
      {
        group: "policy",
        key: "allowGreyArea",
        label: "Allow grey-area sources",
        type: "boolean",
        secret: false,
        value: true,
        source: "env",
        envVar: "OPENMAPX_ALLOW_GREY_AREA",
        envOverride: true,
      },
    ]);

    render(<SystemSettings />, { wrapper: createQueryWrapper() });

    await screen.findByText("Allow grey-area sources");
    expect(screen.queryByText("env overrides")).not.toBeNull();
    expect((screen.getByRole("switch") as HTMLInputElement).disabled).toBe(true);
  });

  it("displays the actual value of a non-secret env-overridden setting", async () => {
    mockGroup("General", [
      {
        group: "general",
        key: "instanceUrl",
        label: "Instance URL",
        type: "string",
        secret: false,
        value: "https://maps.example.com",
        source: "env",
        envVar: "PUBLIC_URL",
        envOverride: true,
      },
    ]);

    render(<SystemSettings />, { wrapper: createQueryWrapper() });

    const input = (await screen.findByLabelText("Instance URL")) as HTMLInputElement;
    expect(input.value).toBe("https://maps.example.com");
    expect(input.disabled).toBe(true);
  });

  it("does not render a secret env value in the field", async () => {
    mockGroup("Email", [
      {
        group: "email",
        key: "smtpPassword",
        label: "Password",
        type: "string",
        secret: true,
        value: "***",
        source: "env",
        envVar: "SMTP_PASS",
        envOverride: true,
      },
    ]);

    render(<SystemSettings />, { wrapper: createQueryWrapper() });

    const input = (await screen.findByLabelText("Password")) as HTMLInputElement;
    expect(input.disabled).toBe(true);
    expect(input.value).not.toBe("***");
  });
});

describe("SystemSettings focused sections", () => {
  it("renders only the settings selected for a setup section", async () => {
    mockGroup("Legal", [
      {
        group: "legal",
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
        key: "legalExportArtifactRetentionHours",
        label: "Artifact retention",
        type: "number",
        secret: false,
        value: 168,
        source: "default",
        envOverride: false,
      },
    ]);

    render(
      <SystemSettings
        sections={[
          {
            id: "operator",
            groupId: "general",
            settingKeys: ["legalControllerName"],
            label: "Operator details",
            description: "Published controller facts",
            defaultExpanded: true,
          },
        ]}
        showHeader={false}
        showTransfer={false}
      />,
      { wrapper: createQueryWrapper() },
    );

    await screen.findByRole("heading", { name: /Operator details/ });
    expect(screen.getByLabelText("Controller name")).toBeInTheDocument();
    expect(screen.queryByLabelText("Artifact retention")).not.toBeInTheDocument();
  });

  it("blocks saving malformed JSON source declarations", async () => {
    mockGroup("Legal", [
      {
        group: "legal",
        key: "legalPrivacySources",
        label: "Privacy sources",
        type: "object",
        secret: false,
        value: [],
        source: "default",
        envOverride: false,
      },
    ]);

    render(<SystemSettings />, { wrapper: createQueryWrapper() });

    const input = await screen.findByLabelText("Privacy sources");
    fireEvent.change(input, { target: { value: "[{" } });

    expect(screen.getByText("Enter valid JSON.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save Legal" })).toBeDisabled();
  });

  it("keeps the editor visible and reports a failed save", async () => {
    mockGroup("Legal", [
      {
        group: "legal",
        key: "legalControllerName",
        label: "Controller name",
        type: "string",
        secret: false,
        value: "",
        source: "default",
        envOverride: false,
      },
    ]);
    let requestCount = 0;
    fetchMock.mockImplementation(() => {
      requestCount += 1;
      return Promise.resolve(
        requestCount === 1
          ? {
              ok: true,
              json: async () => ({
                groups: [
                  {
                    id: "general",
                    label: "Legal",
                    settings: [
                      {
                        group: "legal",
                        key: "legalControllerName",
                        label: "Controller name",
                        type: "string",
                        secret: false,
                        value: "",
                        source: "default",
                        envOverride: false,
                      },
                    ],
                  },
                ],
              }),
            }
          : { ok: false, json: async () => ({ error: "invalid" }) },
      );
    });

    render(<SystemSettings />, { wrapper: createQueryWrapper() });
    const input = await screen.findByLabelText("Controller name");
    fireEvent.change(input, { target: { value: "Example GmbH" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Legal" }));

    await waitFor(() => expect(screen.getByText("Failed to save")).toBeInTheDocument());
    expect(screen.getByDisplayValue("Example GmbH")).toBeInTheDocument();
  });

  it("keeps a JSON draft and its parsed value together across unrelated rerenders", async () => {
    mockGroup("Legal", [
      {
        group: "legal",
        key: "legalPrivacySources",
        label: "Privacy sources",
        type: "object",
        secret: false,
        value: [],
        source: "default",
        envOverride: false,
      },
    ]);
    const view = render(
      <SystemSettings
        sections={[
          { id: "operator", groupId: "general", label: "Operator", defaultExpanded: true },
        ]}
        settingText={(setting) => ({ label: setting.label })}
      />,
      { wrapper: createQueryWrapper() },
    );
    const source = '[{"title":"Regulator","url":"https://example.test/privacy"}]';

    fireEvent.change(await screen.findByLabelText("Privacy sources"), {
      target: { value: source },
    });
    view.rerender(
      <SystemSettings
        sections={[
          { id: "operator", groupId: "general", label: "Operator", defaultExpanded: true },
        ]}
        settingText={(setting) => ({ label: setting.label })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Save Operator" }));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([, init]) => {
          if ((init as RequestInit | undefined)?.method !== "PATCH") return false;
          const body = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>;
          return JSON.stringify(body.legalPrivacySources) === source;
        }),
      ).toBe(true),
    );
    expect(screen.getByLabelText("Privacy sources")).toHaveValue(source);
  });

  it("updates a JSON draft when refreshed server data actually changes", async () => {
    mockGroup("Legal", [
      {
        group: "legal",
        key: "legalPrivacySources",
        label: "Privacy sources",
        type: "object",
        secret: false,
        value: [],
        source: "default",
        envOverride: false,
      },
    ]);
    const client = createTestQueryClient();
    render(<SystemSettings />, { wrapper: createQueryWrapper(client) });
    await screen.findByLabelText("Privacy sources");

    act(() => {
      client.setQueryData(["admin", "settings"], {
        groups: [
          {
            id: "general",
            label: "Legal",
            settings: [
              {
                group: "legal",
                key: "legalPrivacySources",
                label: "Privacy sources",
                type: "object",
                secret: false,
                value: [{ title: "Updated source" }],
                source: "database",
                envOverride: false,
              },
            ],
          },
        ],
      });
    });

    await waitFor(() =>
      expect(screen.getByLabelText("Privacy sources")).toHaveValue(
        JSON.stringify([{ title: "Updated source" }], null, 2),
      ),
    );
  });
});
