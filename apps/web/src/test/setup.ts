// Setup for the `web` (jsdom) Vitest project. Registers jest-dom's custom
// matchers (toBeInTheDocument, toHaveTextContent, …) against Vitest's `expect`.
// @testing-library/react auto-cleans the DOM after each test when Vitest globals
// are enabled, so no explicit afterEach(cleanup) is needed here.
import "@testing-library/jest-dom/vitest";
import { afterEach, vi } from "vitest";
import { isBackNavigationIdle, resetBackNavigationForTests } from "@/lib/backNavigation";
import { settleHistory } from "./history";

// jsdom does not implement Element.scrollIntoView; components that scroll a
// highlighted item into view (autocomplete dropdowns, etc.) call it from a
// layout effect and would otherwise throw during render. No-op it globally.
// Guard on `Element` existing: this setup file also loads for web-project test
// files that opt into `// @vitest-environment node`, where there is no DOM.
if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

// Dialogs, menus, sheets and panels write history entries, and a Back that
// crossed only leftovers steps on by itself. jsdom's history lives for the
// whole file, so let such a step land before the next test, then forget the
// bookkeeping of the components this test unmounted.
afterEach(async () => {
  if (typeof window === "undefined") return;
  if (!vi.isFakeTimers() && !isBackNavigationIdle()) await settleHistory();
  resetBackNavigationForTests();
});
