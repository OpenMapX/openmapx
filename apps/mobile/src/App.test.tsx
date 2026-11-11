jest.mock("expo-speech-recognition", () => ({
  ExpoSpeechRecognitionModule: { supportsOnDeviceRecognition: jest.fn(() => false) },
}));

import { MOBILE_PROTOCOL_MAX } from "@openmapx/core/navigation";
import { act, fireEvent, render } from "@testing-library/react-native";
import { Alert, AppState, BackHandler, Linking, Platform } from "react-native";
import { z } from "zod";
import { App } from "./App";
import { resetRuntimeConfigCache } from "./config/runtimeConfig";
import { IntakeController } from "./intake/IntakeController";
import * as intakeModule from "./intake/nativeIntakeModule";
import { groundSessionFixture } from "./storage/testing/sessionFixture";
import { VoiceInputController } from "./voice/VoiceInputController";

/** Props of the most recently rendered WebView, captured by the mock below. */
let mockWebViewProps: Record<string, unknown> = {};
let mockInjectedScripts: string[] = [];
const mockRecoveryController = {
  reconcile: jest.fn(),
  resume: jest.fn(),
  end: jest.fn(),
};

jest.mock("react-native-webview", () => {
  const React = require("react") as typeof import("react");
  const { View } = require("react-native") as typeof import("react-native");
  return {
    WebView: React.forwardRef((props: Record<string, unknown>, ref) => {
      mockWebViewProps = props;
      React.useImperativeHandle(ref, () => ({
        injectJavaScript: (script: string) => mockInjectedScripts.push(script),
        goBack: () => mockInjectedScripts.push("<goBack>"),
      }));
      return React.createElement(View, { testID: props.testID as string });
    }),
  };
});

// The probe surface owns SQLite and the location driver; the shell test only
// needs to know whether it is mounted.
jest.mock("./shell/FeasibilityOverlay", () => {
  const React = require("react") as typeof import("react");
  const { View } = require("react-native") as typeof import("react-native");
  return { FeasibilityOverlay: () => React.createElement(View, { testID: "feasibility-overlay" }) };
});

/** A composed foreground navigation graph, standing in for the native one. */
const mockNavigation = {
  coordinator: { dispatch: jest.fn(), stopNatively: jest.fn() },
  // The composition routes navigation commands to its coordinator.
  dispatch: (message: unknown) => mockNavigation.coordinator.dispatch(message),
  capabilities: jest.fn(),
  activeSession: jest.fn(),
  reviewKeepAwake: jest.fn(async () => undefined),
  recovery: mockRecoveryController,
  reportInvalidSend: jest.fn(),
  dispose: jest.fn(),
};
const mockCreateForegroundNavigation = jest.fn();
jest.mock("./navigation/createForegroundNavigation", () => ({
  createForegroundNavigation: (...args: unknown[]) => mockCreateForegroundNavigation(...args),
}));

const NAVIGATION_CAPABILITIES = {
  groundNavigation: true,
  transitNavigation: true,
  backgroundLocation: true,
  localNotifications: true,
  speech: true,
};

const RELEASE_MANIFEST = {
  release: true,
  feasibilityMode: false,
  webOrigin: "https://openmapx.com",
  apiOrigin: "https://openmapx.com",
  webHost: "openmapx.com",
  appId: "org.openmapx.app",
  scheme: "openmapx",
};

let mockManifest: unknown = RELEASE_MANIFEST;

jest.mock("expo-constants", () => ({
  __esModule: true,
  get default() {
    return { expoConfig: { extra: { mobile: mockManifest } } };
  },
}));

// The `expo-constants` mock reads `mockManifest` through a getter, so a test
// only has to reassign it and clear the memoised config before rendering.
// `render` is asynchronous in React Native Testing Library 14.
async function renderApp() {
  resetRuntimeConfigCache();
  return render(<App />);
}

beforeEach(async () => {
  mockManifest = RELEASE_MANIFEST;
  mockWebViewProps = {};
  mockInjectedScripts = [];
  jest.spyOn(Linking, "openURL").mockResolvedValue(true);
  jest.spyOn(Linking, "getInitialURL").mockResolvedValue(null);
  mockRecoveryController.reconcile.mockResolvedValue("session-ended");
  mockRecoveryController.resume.mockResolvedValue("session-started");
  mockRecoveryController.end.mockResolvedValue("session-ended");
  // Jest has no native location, storage or audio modules, so by default the
  // graph fails to compose, as it would on a device missing one of them.
  mockCreateForegroundNavigation.mockReset();
  mockCreateForegroundNavigation.mockRejectedValue(new Error("no native modules"));
  mockNavigation.coordinator.stopNatively.mockReset();
  mockNavigation.coordinator.stopNatively.mockResolvedValue(true);
  mockNavigation.coordinator.dispatch.mockReset();
  mockNavigation.coordinator.dispatch.mockResolvedValue(undefined);
  mockNavigation.capabilities.mockReturnValue(NAVIGATION_CAPABILITIES);
  mockNavigation.activeSession.mockResolvedValue(null);
  mockNavigation.dispose.mockReset();
});

