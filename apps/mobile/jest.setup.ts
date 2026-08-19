// `@testing-library/react-native` v13 registers its matchers automatically, so
// no matcher import is needed here.

/**
 * NetInfo and KeepAwake are thin wrappers over native modules that do not exist
 * under Jest. They are stubbed once here rather than per suite, so a component
 * test never has to know that the shell observes connectivity at all — and so a
 * suite that forgets to stub them fails loudly in one place instead of hanging.
 */
jest.mock("@react-native-community/netinfo", () => ({
  __esModule: true,
  default: { addEventListener: () => () => undefined, fetch: async () => ({}) },
  addEventListener: () => () => undefined,
}));

jest.mock("expo-keep-awake", () => ({
  __esModule: true,
  activateKeepAwakeAsync: jest.fn(async () => undefined),
  deactivateKeepAwake: jest.fn(async () => undefined),
}));

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
