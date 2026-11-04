import { useEffect, useMemo } from "react";
import { Linking } from "react-native";
import { parseSurfaceAction } from "../navigation/surfaces/surfaceAction";
import { type DeepLinkConfig, type DeepLinkIntent, parseDeepLinkIntent } from "./deepLinkIntent";

/** Keep the latest OS request until the current document has negotiated its bridge. */
export function useIncomingLinks(
  config: DeepLinkConfig,
  deliver: (intent: DeepLinkIntent) => void,
  requestNativeEnd?: (sessionId: string) => void,
) {
  const state = useMemo(() => {
    let ready = false;
    let pending: DeepLinkIntent | null = null;
    return {
      receive(raw: string) {
        const owner = parseSurfaceAction(raw, config);
        if (owner) {
          requestNativeEnd?.(owner);
          return;
        }
        const intent = parseDeepLinkIntent(raw, config);
        if (!intent) return;
        if (ready) deliver(intent);
        else pending = intent;
      },
      documentStarted() {
        ready = false;
      },
      bridgeReady() {
        ready = true;
        if (!pending) return;
        const intent = pending;
        pending = null;
        deliver(intent);
      },
    };
  }, [config, deliver, requestNativeEnd]);

  useEffect(() => {
    let disposed = false;
    let eventReceived = false;
    const subscription = Linking.addEventListener("url", ({ url }) => {
      eventReceived = true;
      state.receive(url);
    });
    // A newer URL event wins over a delayed initial-URL promise. It also avoids
    // applying one launch twice when Android delivers both forms.
    void Linking.getInitialURL()
      .then((url) => {
        if (!disposed && !eventReceived && url) state.receive(url);
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      subscription.remove();
    };
  }, [state]);
  return state;
}
