import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import {
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { Linking, StyleSheet, View } from "react-native";
import { WebView } from "react-native-webview";
import { createShellBridge } from "./bridge/createShellBridge";
import { buildChannelBootstrapScript } from "./bridge/outboundScript";
import { getRuntimeConfig, type MobileRuntimeConfig } from "./config/runtimeConfig";
import { useConnectivity } from "./connectivity/useConnectivity";
import { useAppVisibility } from "./lifecycle/useAppLifecycle";
import { registeredModes } from "./navigation/createCoordinator";
import { FeasibilityOverlay } from "./shell/FeasibilityOverlay";
import { NativeRecoveryOverlay } from "./shell/NativeRecoveryOverlay";
import { classifyNavigation } from "./shell/originPolicy";
import { LoadingOverlay } from "./shell/ShellOverlays";
import type { ShellAction } from "./shell/ShellState";
import { deviceMobileLocale } from "./shell/shellCopy";
import { INITIAL_SHELL, shellReducer } from "./shell/shellReducer";

/**
 * The entire visible product is the web UI inside one WebView pointed at the
 * origin compiled into this binary. Native UI exists only for the states the
 * WebView cannot render itself: the first load, a failed load, a session that
 * outlived its process, and a fatally misconfigured build.
 */

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#FFFFFF" },
  webView: { flex: 1 },
});

