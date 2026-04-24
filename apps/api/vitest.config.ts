import { resolve } from "node:path";
import { defineConfig } from "vitest/config";
import { createRepoVitestAliases } from "../../vitest.aliases";

export default defineConfig({
  resolve: {
    alias: createRepoVitestAliases(resolve(__dirname, "../..")),
  },
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: [
        "src/services/maptiler-geocoding.service.ts",
        "src/services/nominatim.service.ts",
        "src/services/pelias.service.ts",
        "src/services/photon.service.ts",
        "src/services/motis-geocoding.service.ts",
        "src/services/osrm.service.ts",
        "src/services/valhalla.service.ts",
        "src/services/elevation.service.ts",
        "src/services/isochrone/**/*.ts",
        "src/services/knowledge/**/*.ts",
        "src/services/data-sources/**/*.ts",
        "src/routes/**/*.ts",
        "src/utils/polyline.ts",
        "src/utils/motis.ts",
        "src/utils/otp.ts",
      ],
      exclude: [
        "**/*.test.ts",
        "**/*.d.ts",
        "**/types.ts",
        "src/services/knowledge/types.ts",
        "src/services/isochrone/provider.ts",
        "src/services/data-sources/types.ts",
      ],
      // Thresholds to be re-evaluated after expanding coverage scope
      // thresholds: { lines: 80, functions: 80, branches: 70, statements: 80 },
    },
  },
});
