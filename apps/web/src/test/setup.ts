// Setup for the `web` (jsdom) Vitest project. Registers jest-dom's custom
// matchers (toBeInTheDocument, toHaveTextContent, …) against Vitest's `expect`.
// @testing-library/react auto-cleans the DOM after each test when Vitest globals
// are enabled, so no explicit afterEach(cleanup) is needed here.
import "@testing-library/jest-dom/vitest";

// jsdom does not implement Element.scrollIntoView; components that scroll a
// highlighted item into view (autocomplete dropdowns, etc.) call it from a
// layout effect and would otherwise throw during render. No-op it globally.
// Guard on `Element` existing: this setup file also loads for web-project test
// files that opt into `// @vitest-environment node`, where there is no DOM.
if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