describe("App WebView policy", () => {
  it("renders exactly one WebView pointed at the compiled origin", async () => {
    const view = await renderApp();
    expect(view.getByTestId("product-webview")).toBeTruthy();
    expect(mockWebViewProps.source).toEqual({ uri: "https://openmapx.com/" });
  });

  it("forwards app visibility and reapplies it when a document finishes loading", async () => {
    let change: ((status: "active" | "background" | "inactive") => void) | undefined;
    jest.spyOn(AppState, "addEventListener").mockImplementation((type, handler) => {
      if (type === "change") change = handler;
      return { remove: jest.fn() };
    });
    await renderApp();
    mockInjectedScripts = [];
    await act(async () => change?.("background"));
    const hiddenScript = mockInjectedScripts.at(-1);
    expect(hiddenScript).toContain('"hidden"');
    mockInjectedScripts = [];
    await act(async () => (mockWebViewProps.onLoadEnd as () => void)());
    expect(mockInjectedScripts).toContain(hiddenScript);
    await act(async () => change?.("active"));
    expect(mockInjectedScripts.at(-1)).toContain('"visible"');
  });

  it("sends Android's Back button into the page's history while it has any", async () => {
    let press: (() => boolean | null | undefined) | undefined;
    jest.spyOn(BackHandler, "addEventListener").mockImplementation((_event, handler) => {
      press = () => handler({} as never);
      return { remove: jest.fn() };
    });
    await renderApp();
    expect(press?.()).toBe(false);
    await act(async () => {
      (mockWebViewProps.onNavigationStateChange as (state: { canGoBack: boolean }) => void)({
        canGoBack: true,
      });
    });
    expect(press?.()).toBe(true);
    expect(mockInjectedScripts).toContain("<goBack>");
  });

  it("enables the hardening flags the security model depends on", async () => {
    await renderApp();
    expect(mockWebViewProps.limitsNavigationsToAppBoundDomains).toBe(true);
    expect(mockWebViewProps.mixedContentMode).toBe("never");
    expect(mockWebViewProps.allowFileAccess).toBe(false);
    expect(mockWebViewProps.allowFileAccessFromFileURLs).toBe(false);
    expect(mockWebViewProps.allowUniversalAccessFromFileURLs).toBe(false);
    expect(mockWebViewProps.setSupportMultipleWindows).toBe(false);
    expect(mockWebViewProps.javaScriptCanOpenWindowsAutomatically).toBe(false);
    expect(mockWebViewProps.thirdPartyCookiesEnabled).toBe(false);
    expect(mockWebViewProps.sharedCookiesEnabled).toBe(true);
    expect(mockWebViewProps.originWhitelist).toEqual(["https://openmapx.com"]);
    expect(mockWebViewProps.injectedJavaScriptObject).toBeUndefined();
    expect(mockWebViewProps.injectedJavaScript).toBeUndefined();
    expect(mockWebViewProps.mediaCapturePermissionGrantType).toBe("deny");
    expect(mockWebViewProps.geolocationEnabled).toBe(false);
    expect(mockWebViewProps.setBuiltInZoomControls).toBe(false);
    expect(mockWebViewProps.setDisplayZoomControls).toBe(false);
  });
});

