// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueryWrapper, render, screen } from "@/test";

vi.mock("@/lib/EnvProvider", () => ({
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
  it("hides the env-overrides badge when the only override is hidden by showWhen", async () => {
    // Mirrors the Map panel: Style Provider is DB-sourced and visible, while
    // the env-overridden MapTiler key is hidden because the provider isn't
    // "maptiler". The panel must not claim an env override the operator can't see.
    mockGroup("Map", [
      {
        group: "map",
        key: "styleProvider",
        label: "Style Provider",
        type: "select",
        options: ["maptiler", "self-hosted", "custom"],
        secret: false,
        value: "self-hosted",
        source: "database",
        envVar: "MAP_STYLE_PROVIDER",
        envOverride: false,
      },
      {
        group: "map",
        key: "maptilerApiKey",
        label: "MapTiler API Key",
        type: "string",
        secret: true,
        value: "***",
        source: "env",
        envVar: "MAPTILER_KEY",
        envOverride: true,
        showWhen: { key: "styleProvider", equals: "maptiler" },
      },
    ]);

    render(<SystemSettings />, { wrapper: createQueryWrapper() });

    await screen.findByRole("button", { name: /save map/i });
    expect(screen.queryByText("env overrides")).toBeNull();
  });

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
