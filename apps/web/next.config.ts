import { resolve } from "node:path";
import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const nextConfig: NextConfig = {
  output: "standalone",
  transpilePackages: ["@openmapx/core", "@openmapx/i18n"],
  // esbuild is loaded lazily by @openmapx/core's integration installer (only
  // when the CLI builds a community integration). Server components never run
  // that path, but Turbopack still walks the static `import("esbuild")` and
  // chokes on the `@esbuild/<platform>-<arch>` native binding's README. Leave
  // it external so it stays a runtime `require()`.
  serverExternalPackages: ["esbuild"],
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  turbopack: {
    root: resolve(import.meta.dirname, "../.."),
  },
};

export default withNextIntl(nextConfig);