describe("App bridge channel", () => {
  const emitAsync = async (handler: unknown, ...args: unknown[]) => {
    await act(async () => {
      await (handler as (...rest: unknown[]) => unknown)(...args);
    });
  };

  const bootstrap = () => String(mockWebViewProps.injectedJavaScriptBeforeContentLoaded);
  const nonceIn = (script: string) => {
    const match = script.match(/nonce:"([^"]+)"/);
    if (!match) throw new Error("bootstrap script publishes no nonce");
    return match[1];
  };

  const decodedMessages = (): Array<{
    type?: string;
    payload?: Record<string, unknown>;
  }> =>
    mockInjectedScripts.flatMap((script) => {
      const encoded = script.match(/atob\("([A-Za-z0-9+/=]*)"\)/)?.[1];
      if (!encoded) return [];
      return [
        JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as {
          type?: string;
          payload?: Record<string, unknown>;
        },
      ];
    });

  const post = async (nonce: string, message: Record<string, unknown>) => {
    await emitAsync(mockWebViewProps.onMessage, {
      nativeEvent: {
        url: "https://openmapx.com/",
        data: JSON.stringify({
          protocolVersion: MOBILE_PROTOCOL_MAX,
          messageId: "message-1",
          channelNonce: nonce,
          sentAtMs: Date.now(),
          ...message,
        }),
      },
    });
  };

  it("delivers an initial geo link only after a successful handshake", async () => {
    let receiveUrl!: (event: { url: string }) => void;
    jest.spyOn(Linking, "addEventListener").mockImplementation((_type, handler) => {
      receiveUrl = handler;
      return { remove: jest.fn() } as unknown as ReturnType<typeof Linking.addEventListener>;
    });
    jest.spyOn(Linking, "getInitialURL").mockResolvedValue("geo:48.137,11.575");
    await renderApp();
    expect(decodedMessages().some((m) => m.type === "deep-link.open")).toBe(false);
    const nonce = nonceIn(bootstrap());
    await emitAsync(mockWebViewProps.onLoadStart);
    await post(nonce, {
      type: "web.hello",
      payload: {
        webBuildId: "test",
        minProtocolVersion: 1,
        maxProtocolVersion: MOBILE_PROTOCOL_MAX,
      },
    });
    const intent = decodedMessages().find((m) => m.type === "deep-link.open");
    expect(intent?.payload?.kind).toBe("map");
    expect(new URLSearchParams(intent?.payload?.query as string).get("at")).toBe("48.137,11.575");
    await act(async () => receiveUrl({ url: "geo:52.52,13.405" }));
    const warm = decodedMessages().filter((m) => m.type === "deep-link.open");
    expect(warm).toHaveLength(2);
    expect(new URLSearchParams(warm[1].payload?.query as string).get("at")).toBe("52.52,13.405");
    expect(mockWebViewProps.source).toEqual({ uri: "https://openmapx.com/" });
  });

  it("does not deliver a pending link to an incompatible bridge", async () => {
    jest.spyOn(Linking, "getInitialURL").mockResolvedValue("geo:48,11");
    await renderApp();
    const nonce = nonceIn(bootstrap());
    await emitAsync(mockWebViewProps.onLoadStart);
    await post(nonce, {
      type: "web.hello",
      payload: {
        webBuildId: "future",
        minProtocolVersion: MOBILE_PROTOCOL_MAX + 1,
        maxProtocolVersion: MOBILE_PROTOCOL_MAX + 1,
      },
    });
    expect(decodedMessages().some((m) => m.type === "deep-link.open")).toBe(false);
  });

  it("publishes a channel nonce to the main frame only", async () => {
    await renderApp();

    expect(mockWebViewProps.injectedJavaScriptBeforeContentLoadedForMainFrameOnly).toBe(true);
    expect(mockWebViewProps.injectedJavaScriptForMainFrameOnly).toBe(true);
    expect(nonceIn(bootstrap())).toMatch(/^[A-Za-z0-9_-]{40,}$/);
  });

  it("publishes the nonce and nothing else", async () => {
    await renderApp();
    const script = bootstrap();

    expect(script).toContain("__OPENMAPX_MOBILE_CHANNEL__");
    for (const forbidden of ["fetch", "eval", "token", "invoke", "sessionId"]) {
      expect(script).not.toContain(forbidden);
    }
  });

  it("keeps the published nonce stable while a document is loading", async () => {
    await renderApp();
    const before = nonceIn(bootstrap());

    await emitAsync(mockWebViewProps.onLoadStart);

    expect(nonceIn(bootstrap())).toBe(before);
  });

  it("keeps the negotiated channel across Android's same-document history reports", async () => {
    jest.replaceProperty(Platform, "OS", "android");
    await renderApp();
    const nonce = nonceIn(bootstrap());
    await emitAsync(mockWebViewProps.onLoadStart, {
      nativeEvent: { loading: true, openmapxDocumentStart: true },
    });
    await post(nonce, {
      type: "web.hello",
      payload: {
        webBuildId: "web-build-1",
        minProtocolVersion: 1,
        maxProtocolVersion: MOBILE_PROTOCOL_MAX,
      },
    });
    await emitAsync(mockWebViewProps.onLoadEnd);
    // An allowed request may produce a download/204 and never commit.
    await emitAsync(mockWebViewProps.onShouldStartLoadWithRequest, {
      url: "https://openmapx.com/download",
    });

    // `replaceState` after the page finished: Android reports it as a load
    // start with `loading: false`.
    await emitAsync(mockWebViewProps.onLoadStart, {
      nativeEvent: { loading: true, openmapxDocumentStart: false },
    });
    await post(nonce, {
      messageId: "probe-after-history",
      type: "voice.probe",
      payload: {},
    });

    // Still the page's channel: the command reaches dispatch and is answered,
    // rather than being dropped as coming from an unknown document.
    const reply = decodedMessages().find((message) => message.type === "voice.availability");
    expect(reply?.payload).toMatchObject({ forMessageId: "probe-after-history" });
  });

  it("ignores duplicate Android start/end reports without losing the page channel", async () => {
    jest.replaceProperty(Platform, "OS", "android");
    await renderApp();
    const nonce = nonceIn(bootstrap());
    await emitAsync(mockWebViewProps.onLoadStart, {
      nativeEvent: { loading: true, openmapxDocumentStart: true },
    });
    await post(nonce, {
      type: "web.hello",
      payload: {
        webBuildId: "lifecycle-test",
        minProtocolVersion: 3,
        maxProtocolVersion: MOBILE_PROTOCOL_MAX,
      },
    });
    // Android can report history while the real document is still loading.
    await emitAsync(mockWebViewProps.onLoadStart, {
      nativeEvent: { loading: true, openmapxDocumentStart: false },
    });
    await post(nonce, {
      messageId: "probe-after-duplicate-start",
      type: "voice.probe",
      payload: {},
    });
    expect(
      decodedMessages().some(
        (message) =>
          message.type === "voice.availability" &&
          message.payload?.forMessageId === "probe-after-duplicate-start",
      ),
    ).toBe(true);
    await emitAsync(mockWebViewProps.onLoadEnd);
    const next = nonceIn(bootstrap());
    await emitAsync(mockWebViewProps.onLoadStart, {
      nativeEvent: { loading: true, openmapxDocumentStart: false },
    });
    await emitAsync(mockWebViewProps.onLoadEnd);
    expect(nonceIn(bootstrap())).toBe(next);
    await emitAsync(mockWebViewProps.onLoadEnd);
    expect(nonceIn(bootstrap())).toBe(next);
    await emitAsync(mockWebViewProps.onLoadStart, {
      nativeEvent: { loading: true, openmapxDocumentStart: true },
    });
    await post(next, {
      messageId: "hello-real-reload",
      type: "web.hello",
      payload: {
        webBuildId: "reloaded",
        minProtocolVersion: 3,
        maxProtocolVersion: MOBILE_PROTOCOL_MAX,
      },
    });
    expect(
      decodedMessages().some(
        (message) =>
          message.type === "native.hello" && message.payload?.forMessageId === "hello-real-reload",
      ),
    ).toBe(true);
  });

  it.each(["android", "ios"] as const)(
    "resets document state for an allowed %s navigation during an unfinished load",
    async (platform) => {
      jest.replaceProperty(Platform, "OS", platform);
      const cancel = jest
        .spyOn(VoiceInputController.prototype, "cancel")
        .mockImplementation(() => {});
      const nonce = await hello();
      cancel.mockClear();
      await emitAsync(mockWebViewProps.onShouldStartLoadWithRequest, {
        url: "https://openmapx.com/settings",
        isTopFrame: true,
      });
      await emitAsync(mockWebViewProps.onLoadStart, {
        nativeEvent: { loading: false, openmapxDocumentStart: true },
      });
      expect(cancel).toHaveBeenCalledTimes(1);
      await post(nonce, { messageId: "obsolete-document", type: "voice.probe", payload: {} });
      expect(decodedMessages().some((m) => m.payload?.forMessageId === "obsolete-document")).toBe(
        false,
      );
      // The in-flight script still has its published nonce, but its old
      // handshake and dedupe state must be gone. A fresh hello can reuse its ID.
      await post(nonce, {
        type: "web.hello",
        payload: {
          webBuildId: "replacement",
          minProtocolVersion: 3,
          maxProtocolVersion: MOBILE_PROTOCOL_MAX,
        },
      });
      expect(decodedMessages().filter((m) => m.type === "native.hello")).toHaveLength(2);
    },
  );

  it("does not suppress iOS document starts even without an Android navigation flag", async () => {
    jest.replaceProperty(Platform, "OS", "ios");
    const cancel = jest
      .spyOn(VoiceInputController.prototype, "cancel")
      .mockImplementation(() => {});
    const nonce = await hello();
    cancel.mockClear();
    await emitAsync(mockWebViewProps.onLoadStart);
    expect(cancel).toHaveBeenCalledTimes(1);
    await post(nonce, { messageId: "old-ios-document", type: "voice.probe", payload: {} });
    expect(decodedMessages().some((m) => m.payload?.forMessageId === "old-ios-document")).toBe(
      false,
    );
  });

  it("rejects the previous document nonce after a completed load and real reload", async () => {
    jest.replaceProperty(Platform, "OS", "android");
    const oldNonce = await hello();
    await emitAsync(mockWebViewProps.onLoadEnd);
    const nextNonce = nonceIn(bootstrap());
    expect(nextNonce).not.toBe(oldNonce);
    await emitAsync(mockWebViewProps.onLoadStart, { nativeEvent: { openmapxDocumentStart: true } });
    await post(nextNonce, {
      messageId: "reload-hello",
      type: "web.hello",
      payload: {
        webBuildId: "new-document",
        minProtocolVersion: 3,
        maxProtocolVersion: MOBILE_PROTOCOL_MAX,
      },
    });
    await post(oldNonce, { messageId: "old-nonce", type: "voice.probe", payload: {} });
    expect(decodedMessages().some((m) => m.payload?.forMessageId === "old-nonce")).toBe(false);
    await post(nextNonce, { messageId: "new-nonce", type: "voice.probe", payload: {} });
    expect(decodedMessages()).toContainEqual(
      expect.objectContaining({
        type: "voice.availability",
        payload: { forMessageId: "new-nonce", available: false },
      }),
    );
  });

  it("fails closed when Android JS is paired with a stale APK, logging only once", async () => {
    jest.replaceProperty(Platform, "OS", "android");
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    await renderApp();
    const nonce = nonceIn(bootstrap());
    await emitAsync(mockWebViewProps.onLoadStart, { nativeEvent: { loading: true } });
    await emitAsync(mockWebViewProps.onLoadStart, { nativeEvent: { loading: true } });
    await post(nonce, {
      type: "web.hello",
      payload: {
        webBuildId: "stale-apk",
        minProtocolVersion: 3,
        maxProtocolVersion: MOBILE_PROTOCOL_MAX,
      },
    });
    expect(decodedMessages()).toEqual([]);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("does not let a history finish erase a failed load or rotate its nonce", async () => {
    jest.replaceProperty(Platform, "OS", "android");
    const view = await renderApp();
    const nonce = nonceIn(bootstrap());
    await emitAsync(mockWebViewProps.onLoadStart, { nativeEvent: { openmapxDocumentStart: true } });
    await emitAsync(mockWebViewProps.onError);
    const retryNonce = nonceIn(bootstrap());
    expect(retryNonce).not.toBe(nonce);
    await emitAsync(mockWebViewProps.onLoadEnd);
    expect(nonceIn(bootstrap())).toBe(retryNonce);
    expect(view.queryByTestId("shell-loading")).toBeNull();
    expect(view.getByTestId("shell-state-load-error")).toBeTruthy();
  });

  it("uses a defensive canonical source object across shell renders", async () => {
    await renderApp();
    const source = mockWebViewProps.source;
    expect(source).toEqual({ uri: "https://openmapx.com/" });
    await emitAsync(mockWebViewProps.onLoadStart);
    await emitAsync(mockWebViewProps.onLoadEnd);
    expect(mockWebViewProps.source).toBe(source);
  });

  it("rejects an outside-origin command while forwarding the same valid command from the product", async () => {
    mockCreateForegroundNavigation.mockResolvedValue(mockNavigation);
    const nonce = await hello();
    const message = {
      protocolVersion: MOBILE_PROTOCOL_MAX,
      channelNonce: nonce,
      sentAtMs: Date.now(),
      messageId: "prepare-origin",
      type: "session.prepare",
      payload: { startPackage: groundSessionFixture().payload.startPackage },
    };
    await emitAsync(mockWebViewProps.onMessage, {
      nativeEvent: { url: "https://evil.example/", data: JSON.stringify(message) },
    });
    expect(mockNavigation.coordinator.dispatch).not.toHaveBeenCalled();
    expect(
      decodedMessages().some((reply) => reply.payload?.forMessageId === "prepare-origin"),
    ).toBe(false);
    await post(nonce, message);
    expect(mockNavigation.coordinator.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "session.prepare", messageId: "prepare-origin" }),
    );
  });

  it("survives a non-string message on a negotiated channel", async () => {
    mockCreateForegroundNavigation.mockResolvedValue(mockNavigation);
    await hello();
    const before = [...decodedMessages()];

    await expect(
      emitAsync(mockWebViewProps.onMessage, {
        nativeEvent: { url: "https://openmapx.com/", data: undefined },
      }),
    ).resolves.toBeUndefined();
    expect(mockNavigation.coordinator.dispatch).not.toHaveBeenCalled();
    expect(decodedMessages()).toEqual(before);
  });

  it("advertises no native navigation mode when the foreground graph could not be composed", async () => {
    await renderApp();
    const nonce = nonceIn(bootstrap());
    await emitAsync(mockWebViewProps.onLoadStart);

    await post(nonce, {
      type: "web.hello",
      payload: {
        webBuildId: "web-build-1",
        minProtocolVersion: 1,
        maxProtocolVersion: MOBILE_PROTOCOL_MAX,
      },
    });

    const hello = decodedMessages().find((message) => message.type === "native.hello");
    expect(hello?.payload?.capabilities).toMatchObject({
      groundNavigation: false,
      transitNavigation: false,
    });
  });

  it("rejects a navigation command it cannot run instead of accepting and discarding it", async () => {
    await renderApp();
    const nonce = nonceIn(bootstrap());
    await emitAsync(mockWebViewProps.onLoadStart);
    await post(nonce, {
      type: "web.hello",
      payload: {
        webBuildId: "web-build-1",
        minProtocolVersion: 1,
        maxProtocolVersion: MOBILE_PROTOCOL_MAX,
      },
    });

    await post(nonce, {
      messageId: "prepare-1",
      type: "session.prepare",
      payload: { startPackage: groundSessionFixture().payload.startPackage },
    });

    const error = decodedMessages().find((message) => message.type === "native.error");
    expect(error?.payload).toEqual({
      code: "unsupported-capability",
      forMessageId: "prepare-1",
    });
  });

  let shellView: Awaited<ReturnType<typeof renderApp>>;
  const hello = async (maxProtocolVersion = MOBILE_PROTOCOL_MAX) => {
    shellView = await renderApp();
    const nonce = nonceIn(bootstrap());
    await emitAsync(mockWebViewProps.onLoadStart, { nativeEvent: { openmapxDocumentStart: true } });
    await post(nonce, {
      type: "web.hello",
      protocolVersion: maxProtocolVersion,
      payload: {
        webBuildId: "web-build-1",
        minProtocolVersion: 1,
        maxProtocolVersion,
      },
    });
    return nonce;
  };

  it.each([3, 4, MOBILE_PROTOCOL_MAX])(
    "announces Android inbox content according to negotiated protocol %s",
    async (version) => {
      jest.replaceProperty(Platform, "OS", "android");
      let activate: (() => void) | undefined;
      jest.spyOn(AppState, "addEventListener").mockImplementation((type, handler) => {
        if (type === "change") activate = () => handler("active");
        return { remove: jest.fn() };
      });
      const alert = jest.spyOn(Alert, "alert");
      jest.spyOn(intakeModule, "createNativeIntakePort").mockReturnValue({
        available: async () => true,
        list: async () => [
          {
            id: "f386e706-b728-40a3-9554-881d0ff0958a",
            kind: "text",
            name: "Shared trip",
            createdAtMs: 1,
            byteLength: 500,
          },
        ],
        read: jest.fn(),
        complete: jest.fn(),
        listen: () => () => undefined,
      });
      try {
        await hello(version);
        await act(async () => activate?.());
        expect(
          decodedMessages().find((message) => message.type === "native.hello")?.payload
            ?.selectedProtocolVersion,
        ).toBe(version);
        const announcement = decodedMessages().find((message) => message.type === "intake.changed");
        if (version === 3) {
          expect(announcement).toBeUndefined();
          expect(alert).toHaveBeenCalledWith("Shared items saved", expect.any(String));
        } else {
          expect(announcement).toMatchObject({
            type: "intake.changed",
            payload: { pendingCount: 1 },
          });
          expect(alert).not.toHaveBeenCalled();
        }
      } finally {
        await shellView?.unmount();
      }
    },
  );

  it.each(["failed", "feasibility", "idle", "active", "storage-failed"])(
    "checks intake authority when navigation is %s",
    async (state) => {
      const complete = jest.fn();
      jest.spyOn(intakeModule, "createNativeIntakePort").mockReturnValue({
        available: async () => true,
        list: async () => [
          {
            id: "f386e706-b728-40a3-9554-881d0ff0958a",
            kind: "text",
            name: "Shared location",
            createdAtMs: 1,
            byteLength: 6,
          },
        ],
        read: jest.fn(),
        complete,
        listen: () => () => undefined,
      });
      if (state === "feasibility")
        mockManifest = { ...RELEASE_MANIFEST, release: false, feasibilityMode: true };
      if (["idle", "active", "storage-failed"].includes(state))
        mockCreateForegroundNavigation.mockResolvedValue(mockNavigation);
      if (state === "active")
        mockNavigation.activeSession.mockResolvedValue({ sessionId: "active-trip" });
      const nonce = await hello();
      if (state === "storage-failed")
        mockNavigation.activeSession.mockRejectedValue(new Error("storage unavailable"));
      await post(nonce, { messageId: "list-authority", type: "intake.list", payload: {} });
      const reply = decodedMessages().find((m) => m.payload?.forMessageId === "list-authority");
      if (state === "failed" || state === "storage-failed") {
        expect(reply).toMatchObject({
          type: "native.error",
          payload: { code: "navigation-unavailable" },
        });
      } else {
        expect(reply).toMatchObject({
          type: "intake.items",
          payload: { canApply: state !== "active" },
        });
      }
      if (["failed", "storage-failed", "active"].includes(state)) {
        await post(nonce, {
          messageId: "complete-authority",
          type: "intake.complete",
          payload: { id: "f386e706-b728-40a3-9554-881d0ff0958a", disposition: "opened" },
        });
        expect(complete).not.toHaveBeenCalled();
      }
      await shellView.unmount();
    },
  );

  it("keeps an empty inbox quiet when navigation initialization failed", async () => {
    jest.spyOn(intakeModule, "createNativeIntakePort").mockReturnValue({
      available: async () => true,
      list: async () => [],
      read: jest.fn(),
      complete: jest.fn(),
      listen: () => () => undefined,
    });
    const nonce = await hello();
    await post(nonce, { messageId: "empty-unavailable", type: "intake.list", payload: {} });
    expect(
      decodedMessages().find((m) => m.payload?.forMessageId === "empty-unavailable"),
    ).toMatchObject({ type: "intake.items", payload: { items: [], canApply: false } });
    await shellView.unmount();
  });

  it("keeps the deployed v3 capability schema while advertising the navigation graph", async () => {
    mockCreateForegroundNavigation.mockResolvedValue(mockNavigation);
    await hello(3);

    const reply = decodedMessages().find((message) => message.type === "native.hello");
    expect(reply?.payload?.selectedProtocolVersion).toBe(3);
    // Deployed v3 web rejects every unknown capability key.
    const oldCapabilities = z
      .object({
        groundNavigation: z.boolean(),
        transitNavigation: z.boolean(),
        transitActions: z.boolean().optional(),
        backgroundLocation: z.boolean(),
        localNotifications: z.boolean(),
        speech: z.boolean(),
        carDestinations: z.boolean().optional(),
      })
      .strict();
    expect(oldCapabilities.parse(reply?.payload?.capabilities)).toMatchObject(
      NAVIGATION_CAPABILITIES,
    );
    expect(mockCreateForegroundNavigation).toHaveBeenCalledTimes(1);
    expect(mockCreateForegroundNavigation.mock.calls[0]?.[0]).toMatchObject({
      apiOrigin: "https://openmapx.com",
    });
  });

  it("dispatches intake and voice independently of the navigation command queue", async () => {
    mockCreateForegroundNavigation.mockResolvedValue(mockNavigation);
    const intake = jest.spyOn(IntakeController.prototype, "dispatch").mockResolvedValue();
    jest.spyOn(VoiceInputController.prototype, "isAvailable").mockReturnValue(false);
    const nonce = await hello();
    mockNavigation.coordinator.dispatch.mockImplementation(() => new Promise(() => {}));
    await post(nonce, { messageId: "intake-1", type: "intake.list", payload: {} });
    await post(nonce, { messageId: "probe-after-intake", type: "voice.probe", payload: {} });
    expect(intake).toHaveBeenCalledWith(expect.objectContaining({ type: "intake.list" }));
    expect(decodedMessages()).toContainEqual(
      expect.objectContaining({
        type: "voice.availability",
        payload: { forMessageId: "probe-after-intake", available: false },
      }),
    );
    expect(mockNavigation.coordinator.dispatch).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "answers voice probes with availability %s outside navigation",
    async (available) => {
      mockCreateForegroundNavigation.mockResolvedValue(mockNavigation);
      jest.spyOn(VoiceInputController.prototype, "isAvailable").mockReturnValue(available);
      const nonce = await hello();
      mockNavigation.coordinator.dispatch.mockImplementation(() => new Promise(() => {}));
      await post(nonce, { messageId: "probe-1", type: "voice.probe", payload: {} });
      expect(decodedMessages()).toContainEqual(
        expect.objectContaining({
          type: "voice.availability",
          payload: { forMessageId: "probe-1", available },
        }),
      );
      expect(mockNavigation.coordinator.dispatch).not.toHaveBeenCalled();
    },
  );

  it("dispatches voice commands outside navigation serialization", async () => {
    mockCreateForegroundNavigation.mockResolvedValue(mockNavigation);
    const start = jest.spyOn(VoiceInputController.prototype, "start").mockResolvedValue();
    const stop = jest.spyOn(VoiceInputController.prototype, "stop").mockImplementation(() => {});
    const cancel = jest
      .spyOn(VoiceInputController.prototype, "cancel")
      .mockImplementation(() => {});
    const nonce = await hello();
    mockNavigation.coordinator.dispatch.mockImplementation(() => new Promise(() => {}));
    await fireEvent(shellView.getByTestId("product-shell"), "touchStart");
    await post(nonce, {
      messageId: "voice-1",
      type: "voice.start",
      payload: { requestId: "r", locale: "en-US" },
    });
    await post(nonce, { messageId: "voice-2", type: "voice.stop", payload: { requestId: "r" } });
    await post(nonce, { messageId: "voice-3", type: "voice.cancel", payload: { requestId: "r" } });
    expect(start).toHaveBeenCalledWith("r", "en-US");
    expect(stop).toHaveBeenCalledWith("r");
    expect(cancel).toHaveBeenCalledWith("r");
    expect(mockNavigation.coordinator.dispatch).not.toHaveBeenCalled();
  });

  it("refuses a voice start that no observed touch preceded, and admits one per touch", async () => {
    mockCreateForegroundNavigation.mockResolvedValue(mockNavigation);
    const start = jest.spyOn(VoiceInputController.prototype, "start").mockResolvedValue();
    const nonce = await hello();
    await post(nonce, {
      messageId: "voice-untouched",
      type: "voice.start",
      payload: { requestId: "r0", locale: "en-US" },
    });
    expect(start).not.toHaveBeenCalled();
    expect(decodedMessages()).toContainEqual(
      expect.objectContaining({
        type: "voice.event",
        payload: { requestId: "r0", state: "error", error: "generic" },
      }),
    );
    await fireEvent(shellView.getByTestId("product-shell"), "touchStart");
    await post(nonce, {
      messageId: "voice-touched",
      type: "voice.start",
      payload: { requestId: "r1", locale: "en-US" },
    });
    await post(nonce, {
      messageId: "voice-again",
      type: "voice.start",
      payload: { requestId: "r2", locale: "en-US" },
    });
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith("r1", "en-US");
  });

  it("disposes the navigation graph when the app unmounts", async () => {
    mockCreateForegroundNavigation.mockResolvedValue(mockNavigation);
    const view = await renderApp();
    await act(async () => undefined);

    await act(async () => {
      await view.unmount();
    });

    expect(mockNavigation.dispose).toHaveBeenCalledTimes(1);
  });
});

