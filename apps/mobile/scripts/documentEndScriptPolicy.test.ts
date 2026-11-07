import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { hasOnlyReviewedDocumentEndScript } from "./documentEndScriptPolicy";

const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const viewport = readFileSync(new URL("../src/bridge/viewportScript.ts", import.meta.url), "utf8");

it("accepts the reviewed bundled viewport lock wired into the actual shell", () => {
  expect(hasOnlyReviewedDocumentEndScript(app, viewport)).toBe(true);
});

it("accepts a shell without a document-end script", () => {
  expect(hasOnlyReviewedDocumentEndScript("<WebView />", "")).toBe(true);
});

it.each([
  ["injectedJavaScript={VIEWPORT_LOCK_SCRIPT}", "injectedJavaScript={downloadedCode}"],
  ["injectedJavaScript={VIEWPORT_LOCK_SCRIPT}", 'injectedJavaScript={"alert(1)"}'],
  ["injectedJavaScript={VIEWPORT_LOCK_SCRIPT}", 'injectedJavaScript="alert(1)"'],
  [
    "injectedJavaScript={VIEWPORT_LOCK_SCRIPT}",
    "injectedJavaScript={VIEWPORT_LOCK_SCRIPT + extra}",
  ],
  [
    "injectedJavaScript={VIEWPORT_LOCK_SCRIPT}",
    "injectedJavaScript={VIEWPORT_LOCK_SCRIPT} injectedJavaScript={other}",
  ],
  ['from "./bridge/viewportScript"', 'from "./bridge/downloadedScript"'],
  ["import { VIEWPORT_LOCK_SCRIPT }", "import type { VIEWPORT_LOCK_SCRIPT }"],
])("refuses another document-end script or source: %s -> %s", (before, after) => {
  expect(app).toContain(before);
  expect(hasOnlyReviewedDocumentEndScript(app.replace(before, after), viewport)).toBe(false);
});

it("refuses a modified viewport module, including added side effects", () => {
  expect(hasOnlyReviewedDocumentEndScript(app, `${viewport}\nfetch(unknownUrl);\n`)).toBe(false);
});

it("refuses a local binding that shadows the reviewed import", () => {
  const shadowed = app.replace(
    "injectedJavaScript={VIEWPORT_LOCK_SCRIPT}",
    'injectedJavaScript={VIEWPORT_LOCK_SCRIPT} another={(() => { const VIEWPORT_LOCK_SCRIPT = "other"; return VIEWPORT_LOCK_SCRIPT; })()}',
  );
  expect(hasOnlyReviewedDocumentEndScript(shadowed, viewport)).toBe(false);
});

it("cannot use a commented import as evidence for an unreviewed binding", () => {
  const forged = app.replace(
    "import { VIEWPORT_LOCK_SCRIPT }",
    "// import { VIEWPORT_LOCK_SCRIPT }",
  );
  expect(hasOnlyReviewedDocumentEndScript(forged, viewport)).toBe(false);
});
