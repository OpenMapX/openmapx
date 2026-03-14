import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: [
        "src/services/transit/**/*.ts",
        "src/routes/transit.ts",
        "src/utils/polyline.ts",
        "src/utils/motis.ts",
        "src/utils/otp.ts",
      ],
      exclude: [
        "**/*.test.ts",
        "**/*.d.ts",
        "src/services/transit/types.ts",
        "src/services/transit/adapters/types.ts",
        "src/services/transit/index.ts",
        "src/services/transit/place-transit.ts",
        "src/services/transit/static-providers.ts",
        "src/services/transit/adapters/index.ts",
        "src/services/transit/registry/country-bboxes.ts",
        "src/services/transit/registry/types.ts",
      ],
      thresholds: { lines: 80, functions: 80, branches: 70, statements: 80 },
    },
  },
});