describe("App navigation interception", () => {
  const decide = (url: string) =>
    (mockWebViewProps.onShouldStartLoadWithRequest as (request: { url: string }) => boolean)({
      url,
    });

  it("loads a product URL in the WebView without touching the system browser", async () => {
    await renderApp();
    expect(decide("https://openmapx.com/directions?q=x")).toBe(true);
    expect(Linking.openURL).not.toHaveBeenCalled();
  });

  it("hands an external link to the operating system and blocks the load", async () => {
    await renderApp();
    expect(decide("https://www.openstreetmap.org/copyright")).toBe(false);
    expect(Linking.openURL).toHaveBeenCalledWith("https://www.openstreetmap.org/copyright");
  });

  it("never renders a lookalike host, but treats it as an ordinary external link", async () => {
    await renderApp();
    // A different host is exactly that: the WebView refuses it, and the system
    // browser is the right place for a link the user tapped.
    expect(decide("https://openmapx.com.evil.example/")).toBe(false);
    expect(Linking.openURL).toHaveBeenCalledWith("https://openmapx.com.evil.example/");
  });

  it.each([
    "file:///etc/passwd",
    "javascript:alert(1)",
    "data:text/html,owned",
    "blob:https://openmapx.com/1234",
    "https://user:pass@openmapx.com/",
    "http://openmapx.com/directions",
  ])("blocks %s outright and never hands it to the OS", async (url) => {
    await renderApp();
    expect(decide(url)).toBe(false);
    expect(Linking.openURL).not.toHaveBeenCalled();
  });

  it("routes a popup through the same policy", async () => {
    await renderApp();
    (mockWebViewProps.onOpenWindow as (event: { nativeEvent: { targetUrl: string } }) => void)({
      nativeEvent: { targetUrl: "https://www.openstreetmap.org/about" },
    });
    expect(Linking.openURL).toHaveBeenCalledWith("https://www.openstreetmap.org/about");
  });

  it("swallows a rejected system handoff instead of crashing", async () => {
    jest.spyOn(Linking, "openURL").mockRejectedValue(new Error("no handler"));
    await renderApp();
    expect(() => decide("mailto:hello@openmapx.com")).not.toThrow();
  });
});

