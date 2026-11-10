import { MOBILE_PROTOCOL_MAX, type WebToNativeMessage } from "@openmapx/core/navigation";
import type { LocationDriver } from "../location/LocationDriver";
import { withPermissionPrompt } from "../permissions/permissionPromptLock";
import { createShellServices } from "./shellServices";

const locationRequest = {
  protocolVersion: MOBILE_PROTOCOL_MAX,
  messageId: "m-1",
  channelNonce: "nonce",
  sentAtMs: 1,
  type: "location.request",
  payload: { requestId: "fix-1", accuracy: "precise", timeoutMs: 10_000, maxAgeMs: 15_000 },
} as WebToNativeMessage;

describe("createShellServices", () => {
  it("waits for a prompt already showing before asking for location", async () => {
    const requestForegroundPermission = jest.fn(async () => "foreground" as const);
    const driver = {
      getPermissionState: async () => "not-determined" as const,
      requestForegroundPermission,
      getCurrentFix: async () => null,
    } as unknown as LocationDriver;
    const services = createShellServices({
      config: { webOrigin: "https://openmapx.test" },
      isAppActive: () => true,
      driver,
    });
    let releaseStartPrompt: () => void = () => {};
    const startPrompt = withPermissionPrompt(
      () =>
        new Promise<void>((resolve) => {
          releaseStartPrompt = resolve;
        }),
    );

    const answer = services.auxiliary(locationRequest);
    await new Promise((resolve) => setImmediate(resolve));
    expect(requestForegroundPermission).not.toHaveBeenCalled();

    releaseStartPrompt();
    await startPrompt;
    await answer;
    expect(requestForegroundPermission).toHaveBeenCalledTimes(1);
  });

  it("does not ask again when the prompt it waited for already answered", async () => {
    let state: "not-determined" | "denied" = "not-determined";
    const requestForegroundPermission = jest.fn(async () => "foreground" as const);
    const driver = {
      getPermissionState: async () => state,
      requestForegroundPermission,
      getCurrentFix: async () => null,
    } as unknown as LocationDriver;
    const services = createShellServices({
      config: { webOrigin: "https://openmapx.test" },
      isAppActive: () => true,
      driver,
    });
    let releaseStartPrompt: () => void = () => {};
    const startPrompt = withPermissionPrompt(
      () =>
        new Promise<void>((resolve) => {
          releaseStartPrompt = resolve;
        }),
    );

    const answer = services.auxiliary(locationRequest);
    await new Promise((resolve) => setImmediate(resolve));
    // The start flow's system dialog is refused while the request waits.
    state = "denied";
    releaseStartPrompt();
    await startPrompt;
    await answer;

    expect(requestForegroundPermission).not.toHaveBeenCalled();
  });
});
