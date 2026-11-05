import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { hasWebViewDocumentStartPolicy } from "./webViewDocumentPolicy";

const require = createRequire(import.meta.url);
const installed = readFileSync(
  join(
    dirname(require.resolve("react-native-webview/package.json")),
    "android/src/main/java/com/reactnativecommunity/webview/RNCWebViewClient.java",
  ),
  "utf8",
);

it("installed WebView distinguishes document commits from history before page injection", () => {
  expect(hasWebViewDocumentStartPolicy(installed)).toBe(true);
});
it.each([
  ['"openmapxDocumentStart", true', '"openmapxDocumentStart", false'],
  ['"openmapxDocumentStart", false', '"openmapxDocumentStart", true'],
  ["new TopLoadingStartEvent(", "new OtherEvent("],
  ["callInjectedJavaScriptBeforeContentLoaded()", "missingInjection()"],
])("rejects broken native lifecycle wiring: %s", (before, after) => {
  expect(hasWebViewDocumentStartPolicy(installed.replace(before, after))).toBe(false);
});
