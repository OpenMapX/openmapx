import { type ReactElement, useCallback, useMemo, useState } from "react";
import { Linking, StyleSheet, View } from "react-native";
import { WebView } from "react-native-webview";
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
        onLoadEnd={() => setPhase((current) => (current === "error" ? current : "ready"))}
        onError={() => setPhase("error")}
        onHttpError={() => setPhase("error")}
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
