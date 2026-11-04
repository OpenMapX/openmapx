jest.mock("react-native", () => ({ AppRegistry: { registerHeadlessTask: jest.fn() } }));
jest.mock("../config/runtimeConfig", () => ({
  getRuntimeConfig: () => ({ webOrigin: "https://example.com", apiOrigin: "https://example.com" }),
}));
jest.mock("../shell/shellCopy", () => ({ deviceMobileLocale: () => "de" }));
jest.mock("../bridge/receiveCarDestinations", () => ({ readCarDestinations: async () => null }));
jest.mock("../navigation/createCoordinator", () => ({
  getSharedCoordinatorCore: async () => ({ repository: { loadActive: async () => null } }),
}));
jest.mock("../navigation/createForegroundNavigation", () => ({
  createForegroundNavigation: jest.fn(),
}));
jest.mock("./CarCommands", () => ({
  CarCommands: jest.fn(() => ({ handle: async () => false, disconnect: jest.fn() })),
}));
jest.mock("./publishCarState", () => ({ publishCarState: async () => {} }));
jest.mock("./testDrive", () => ({ stopTestDrive: async () => {}, startTestDrive: async () => {} }));
jest.mock("./nativeCar", () => ({ nativeCar: jest.fn() }));

import { createForegroundNavigation } from "../navigation/createForegroundNavigation";
import { registerForegroundCoordinator } from "../navigation/foregroundCoordinator";
import type { NavigationCoordinator } from "../navigation/NavigationCoordinator";
import { startCarRuntime } from "./carRuntime";
import { nativeCar } from "./nativeCar";

it("uses the phone composition without constructing another chain and resolves on detach", async () => {
  const unregister = registerForegroundCoordinator({} as NavigationCoordinator);
  let listener: ((event: { command: string }) => void) | undefined;
  const remove = jest.fn();
  const native = {
    configure: jest.fn(),
    runtimeReady: jest.fn(),
    isConnected: async () => true,
    attach: async () => {
      listener?.({ command: "detach" });
    },
    detach: jest.fn(),
    acknowledge: jest.fn(),
    addListener: (_name: string, fn: typeof listener) => {
      listener = fn;
      return { remove };
    },
  };
  (nativeCar as jest.Mock).mockReturnValue(native);
  await startCarRuntime();
  expect(createForegroundNavigation).not.toHaveBeenCalled();
  expect(native.configure).toHaveBeenCalledWith("https://example.com", "de", "metric");
  expect(native.detach).toHaveBeenCalledTimes(1);
  expect(remove).toHaveBeenCalledTimes(1);
  unregister();
});
it("composes once without an Activity and disposes the car chain when the phone takes over", async () => {
  let listener: ((event: { command: string }) => void) | undefined;
  let ready: () => void = () => {};
  const attached = new Promise<void>((resolve) => {
    ready = resolve;
  });
  let wasDisposed: () => void = () => {};
  const disposed = new Promise<void>((resolve) => {
    wasDisposed = resolve;
  });
  const dispose = jest.fn(() => wasDisposed());
  (createForegroundNavigation as jest.Mock).mockResolvedValue({ coordinator: {}, dispose });
  const native = {
    configure: jest.fn(),
    runtimeReady: jest.fn(),
    isConnected: async () => true,
    attach: async () => ready(),
    detach: jest.fn(),
    acknowledge: jest.fn(),
    addListener: (_name: string, fn: typeof listener) => {
      listener = fn;
      return { remove: jest.fn() };
    },
  };
  (nativeCar as jest.Mock).mockReturnValue(native);
  const task = startCarRuntime();
  await attached;
  const duplicate = startCarRuntime();
  expect(createForegroundNavigation).toHaveBeenCalledTimes(1);
  const unregister = registerForegroundCoordinator({} as NavigationCoordinator);
  await disposed;
  expect(dispose).toHaveBeenCalledTimes(1);
  listener?.({ command: "detach" });
  await Promise.all([task, duplicate]);
  expect(dispose).toHaveBeenCalledTimes(1);
  unregister();
});
