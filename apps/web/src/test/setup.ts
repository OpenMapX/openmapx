// Setup for the `web` (jsdom) Vitest project. Registers jest-dom's custom
// matchers (toBeInTheDocument, toHaveTextContent, …) against Vitest's `expect`.
// @testing-library/react auto-cleans the DOM after each test when Vitest globals
// are enabled, so no explicit afterEach(cleanup) is needed here.
import "@testing-library/jest-dom/vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, vi } from "vitest";
import { isBackNavigationIdle, resetBackNavigationForTests } from "@/lib/backNavigation";
import { resetMapTouchForTests } from "@/lib/mapTouch";
import { settleHistory } from "./history";

// jsdom does not implement Element.scrollIntoView; components that scroll a
// highlighted item into view (autocomplete dropdowns, etc.) call it from a
// layout effect and would otherwise throw during render. No-op it globally.
// Guard on `Element` existing: this setup file also loads for web-project test
// files that opt into `// @vitest-environment node`, where there is no DOM.
if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

// jsdom resolves var() in computed styles the way a browser does: a reference
// to an undefined custom property makes the declaration fall back to its
// inherited or initial value. Components style themselves with the --omx-*
// design tokens, so give the document the same :root tokens the app loads from
// globals.css (the light theme, as on first paint).
if (typeof document !== "undefined") {
  const css = readFileSync(join(import.meta.dirname, "../app/globals.css"), "utf8");
  const rootRules = css.match(/^:root\s*\{[\s\S]*?^\}/gm);
  if (!rootRules) throw new Error("globals.css no longer declares top-level :root tokens");
  const tokens = document.createElement("style");
  tokens.dataset.testTokens = "globals.css";
  tokens.textContent = rootRules.join("\n");
  document.head.prepend(tokens);
}

// Dialogs, menus, sheets and panels write history entries, and a Back that
// crossed only leftovers steps on by itself. jsdom's history lives for the
// whole file, so let such a step land before the next test, then forget the
// bookkeeping of the components this test unmounted.
afterEach(async () => {
  if (typeof window === "undefined") return;
  if (!vi.isFakeTimers() && !isBackNavigationIdle()) await settleHistory();
  resetBackNavigationForTests();
  // A touch one test made would otherwise pass for the source of the next
  // test's mouse events.
  resetMapTouchForTests();
});