function ProductShell({ config }: { config: MobileRuntimeConfig }): ReactElement {
  const locale = useMemo(() => deviceMobileLocale(), []);
  const [shellState, dispatchShell] = useReducer(shellReducer, INITIAL_SHELL);
  // Remounting the WebView is the only reliable way to retry a load that failed
  // before any document existed; `reload()` on a blank view is a no-op.
  const [loadAttempt, setLoadAttempt] = useState(0);
  const visibility = useAppVisibility();
  const connectivity = useConnectivity();

  const webViewRef = useRef<WebView>(null);
  const shell = useMemo(
    () =>
      createShellBridge({
        webOrigin: config.webOrigin,
        inject: (script) => webViewRef.current?.injectJavaScript(script),
        // Reported from what is genuinely registered. Claiming transit here
        // would strand a user mid-journey on a session nothing can advance.
        capabilities: () => ({
          groundNavigation: registeredModes().includes("ground"),
          transitNavigation: registeredModes().includes("transit"),
        }),
      }),
    [config.webOrigin],
  );

  /**
   * The nonce the document-start script currently publishes.
   *
   * It is rotated only after a load finishes, never while one is in flight: the
   * script that carries it runs as the document is created, so changing it
   * mid-navigation would hand the page a value the shell no longer accepts.
   */
  const [publishedNonce, setPublishedNonce] = useState(() => shell.registry.mintNonce());

  const handleLoadStart = useCallback(() => {
    // A real top-level navigation or reload. In-document history changes do not
    // reach here, so a same-origin `pushState` keeps its negotiated channel.
    //
    // A reload resets the bridge and nothing else: the native session and the
    // location driver are unaffected, because the page is not their authority.
    shell.registry.adoptDocument(publishedNonce, Date.now());
    shell.bridge.discardQueue();
    dispatchShell({ type: "document-load-started" });
  }, [publishedNonce, shell]);

  const handleLoadEnd = useCallback(() => {
    dispatchShell({ type: "document-load-succeeded" });
    // Prepare a different nonce for whatever document loads next.
    setPublishedNonce(shell.registry.mintNonce());
  }, [shell]);

  const handleLoadFailure = useCallback(() => {
    dispatchShell({ type: "document-load-failed", offline: connectivity.displayed === "offline" });
    shell.registry.invalidate();
    shell.bridge.discardQueue();
  }, [shell, connectivity.displayed]);

  const handleMessage = useCallback(
    (event: { nativeEvent: { url?: string; data?: string } }) => {
      // Rejections are silent by design: an error reply to an unauthenticated
      // sender is itself an oracle, and every rejection path is side-effect free.
      void shell.bridge.receive(event.nativeEvent);
    },
    [shell],
  );

  const openExternally = useCallback((url: string) => {
    // `openURL` rejects for schemes no installed app handles. Swallowing that is
    // correct: the user tapped a link we deliberately refuse to render, and a
    // native crash would be a far worse outcome than nothing happening.
    void Linking.openURL(url).catch(() => undefined);
  }, []);

  const handleNavigationRequest = useCallback(
    (request: { url: string }): boolean => {
      const decision = classifyNavigation(request.url, config);
      if (decision === "allow-in-webview") return true;
      if (decision === "open-system") openExternally(request.url);
      return false;
    },
    [config, openExternally],
  );

  // Connectivity is an input to the shell's explanation, never authority over a
  // session: losing the network does not end navigation or discard a route.
  useEffect(() => {
    dispatchShell({ type: "connectivity-changed", online: connectivity.displayed !== "offline" });
  }, [connectivity.displayed]);

  /**
   * Keep-awake, narrowly.
   *
   * Only while the app is foregrounded and a session is actually visible. It is
   * never part of the background task: holding a wake lock from a headless
   * callback would drain the battery for a screen nobody is looking at.
   */
  useEffect(() => {
    const shouldHold = visibility === "active" && shellState.context.navigating;
    if (!shouldHold) {
      deactivateKeepAwake();
      return;
    }
    void activateKeepAwakeAsync().catch(() => undefined);
    return () => {
      deactivateKeepAwake();
    };
  }, [visibility, shellState.context.navigating]);

  const handleShellAction = useCallback((action: ShellAction) => {
    switch (action) {
      case "retry":
        setLoadAttempt((attempt) => attempt + 1);
        dispatchShell({ type: "document-load-started" });
        return;
      case "open-network-settings":
      case "open-app-settings":
        void Linking.openSettings().catch(() => undefined);
        return;
      case "resume":
        dispatchShell({ type: "resume-accepted" });
        return;
      case "end":
        dispatchShell({ type: "session-ended" });
        return;
      case "dismiss":
        dispatchShell({ type: "dismissed" });
    }
  }, []);

  return (
    <View style={styles.root}>
      <WebView
        key={loadAttempt}
        ref={webViewRef}
        source={{ uri: config.webOrigin }}
        style={styles.webView}
        // Exact origin, both as a navigation allowlist and as the WebKit
        // App-Bound Domain set generated into Info.plist.
        originWhitelist={[config.webOrigin]}
        limitsNavigationsToAppBoundDomains
        mixedContentMode="never"
        allowFileAccess={false}
        allowFileAccessFromFileURLs={false}
        allowUniversalAccessFromFileURLs={false}
        allowsInlineMediaPlayback={false}
        setSupportMultipleWindows={false}
        javaScriptCanOpenWindowsAutomatically={false}
        sharedCookiesEnabled
        thirdPartyCookiesEnabled={false}
        allowsBackForwardNavigationGestures
        onShouldStartLoadWithRequest={handleNavigationRequest}
        onOpenWindow={(event) => {
          // Popups get the same structural policy as ordinary navigation; they
          // never open a second in-app browser.
          handleNavigationRequest({ url: event.nativeEvent.targetUrl });
        }}
        // The nonce goes in before any page script runs, and only into the main
        // frame — an iframe never receives it, so it cannot address the channel.
        injectedJavaScriptBeforeContentLoaded={buildChannelBootstrapScript(publishedNonce)}
        injectedJavaScriptBeforeContentLoadedForMainFrameOnly
        injectedJavaScriptForMainFrameOnly
        onMessage={handleMessage}
        onLoadStart={handleLoadStart}
        onLoadEnd={handleLoadEnd}
        onError={handleLoadFailure}
        onHttpError={handleLoadFailure}
        testID="product-webview"
      />
      {shellState.state.kind === "loading" ? <LoadingOverlay locale={locale} /> : null}
      <NativeRecoveryOverlay
        locale={locale}
        state={shellState.state}
        onAction={handleShellAction}
      />
      {config.feasibilityMode ? <FeasibilityOverlay /> : null}
    </View>
  );
}

export function App(): ReactElement {
  // A malformed compiled configuration is fatal by design: continuing would
  // mean guessing which server to trust.
  const configuration = useMemo(() => {
    try {
      return { ok: true as const, config: getRuntimeConfig() };
    } catch {
      return { ok: false as const };
    }
  }, []);
  const locale = useMemo(() => deviceMobileLocale(), []);

  if (!configuration.ok) {
    return (
      <View style={styles.root}>
        <NativeRecoveryOverlay
          locale={locale}
          state={{ kind: "fatal-config" }}
          onAction={() => undefined}
        />
      </View>
    );
  }
  return <ProductShell config={configuration.config} />;
}
