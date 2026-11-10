import { MOBILE_PROTOCOL_MAX, type WebToNativeMessage } from "@openmapx/core/navigation";
import { answerCommand } from "../bridge/answerCommand";
import {
  type AuxiliaryCommandDeps,
  createAuxiliaryCommandHandler,
  wireFix,
} from "./auxiliaryCommands";

const envelope = {
  protocolVersion: MOBILE_PROTOCOL_MAX,
  messageId: "m-1",
  channelNonce: "nonce",
  sentAtMs: 1,
};

const locationRequest = (timeoutMs = 10_000): WebToNativeMessage =>
  ({
    ...envelope,
    type: "location.request",
    payload: { requestId: "fix-1", accuracy: "precise", timeoutMs, maxAgeMs: 15_000 },
  }) as WebToNativeMessage;

function deps(overrides: Partial<AuxiliaryCommandDeps> = {}): AuxiliaryCommandDeps {
  return {
    locate: async () => ({ status: "unavailable" }),
    openSettings: async () => "opened",
    signIn: async () => ({ status: "cancelled" }),
    ...overrides,
  };
}

describe("wireFix", () => {
  it("converts the driver's [lng, lat] into the protocol's named fields", () => {
    expect(
      wireFix({
        coords: [11.575, 48.137],
        accuracy: 12,
        timestampMs: 5,
        speedMps: 3,
        headingDegrees: 90,
      }),
    ).toEqual({ lat: 48.137, lng: 11.575, accuracy: 12, heading: 90, speed: 3, timestampMs: 5 });
  });

  it("omits the platforms' various spellings of unknown", () => {
    expect(
      wireFix({
        coords: [11.575, 48.137],
        accuracy: Number.POSITIVE_INFINITY,
        timestampMs: 5,
        speedMps: -1,
        headingDegrees: -1,
      }),
    ).toEqual({ lat: 48.137, lng: 11.575, timestampMs: 5 });
  });

  it("refuses a position outside the globe", () => {
    expect(wireFix({ coords: [200, 48], accuracy: 5, timestampMs: 5 })).toBeNull();
  });
});

describe("createAuxiliaryCommandHandler", () => {
  it("answers a location request with the fix", async () => {
    const handle = createAuxiliaryCommandHandler(
      deps({
        locate: async () => ({
          status: "ok",
          fix: { coords: [11.575, 48.137], accuracy: 8, timestampMs: 100 },
        }),
      }),
    );

    await expect(handle(locationRequest())).resolves.toEqual({
      type: "location.result",
      payload: {
        requestId: "fix-1",
        status: "ok",
        fix: { lat: 48.137, lng: 11.575, accuracy: 8, timestampMs: 100 },
      },
    });
  });

  it("passes a denial through", async () => {
    const handle = createAuxiliaryCommandHandler(
      deps({ locate: async () => ({ status: "denied" }) }),
    );

    await expect(handle(locationRequest())).resolves.toMatchObject({
      payload: { requestId: "fix-1", status: "denied" },
    });
  });

  it("answers a driver that never settles with a timeout", async () => {
    jest.useFakeTimers();
    try {
      const handle = createAuxiliaryCommandHandler(deps({ locate: () => new Promise(() => {}) }));
      const pending = handle(locationRequest(1_000));
      jest.advanceTimersByTime(1_000);
      await expect(pending).resolves.toMatchObject({ payload: { status: "timeout" } });
    } finally {
      jest.useRealTimers();
    }
  });

  it("reports a throwing driver as unavailable", async () => {
    const handle = createAuxiliaryCommandHandler(
      deps({
        locate: async () => {
          throw new Error("sensor");
        },
      }),
    );

    await expect(handle(locationRequest())).resolves.toMatchObject({
      payload: { status: "unavailable" },
    });
  });

  it("opens settings for the requested target", async () => {
    const openSettings = jest.fn(async () => "opened" as const);
    const handle = createAuxiliaryCommandHandler(deps({ openSettings }));

    await expect(
      handle({
        ...envelope,
        type: "settings.open",
        payload: { target: "location" },
      } as WebToNativeMessage),
    ).resolves.toEqual({
      type: "settings.result",
      payload: { target: "location", status: "opened" },
    });
    expect(openSettings).toHaveBeenCalledWith("location");
  });

  it("tells the page when this device cannot complete a sign-in at all", async () => {
    const handle = createAuxiliaryCommandHandler(
      deps({ signIn: async () => ({ status: "unsupported" }) }),
    );

    await expect(
      handle({
        ...envelope,
        type: "auth.open",
        payload: { requestId: "auth-sign-in", purpose: "sign-in" },
      } as WebToNativeMessage),
    ).resolves.toEqual({
      type: "auth.result",
      payload: { requestId: "auth-sign-in", status: "unsupported" },
    });
  });

  it("hands a completed sign-in's code, state and verifier to the page", async () => {
    const handle = createAuxiliaryCommandHandler(
      deps({
        signIn: async () => ({
          status: "ok",
          callbackCode: "c".repeat(43),
          state: "s".repeat(22),
          codeVerifier: "v".repeat(43),
        }),
      }),
    );

    await expect(
      handle({
        ...envelope,
        type: "auth.open",
        payload: { requestId: "auth-sign-in", purpose: "sign-in" },
      } as WebToNativeMessage),
    ).resolves.toEqual({
      type: "auth.result",
      payload: {
        requestId: "auth-sign-in",
        status: "ok",
        handoffCode: "c".repeat(43),
        state: "s".repeat(22),
        codeVerifier: "v".repeat(43),
      },
    });
  });

  it("fails a sign-in whose code could not cross the bridge", async () => {
    const handle = createAuxiliaryCommandHandler(
      deps({
        signIn: async () => ({
          status: "ok",
          callbackCode: "c".repeat(200),
          state: "s",
          codeVerifier: "v",
        }),
      }),
    );

    await expect(
      handle({
        ...envelope,
        type: "auth.open",
        payload: { requestId: "auth-sign-in", purpose: "sign-in" },
      } as WebToNativeMessage),
    ).resolves.toEqual({
      type: "auth.result",
      payload: { requestId: "auth-sign-in", status: "failed" },
    });
  });

  it("declines navigation commands", async () => {
    const handle = createAuxiliaryCommandHandler(deps());

    await expect(
      handle({ ...envelope, type: "snapshot.request", payload: {} } as WebToNativeMessage),
    ).resolves.toBeNull();
  });
});

describe("answerCommand", () => {
  it("correlates the reply with the command", async () => {
    const send = jest.fn();
    await answerCommand(
      locationRequest(),
      async () => ({ type: "location.result", payload: {} }),
      send,
    );

    expect(send).toHaveBeenCalledWith("location.result", {}, { forMessageId: "m-1" });
  });

  it("refuses a command nothing handles", async () => {
    const send = jest.fn();
    await answerCommand(locationRequest(), async () => null, send);

    expect(send).toHaveBeenCalledWith(
      "native.error",
      { code: "unsupported-capability" },
      { forMessageId: "m-1" },
    );
  });
});
