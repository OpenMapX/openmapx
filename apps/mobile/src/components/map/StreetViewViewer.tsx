import { useStreetViewStore } from "@openmapx/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WebView, type WebViewMessageEvent } from "react-native-webview";

const MAPILLARY_TOKEN = process.env.EXPO_PUBLIC_MAPILLARY_TOKEN ?? "";

function buildViewerHtml(token: string, imageId: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <link rel="stylesheet" href="https://unpkg.com/mapillary-js@4.1.2/dist/mapillary.min.css">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body, #viewer { width: 100%; height: 100%; background: #000; overflow: hidden; }
  </style>
</head>
<body>
  <div id="viewer"></div>
  <script src="https://unpkg.com/mapillary-js@4.1.2/dist/mapillary.min.js"></script>
  <script>
    var viewer = new mapillary.Viewer({
      accessToken: ${JSON.stringify(token)},
      container: 'viewer',
      component: { cover: false },
    });

    viewer.moveTo(${JSON.stringify(imageId)}).catch(function() {});

    var handleMessage = function(event) {
      try {
        var data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
        if (data.type === 'navigate' && data.imageId) {
          viewer.moveTo(data.imageId).catch(function() {});
        }
      } catch (e) {}
    };

    window.addEventListener('message', handleMessage);
    document.addEventListener('message', handleMessage);

    viewer.on('position', function(event) {
      if (window.ReactNativeWebView) {
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'position',
          lat: event.latLon.lat,
          lng: event.latLon.lng,
        }));
      }
    });

    viewer.on('image', function(event) {
      if (window.ReactNativeWebView) {
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'image',
          imageId: event.image.id,
          lat: event.image.lngLat.lat,
          lng: event.image.lngLat.lng,
          capturedAt: event.image.capturedAt,
        }));
      }
    });
  </script>
</body>
</html>`;
}

interface WebViewMessage {
  type: "position" | "image";
  lat?: number;
  lng?: number;
  imageId?: string;
  capturedAt?: number;
}

export function StreetViewViewer() {
  const activeImageId = useStreetViewStore((s) => s.activeImageId);
  const closeViewer = useStreetViewStore((s) => s.closeViewer);
  const setActiveImageId = useStreetViewStore((s) => s.setActiveImageId);
  const insets = useSafeAreaInsets();
  const webViewRef = useRef<WebView>(null);

  // Freeze the initial image ID so the HTML is only built once per viewer session
  const [initialImageId] = useState(activeImageId);

  const handleMessage = useCallback(
    (event: WebViewMessageEvent) => {
      try {
        const data: WebViewMessage = JSON.parse(event.nativeEvent.data);
        if (data.type === "image" && data.imageId) {
          setActiveImageId(data.imageId);
        }
      } catch {
        // Ignore malformed messages
      }
    },
    [setActiveImageId],
  );

  const html = useMemo(
    () => (initialImageId ? buildViewerHtml(MAPILLARY_TOKEN, initialImageId) : ""),
    [initialImageId],
  );

  // Send navigate messages for subsequent imageId changes (don't rebuild the WebView)
  useEffect(() => {
    if (activeImageId && activeImageId !== initialImageId && webViewRef.current) {
      webViewRef.current.postMessage(JSON.stringify({ type: "navigate", imageId: activeImageId }));
    }
  }, [activeImageId, initialImageId]);

  if (!activeImageId) return null;

  return (
    <Modal visible animationType="slide" statusBarTranslucent onRequestClose={closeViewer}>
      <View style={styles.container}>
        <WebView
          ref={webViewRef}
          source={{ html }}
          style={styles.webview}
          javaScriptEnabled
          domStorageEnabled
          allowsInlineMediaPlayback
          mediaPlaybackRequiresUserAction={false}
          onMessage={handleMessage}
          originWhitelist={["*"]}
        />

        {/* Close button */}
        <Pressable
          onPress={closeViewer}
          style={[styles.closeButton, { top: insets.top + 8 }]}
          accessibilityLabel="Close"
          accessibilityRole="button"
        >
          <Text style={styles.closeIcon}>✕</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#000",
  },
  webview: {
    flex: 1,
    backgroundColor: "#000",
  },
  closeButton: {
    position: "absolute",
    right: 12,
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "rgba(0,0,0,0.6)",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 10,
  },
  closeIcon: {
    color: "#fff",
    fontSize: 18,
    fontWeight: "600",
  },
});