describe("App load states", () => {
  /** WebView callbacks change React state, so they must run inside `act`. */
  const emit = async (handler: unknown) => {
    await act(async () => {
      (handler as () => void)();
    });
  };

  it("shows the loading overlay until the page finishes loading", async () => {
    const view = await renderApp();
    expect(view.getByTestId("shell-loading")).toBeTruthy();
    await emit(mockWebViewProps.onLoadEnd);
    expect(view.queryByTestId("shell-loading")).toBeNull();
  });

  it("does not cover a loaded Android page again for a same-document history change", async () => {
    jest.replaceProperty(Platform, "OS", "android");
    const view = await renderApp();
    await emit(mockWebViewProps.onLoadEnd);
    await act(async () => {
      (mockWebViewProps.onLoadStart as (event: unknown) => void)({
        nativeEvent: { loading: false, openmapxDocumentStart: false },
      });
    });
    expect(view.queryByTestId("shell-loading")).toBeNull();
  });

  it("treats an HTTP error as a failed load", async () => {
    const view = await renderApp();
    await emit(mockWebViewProps.onHttpError);
    expect(view.getByTestId("shell-state-load-error")).toBeTruthy();
  });

  it("keeps a failed load failed until retry returns it to loading", async () => {
    const view = await renderApp();
    await emit(mockWebViewProps.onError);
    expect(view.getByTestId("shell-state-load-error")).toBeTruthy();
    expect(view.getByTestId("shell-action-retry")).toBeTruthy();
    await emit(mockWebViewProps.onLoadEnd);
    expect(view.getByTestId("shell-state-load-error")).toBeTruthy();
    await fireEvent.press(view.getByTestId("shell-action-retry"));
    expect(view.getByTestId("shell-loading")).toBeTruthy();
    expect(view.queryByTestId("shell-state-load-error")).toBeNull();
  });
});

