import { type ReactElement, useCallback, useMemo, useRef, useState } from "react";
import { Linking, StyleSheet, View } from "react-native";
import { WebView } from "react-native-webview";
import { createShellBridge } from "./bridge/createShellBridge";
import { buildChannelBootstrapScript } from "./bridge/outboundScript";
import { getRuntimeConfig, type MobileRuntimeConfig } from "./config/runtimeConfig";
import { FeasibilityOverlay } from "./shell/FeasibilityOverlay";
import { classifyNavigation } from "./shell/originPolicy";
import { LoadingOverlay, ShellMessageOverlay } from "./shell/ShellOverlays";
import { deviceMobileLocale, shellCopy } from "./shell/shellCopy";

/**
 * The entire visible product is the web UI inside one WebView pointed at the
 * origin compiled into this binary. Native UI exists only for the states the
 * WebView cannot render itself: initial load, a failed load, and a fatally
 * misconfigured build.
 */

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#FFFFFF" },
  webView: { flex: 1 },
});

type LoadPhase = "loading" | "ready" | "error";

function ProductShell({ config }: { config: MobileRuntimeConfig }): ReactElement {
  const locale = useMemo(() => deviceMobileLocale(), []);
  const [phase, setPhase] = useState<LoadPhase>("loading");
  // Remounting the WebView is the only reliable way to retry a load that failed
  // before any document existed; `reload()` on a blank view is a no-op.
  const [loadAttempt, setLoadAttempt] = useState(0);

  const webViewRef = useRef<WebView>(null);
  const shell = useMemo(
    () =>
      createShellBridge({
        webOrigin: config.webOrigin,
        inject: (script) => webViewRef.current?.injectJavaScript(script),
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
    shell.registry.adoptDocument(publishedNonce, Date.now());
    shell.bridge.discardQueue();
    setPhase((current) => (current === "error" ? current : "loading"));
  }, [publishedNonce, shell]);

  const handleLoadEnd = useCallback(() => {
    setPhase((current) => (current === "error" ? current : "ready"));
    // Prepare a different nonce for whatever document loads next.
    setPublishedNonce(shell.registry.mintNonce());
  }, [shell]);

  const handleLoadFailure = useCallback(() => {
    setPhase("error");
    shell.registry.invalidate();
    shell.bridge.discardQueue();
  }, [shell]);

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

  const retry = useCallback(() => {
    setPhase("loading");
    setLoadAttempt((attempt) => attempt + 1);
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
      {phase === "loading" ? <LoadingOverlay locale={locale} /> : null}
      {phase === "error" ? (
        <ShellMessageOverlay
          locale={locale}
          testID="shell-load-error"
          title={shellCopy(locale, "loadErrorTitle")}
          body={shellCopy(locale, "loadErrorBody")}
          action={{
            label: shellCopy(locale, "retry"),
            onPress: retry,
            testID: "shell-load-error-retry",
          }}
        />
      ) : null}
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
        <ShellMessageOverlay
          locale={locale}
          testID="shell-fatal-config"
          title={shellCopy(locale, "fatalConfigTitle")}
          body={shellCopy(locale, "fatalConfigBody")}
        />
      </View>
    );
  }
  return <ProductShell config={configuration.config} />;
}
