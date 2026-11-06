// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminDraftProvider, useBindAdminDraftOwner } from "@/lib/admin/AdminDraftProvider";
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

// These editor fixtures own settings responses, not a live browser session.
// Keep BetterAuth's delayed session cleanup outside their jsdom lifecycle.
vi.mock("@openmapx/core", async () => ({
  ...(await vi.importActual<typeof import("@openmapx/core")>("@openmapx/core")),
  authClient: { useSession: () => ({ data: null }), admin: {} },
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
      client.setQueriesData(
        { queryKey: ["admin", "settings"] },
        {
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
        },
      );
    });

    await waitFor(() =>
      expect(screen.getByLabelText("Privacy sources")).toHaveValue(
        JSON.stringify([{ title: "Updated source" }], null, 2),
      ),
    );
  });
});

describe("configured secret preservation", () => {
  it("omits an unchanged redacted key when saving the provider", async () => {
    mockGroup("Map", [
      {
        group: "map",
        key: "maptilerApiKey",
        label: "MapTiler API Key",
        type: "string",
        secret: true,
        value: "***",
        source: "database",
        envOverride: false,
      },
      {
        group: "map",
        key: "hostedBasemapProvider",
        label: "Hosted Vector Basemap",
        type: "select",
        options: ["auto", "openfreemap", "maptiler"],
        secret: false,
        value: "openfreemap",
        source: "database",
        envOverride: false,
      },
    ]);
    render(<SystemSettings />, { wrapper: createQueryWrapper() });
    await screen.findByLabelText("MapTiler API Key");
    fireEvent.mouseDown(screen.getByRole("combobox"));
    fireEvent.click(await screen.findByRole("option", { name: "maptiler" }));
    fireEvent.click(screen.getByRole("button", { name: "Save Map" }));
    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(
        ([, init]) => (init as RequestInit | undefined)?.method === "PATCH",
      );
      expect(patch).toBeDefined();
      expect(JSON.parse(String((patch?.[1] as RequestInit).body))).toEqual({
        hostedBasemapProvider: "maptiler",
      });
    });
  });
});

it("keeps another administrator's clean field while saving only the dirty key", async () => {
  const settings = [
    {
      group: "general",
      key: "instanceName",
      label: "Instance Name",
      type: "string",
      secret: false,
      value: "old name",
      source: "database" as const,
      envOverride: false,
    },
    {
      group: "general",
      key: "instanceUrl",
      label: "Instance URL",
      type: "string",
      secret: false,
      value: "https://old.test",
      source: "database" as const,
      envOverride: false,
    },
  ];
  mockGroup("General", settings);
  const client = createTestQueryClient();
  render(<SystemSettings showTransfer={false} />, { wrapper: createQueryWrapper(client) });
  fireEvent.change(await screen.findByLabelText("Instance Name"), { target: { value: "mine" } });
  act(() =>
    client.setQueriesData(
      { queryKey: ["admin", "settings"] },
      {
        groups: [
          {
            id: "general",
            label: "General",
            settings: [settings[0], { ...settings[1], value: "https://other.test" }],
          },
        ],
      },
    ),
  );
  expect(screen.getByLabelText("Instance Name")).toHaveValue("mine");
  await waitFor(() =>
    expect(screen.getByLabelText("Instance URL")).toHaveValue("https://other.test"),
  );
  fireEvent.click(screen.getByRole("button", { name: "Save General" }));
  await waitFor(() => {
    const call = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === "PATCH",
    );
    expect(call).toBeDefined();
    expect(JSON.parse(String((call?.[1] as RequestInit | undefined)?.body))).toEqual({
      instanceName: "mine",
    });
  });
});

it("shares legal edits with another settings destination while disposing typed secrets", async () => {
  const settings = [
    {
      group: "general",
      key: "controller",
      label: "Controller",
      type: "string",
      secret: false,
      value: "saved controller",
      source: "database" as const,
      envOverride: false,
    },
    {
      group: "general",
      key: "password",
      label: "Password",
      type: "string",
      secret: true,
      value: "***",
      source: "database" as const,
      envOverride: false,
    },
    {
      group: "general",
      key: "instanceName",
      label: "Instance Name",
      type: "string",
      secret: false,
      value: "saved name",
      source: "database" as const,
      envOverride: false,
    },
  ];
  mockGroup("General", settings);
  const view = (topic: string) => (
    <AdminDraftProvider>
      <BoundSettings topic={topic} />
    </AdminDraftProvider>
  );
  const { rerender } = render(view("privacy"), { wrapper: createQueryWrapper() });
  fireEvent.change(await screen.findByLabelText("Controller"), {
    target: { value: "draft controller" },
  });
  fireEvent.change(screen.getByLabelText("Password"), {
    target: { value: "synthetic typed secret" },
  });
  rerender(view("settings"));
  await waitFor(() => expect(screen.getByLabelText("Controller")).toHaveValue("draft controller"));
  expect(screen.getByLabelText("Password")).not.toHaveValue("synthetic typed secret");
  expect(screen.getByLabelText("Instance Name")).toHaveValue("saved name");
});
function BoundSettings({ topic }: { topic: string }) {
  useBindAdminDraftOwner({ apiUrl: "http://test.local", actorId: "admin", role: "admin" });
  return (
    <SystemSettings
      key={topic}
      showTransfer={false}
      sections={
        topic === "privacy"
          ? [
              {
                id: "legal",
                groupId: "general",
                settingKeys: ["controller", "password"],
                label: "Legal",
                defaultExpanded: true,
              },
            ]
          : undefined
      }
    />
  );
}