describe("App navigation recovery composition", () => {
  // Recovery is part of the navigation composition.
  beforeEach(() => mockCreateForegroundNavigation.mockResolvedValue(mockNavigation));

  it("derives an already-running process-death session before explaining a page failure", async () => {
    mockRecoveryController.reconcile.mockResolvedValue("session-started");
    const view = await renderApp();
    await act(async () => undefined);

    expect(mockRecoveryController.reconcile).toHaveBeenCalledTimes(1);
    await act(async () => {
      (mockWebViewProps.onError as () => void)();
    });
    expect(view.getByTestId("shell-state-offline-navigating")).toBeTruthy();
  });

  it("resumes through the recovery authority before changing presentation state", async () => {
    mockRecoveryController.reconcile.mockResolvedValue("resume-required");
    const view = await renderApp();
    await act(async () => undefined);

    expect(view.getByTestId("shell-state-resume-offer")).toBeTruthy();
    await act(async () => {
      await fireEvent.press(view.getByTestId("shell-action-resume"));
    });

    expect(mockRecoveryController.resume).toHaveBeenCalledTimes(1);
    expect(view.queryByTestId("shell-state-resume-offer")).toBeNull();
  });

  it("ends a permission-lost session through the recovery authority", async () => {
    mockRecoveryController.reconcile.mockResolvedValue("permission-lost");
    const view = await renderApp();
    await act(async () => undefined);

    expect(view.getByTestId("shell-state-permission-lost")).toBeTruthy();
    await act(async () => {
      await fireEvent.press(view.getByTestId("shell-action-end"));
    });

    expect(mockRecoveryController.end).toHaveBeenCalledTimes(1);
    expect(view.queryByTestId("shell-state-permission-lost")).toBeNull();
  });
});

