jest.mock("expo-speech-recognition", () => ({
  ExpoSpeechRecognitionModule: { supportsOnDeviceRecognition: jest.fn(() => false) },
}));

const mockNavigation = { dispose: jest.fn() };
const mockCreateForegroundNavigation = jest.fn();
jest.mock("../navigation/createForegroundNavigation", () => ({
  createForegroundNavigation: (...args: unknown[]) => mockCreateForegroundNavigation(...args),
}));

import { AccessibilityInfo } from "react-native";
import type { MobileRuntimeConfig } from "../config/runtimeConfig";
import { VoiceInputController } from "../voice/VoiceInputController";
import { createShellRuntime } from "./createShellRuntime";

const CONFIG: MobileRuntimeConfig = {
  release: true,
  feasibilityMode: false,
  webOrigin: "https://openmapx.com",
  apiOrigin: "https://openmapx.com",
  webHost: "openmapx.com",
  appId: "org.openmapx.app",
  scheme: "openmapx",
};

function compose(config: MobileRuntimeConfig = CONFIG) {
  return createShellRuntime({
    config,
    locale: "en",
    inject: () => undefined,
    isAppActive: () => true,
    onNavigatingChanged: () => undefined,
    onSessionEnded: () => undefined,
  });
}

beforeEach(() => {
  mockNavigation.dispose.mockReset();
  mockCreateForegroundNavigation.mockReset();
  mockCreateForegroundNavigation.mockResolvedValue(mockNavigation);
});

describe("createShellRuntime", () => {
  it("disposes what it composed once, however often it is asked", async () => {
    const remove = jest.fn();
    const listen = () => ({ remove });
    // The runtime subscribes to one event and only ever removes the subscription.
    jest
      .spyOn(AccessibilityInfo, "addEventListener")
      .mockImplementation(listen as unknown as typeof AccessibilityInfo.addEventListener);
    const cancel = jest
      .spyOn(VoiceInputController.prototype, "cancel")
      .mockImplementation(() => {});
    const runtime = compose();
    await runtime.navigation;

    runtime.dispose();
    runtime.dispose();
    await runtime.navigation;

    expect(remove).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(mockNavigation.dispose).toHaveBeenCalledTimes(1);
  });

  it("composes no navigation graph for a feasibility build", async () => {
    const runtime = compose({ ...CONFIG, feasibilityMode: true });

    expect(await runtime.navigation).toBeNull();
    expect(mockCreateForegroundNavigation).not.toHaveBeenCalled();
    runtime.dispose();
  });

  it("reports a navigation graph that failed to compose as none", async () => {
    mockCreateForegroundNavigation.mockRejectedValue(new Error("no native modules"));
    const runtime = compose();

    expect(await runtime.navigation).toBeNull();
    runtime.dispose();
  });
});
