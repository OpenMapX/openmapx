import { act, fireEvent, render } from "@testing-library/react-native";
import { Linking } from "react-native";
import { App } from "./App";
import { resetRuntimeConfigCache } from "./config/runtimeConfig";

/** Props of the most recently rendered WebView, captured by the mock below. */
let mockWebViewProps: Record<string, unknown> = {};

jest.mock("react-native-webview", () => {
  const React = require("react") as typeof import("react");
  const { View } = require("react-native") as typeof import("react-native");
  return {
    WebView: (props: Record<string, unknown>) => {
      mockWebViewProps = props;
      return React.createElement(View, { testID: props.testID as string });
    },
  };
});

// The probe surface owns SQLite and the location driver; the shell test only
// needs to know whether it is mounted.
jest.mock("./shell/FeasibilityOverlay", () => {
  const React = require("react") as typeof import("react");
  const { View } = require("react-native") as typeof import("react-native");
  return { FeasibilityOverlay: () => React.createElement(View, { testID: "feasibility-overlay" }) };
});

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
  jest.spyOn(Linking, "openURL").mockResolvedValue(true);
});

describe("App WebView policy", () => {
  it("renders exactly one WebView pointed at the compiled origin", async () => {
    const view = await renderApp();
    expect(view.getByTestId("product-webview")).toBeTruthy();
    expect(mockWebViewProps.source).toEqual({ uri: "https://openmapx.com" });
  });

  it("allowlists only the exact configured origin", async () => {
    await renderApp();
    expect(mockWebViewProps.originWhitelist).toEqual(["https://openmapx.com"]);
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
  });

  it("injects no generic native object into the page", async () => {
    await renderApp();
    expect(mockWebViewProps.injectedJavaScriptObject).toBeUndefined();
    expect(mockWebViewProps.injectedJavaScript).toBeUndefined();
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

  it("prepares a different nonce for the next document", async () => {
    await renderApp();
    const first = nonceIn(bootstrap());
    await emitAsync(mockWebViewProps.onLoadStart);

    await emitAsync(mockWebViewProps.onLoadEnd);

    expect(nonceIn(bootstrap())).not.toBe(first);
  });

  it("ignores a message from outside the compiled origin", async () => {
    await renderApp();
    await emitAsync(mockWebViewProps.onLoadStart);

    await expect(
      emitAsync(mockWebViewProps.onMessage, {
        nativeEvent: { url: "https://evil.example/", data: "{}" },
      }),
    ).resolves.toBeUndefined();
  });

  it("survives a message that is not a string", async () => {
    await renderApp();
    await emitAsync(mockWebViewProps.onLoadStart);

    await expect(
      emitAsync(mockWebViewProps.onMessage, {
        nativeEvent: { url: "https://openmapx.com/", data: undefined },
      }),
    ).resolves.toBeUndefined();
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

  it("shows a retryable error overlay when the load fails", async () => {
    const view = await renderApp();
    await emit(mockWebViewProps.onError);
    expect(view.getByTestId("shell-state-load-error")).toBeTruthy();
    expect(view.getByTestId("shell-action-retry")).toBeTruthy();
  });

  it("treats an HTTP error as a failed load", async () => {
    const view = await renderApp();
    await emit(mockWebViewProps.onHttpError);
    expect(view.getByTestId("shell-state-load-error")).toBeTruthy();
  });

  it("returns to loading and remounts the WebView when retry is pressed", async () => {
    const view = await renderApp();
    await emit(mockWebViewProps.onError);
    await fireEvent.press(view.getByTestId("shell-action-retry"));
    expect(view.getByTestId("shell-loading")).toBeTruthy();
    expect(view.queryByTestId("shell-state-load-error")).toBeNull();
  });

  it("does not resurrect the ready state after an error", async () => {
    const view = await renderApp();
    await emit(mockWebViewProps.onError);
    await emit(mockWebViewProps.onLoadEnd);
    expect(view.getByTestId("shell-state-load-error")).toBeTruthy();
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
    },
  );

  it("offers no action on the fatal state, because none would help", async () => {
    mockManifest = undefined;
    const view = await renderApp();
    expect(view.queryByTestId("shell-action-retry")).toBeNull();
  });
});