describe("App feasibility surface", () => {
  it("is absent from a build without the feasibility flag", async () => {
    const view = await renderApp();
    expect(view.queryByTestId("feasibility-overlay")).toBeNull();
  });

  it("is present only when the build enabled it", async () => {
    mockManifest = { ...RELEASE_MANIFEST, release: false, feasibilityMode: true };
    const view = await renderApp();
    expect(view.getByTestId("feasibility-overlay")).toBeTruthy();
    expect(mockCreateForegroundNavigation).not.toHaveBeenCalled();
    expect(mockRecoveryController.reconcile).not.toHaveBeenCalled();
  });
});

describe("App fatal configuration", () => {
  it.each([undefined, {}, { ...RELEASE_MANIFEST, webOrigin: "https://openmapx.com/path" }])(
    "shows an unrecoverable state for the malformed manifest %p",
    async (value) => {
      mockManifest = value;
      const view = await renderApp();
      expect(view.getByTestId("shell-state-fatal-config")).toBeTruthy();
      expect(view.queryByTestId("product-webview")).toBeNull();
      expect(view.queryByTestId("shell-action-retry")).toBeNull();
    },
  );
});

it("requires native confirmation before ending the exact cold-launch surface owner", async () => {
  const alert = jest.spyOn(Alert, "alert");
  mockCreateForegroundNavigation.mockResolvedValue(mockNavigation);
  mockNavigation.activeSession.mockResolvedValue({
    sessionId: "session-1",
    revision: 1,
    kind: "ground",
  });
  jest
    .spyOn(Linking, "getInitialURL")
    .mockResolvedValue("openmapx:///navigation/end?sessionId=session-1");
  await renderApp();
  expect(alert).toHaveBeenCalled();
  expect(mockNavigation.coordinator.stopNatively).not.toHaveBeenCalled();
  const buttons = alert.mock.calls.at(-1)?.[2];
  await act(async () => buttons?.find((b) => b.style === "destructive")?.onPress?.());
  expect(mockNavigation.coordinator.stopNatively).toHaveBeenCalledWith("session-1");
});
it("does not offer an old End action against a newer session", async () => {
  const alert = jest.spyOn(Alert, "alert");
  mockCreateForegroundNavigation.mockResolvedValue(mockNavigation);
  mockNavigation.activeSession.mockResolvedValue({
    sessionId: "new-session",
    revision: 1,
    kind: "ground",
  });
  jest
    .spyOn(Linking, "getInitialURL")
    .mockResolvedValue("openmapx:///navigation/end?sessionId=old-session");
  await renderApp();
  expect(alert.mock.calls.at(-1)?.[0]).toContain("ended");
  expect(mockNavigation.coordinator.stopNatively).not.toHaveBeenCalled();
});
it("explains a surface End action when the navigation layer cannot load", async () => {
  const alert = jest.spyOn(Alert, "alert");
  jest
    .spyOn(Linking, "getInitialURL")
    .mockResolvedValue("openmapx:///navigation/end?sessionId=session-1");
  await renderApp();
  expect(alert.mock.calls.at(-1)?.[0]).toContain("unavailable");
  expect(mockNavigation.coordinator.stopNatively).not.toHaveBeenCalled();
});
it("confirms a warm surface End without waiting for the web bridge", async () => {
  const alert = jest.spyOn(Alert, "alert");
  let receiveUrl!: (event: { url: string }) => void;
  jest.spyOn(Linking, "addEventListener").mockImplementation((_type, handler) => {
    receiveUrl = handler;
    return { remove: jest.fn() } as unknown as ReturnType<typeof Linking.addEventListener>;
  });
  mockCreateForegroundNavigation.mockResolvedValue(mockNavigation);
  mockNavigation.activeSession.mockResolvedValue({
    sessionId: "session-1",
    revision: 1,
    kind: "ground",
  });
  await renderApp();
  await act(async () => receiveUrl({ url: "openmapx:///navigation/end?sessionId=session-1" }));
  expect(alert.mock.calls.at(-1)?.[1]).toContain("End this");
  expect(mockNavigation.coordinator.stopNatively).not.toHaveBeenCalled();
});
it("cancels voice on document replacement, load failure, visibility and teardown", async () => {
  const cancel = jest.spyOn(VoiceInputController.prototype, "cancel").mockImplementation(() => {});
  let change: ((status: "active" | "background" | "inactive") => void) | undefined;
  jest.spyOn(AppState, "addEventListener").mockImplementation((type, handler) => {
    if (type === "change") change = handler;
    return { remove: jest.fn() };
  });
  const view = await renderApp();
  await act(async () => change?.("active"));
  cancel.mockClear();
  await act(async () => (mockWebViewProps.onLoadStart as () => void)());
  expect(cancel).toHaveBeenCalledTimes(1);
  await act(async () => (mockWebViewProps.onError as () => void)());
  expect(cancel).toHaveBeenCalledTimes(2);
  await act(async () => change?.("inactive"));
  expect(cancel).toHaveBeenCalledTimes(3);
  await act(async () => change?.("background"));
  expect(cancel).toHaveBeenCalledTimes(4);
  await view.unmount();
  expect(cancel).toHaveBeenCalledTimes(5);
});
