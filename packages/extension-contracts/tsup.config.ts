import { defineConfig } from "tsup";
export default defineConfig({
  entry: {
    schemas: "src/schemas.ts",
    artifact: "src/artifact.ts",
    index: "src/index.ts",
    integration: "src/integration.ts",
    service: "src/service.ts",
    extension: "src/extension.ts",
    platform: "src/platform.ts",
    contributors: "src/contributors.ts",
    licensing: "src/licensing.ts",
    "licensing-schema": "src/licensing-schema.ts",
    attribution: "src/attribution.ts",
    identifiers: "src/identifiers.ts",
    "media-hosts": "src/media-hosts.ts",
    capabilities: "src/capabilities.ts",
  },
  format: ["esm"],
  dts: { compilerOptions: { ignoreDeprecations: "6.0" } },
  clean: true,
  splitting: true,
});
