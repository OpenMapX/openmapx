import { useNavigationStore } from "@openmapx/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

const runtime = vi.hoisted(() => ({
  browserAuthority: false,
  commands: { updateSettings: vi.fn(async () => undefined) },
}));

vi.mock("@/lib/mobile/MobileRuntimeProvider", () => ({
  useMobileRuntimeContext: () => runtime,
}));

import { PreferencesClient } from "./PreferencesClient";

const voiceSwitch = () => screen.getByRole("switch", { name: /settings\.voiceGuidance / });
const screenSwitch = () => screen.getByRole("switch", { name: /settings\.keepScreenOn / });

describe("PreferencesClient during an installed-app trip", () => {
  const initial = useNavigationStore.getState();
  beforeEach(() => {
    runtime.browserAuthority = false;
    runtime.commands.updateSettings.mockClear();
    useNavigationStore.setState({
      voiceEnabled: true,
      keepScreenOn: true,
      nativeSessionId: "trip-1",
    });
  });
  afterEach(() => {
    useNavigationStore.setState({
      voiceEnabled: initial.voiceEnabled,
      keepScreenOn: initial.keepScreenOn,
      nativeSessionId: initial.nativeSessionId,
    });
  });

  it("sends voice and keep-screen-on changes to the native session", async () => {
    render(<PreferencesClient />);

    fireEvent.click(voiceSwitch());
    fireEvent.click(screenSwitch());

    expect(useNavigationStore.getState()).toMatchObject({
      voiceEnabled: false,
      keepScreenOn: false,
    });
    expect(runtime.commands.updateSettings).toHaveBeenCalledWith({ voiceEnabled: false });
    expect(runtime.commands.updateSettings).toHaveBeenCalledWith({ keepScreenOn: false });
  });

  it("sends a change made before the page has seen the session", () => {
    useNavigationStore.setState({ nativeSessionId: null });
    render(<PreferencesClient />);

    fireEvent.click(voiceSwitch());

    expect(useNavigationStore.getState().voiceEnabled).toBe(false);
    expect(runtime.commands.updateSettings).toHaveBeenCalledWith({ voiceEnabled: false });
  });

  it("only stores the preference in a browser", () => {
    runtime.browserAuthority = true;
    render(<PreferencesClient />);

    fireEvent.click(screenSwitch());

    expect(useNavigationStore.getState().keepScreenOn).toBe(false);
    expect(runtime.commands.updateSettings).not.toHaveBeenCalled();
  });
});
