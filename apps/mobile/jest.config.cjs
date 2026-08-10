const path = require("node:path");
const iosPreset = require("jest-expo/ios/jest-preset");

/**
 * ESM-only dependencies Jest must transform rather than hand to the runtime.
 *
 * jest-expo's allowlist covers pnpm's outer `.pnpm` directory, but pnpm stores a
 * package's real files under a *second* `node_modules` segment — and at that
 * segment the allowlist no longer matches, so the package is skipped and its
 * `import` statement reaches Node as-is. Naming the packages here is the only
 * part that needs saying; the preset's own reanimated and babel-preset
 * exclusions are preserved by editing its patterns instead of replacing them.
 */
const ESM_DEPENDENCIES = ["intl-messageformat", "@formatjs"];

const PNPM_ALLOWLIST_MARKER = "(?!(.pnpm";
const transformIgnorePatterns = iosPreset.transformIgnorePatterns.map((pattern) =>
  pattern.replace(PNPM_ALLOWLIST_MARKER, `${PNPM_ALLOWLIST_MARKER}|${ESM_DEPENDENCIES.join("|")}`),
);
if (!transformIgnorePatterns.some((pattern) => pattern.includes(ESM_DEPENDENCIES[0]))) {
  // A jest-expo upgrade that reshapes the allowlist must fail loudly here rather
  // than silently reintroduce "Cannot use import statement outside a module".
  throw new Error("jest-expo transformIgnorePatterns no longer match the expected pnpm allowlist");
}

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
  transformIgnorePatterns,
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
