import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { hasWebViewCaptureDenial } from "./webViewCapturePolicy";

const require = createRequire(import.meta.url);
const installed = readFileSync(
  join(
    dirname(require.resolve("react-native-webview/package.json")),
    "android/src/main/java/com/reactnativecommunity/webview/RNCWebChromeClient.java",
  ),
  "utf8",
);
it("installed WebView denies capture before any permission processing", () =>
  expect(hasWebViewCaptureDenial(installed)).toBe(true));
it.each(["RESOURCE_AUDIO_CAPTURE", "RESOURCE_VIDEO_CAPTURE", "request.deny();", "return;"])(
  "rejects a broken denial: %s",
  (fragment) => {
    const start = installed.indexOf("public void onPermissionRequest");
    expect(
      hasWebViewCaptureDenial(
        installed.slice(0, start) + installed.slice(start).replace(fragment, "BROKEN"),
      ),
    ).toBe(false);
  },
);

it("installed recognizer never logs transcript results", () => {
  const speech = readFileSync(
    join(
      dirname(require.resolve("expo-speech-recognition/package.json")),
      "android/src/main/java/expo/modules/speechrecognition/ExpoSpeechService.kt",
    ),
    "utf8",
  );
  expect(speech).not.toMatch(/log\([^\n]*(?:\$resultsList|\$nonEmptyStrings)/);
});
