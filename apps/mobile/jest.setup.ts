// `@testing-library/react-native` v13 registers its matchers automatically, so
// no matcher import is needed here.

// Deterministic tests: never let a suite reach a real network, and surface the
// attempt as a failure instead of a silent hang. Expo's winter runtime installs
// `fetch` as a lazy proxy whose getter requires native code, so the stub is
// defined rather than assigned — assignment would trip the proxy between tests.
beforeEach(() => {
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: jest.fn(() => {
      throw new Error("network access is not allowed in mobile unit tests");
    }),
  });
});
