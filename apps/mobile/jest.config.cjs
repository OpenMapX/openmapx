// jest-expo already ships a pnpm-aware `transformIgnorePatterns` (its allowlist
// includes the `.pnpm` directory), so this config deliberately does not override
// it — doing so would also drop the preset's reanimated/babel-preset exclusions.
const path = require("node:path");
const iosPreset = require("jest-expo/ios/jest-preset");

/**
 * One React and one React Native, always the copies installed in `apps/mobile`.
 * The workspace currently resolves a single React version, so this is drift
 * protection: two copies surface as `Cannot read properties of null (reading
 * 'useRef')` because the hook dispatcher belongs to the other renderer, which is
 * far harder to diagnose than a resolution error. `metro.config.cjs` applies the
 * same rule to the shipped bundles.
 */
const pinnedRuntime = (name) =>
  path.dirname(require.resolve(`${name}/package.json`, { paths: [__dirname] }));

module.exports = {
  preset: "jest-expo/ios",
  rootDir: __dirname,
  moduleNameMapper: {
    ...(iosPreset.moduleNameMapper ?? {}),
    "^react$": pinnedRuntime("react"),
    "^react/(.*)$": `${pinnedRuntime("react")}/$1`,
    "^react-native$": pinnedRuntime("react-native"),
    "^react-native/(.*)$": `${pinnedRuntime("react-native")}/$1`,
  },
  // Appended after the preset's own setup so Expo's globals exist by the time
  // `jest.globals.js` forces them to resolve.
  setupFiles: [...(iosPreset.setupFiles ?? []), "<rootDir>/jest.globals.js"],
  setupFilesAfterEnv: [...(iosPreset.setupFilesAfterEnv ?? []), "<rootDir>/jest.setup.ts"],
  testMatch: ["<rootDir>/src/**/*.test.ts?(x)", "<rootDir>/modules/**/*.test.ts?(x)"],
  testPathIgnorePatterns: [
    "<rootDir>/node_modules/",
    "<rootDir>/ios/",
    "<rootDir>/android/",
    // Node-side build configuration is covered by the repository Vitest run.
    "<rootDir>/config/",
    "<rootDir>/plugins/",
    "<rootDir>/scripts/",
  ],
  clearMocks: true,
  restoreMocks: true,
};
