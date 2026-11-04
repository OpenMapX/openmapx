import { type RefObject, useCallback, useEffect, useRef } from "react";
import { BackHandler } from "react-native";
import type { WebView, WebViewNavigation } from "react-native-webview";

/**
 * Android's Back button walks the page's own history before it leaves the app.
 *
 * The web app gives every sheet, dialog and opened place a history entry, so
 * going back in the WebView closes exactly what the user last opened. Only once
 * the page has nothing left to go back to does Back fall through to the system,
 * which closes the app as usual. iOS needs none of this: its edge swipe already
 * drives the same history through `allowsBackForwardNavigationGestures`.
 *
 * Returns the WebView's `onNavigationStateChange` handler, which keeps track of
 * whether the page can go back — pushState entries included.
 */
export function useHardwareBack(
  webViewRef: RefObject<WebView | null>,
): (navigation: Pick<WebViewNavigation, "canGoBack">) => void {
  const canGoBackRef = useRef(false);

  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      const webView = webViewRef.current;
      if (!canGoBackRef.current || !webView) return false;
      webView.goBack();
      return true;
    });
    return () => subscription.remove();
  }, [webViewRef]);

  return useCallback((navigation) => {
    canGoBackRef.current = navigation.canGoBack;
  }, []);
}
