import { resolve } from "node:path";
import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

// Conservative security headers. CSP is intentionally permissive on connect/img
// because the app loads tiles and overlays from many self-hosted and external
// providers configured at runtime; tightening it further requires reading the
// active integration list. The headers below are framework-agnostic safe defaults.
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(self), interest-cohort=()",
  },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
];

const nextConfig: NextConfig = {
  output: "standalone",
  // Every workspace package whose `main`/`exports` points at raw `.ts`/`.tsx`
  // source must be transpiled by Next. Without this the production build
  // ships TypeScript to the browser and explodes at parse time.
  transpilePackages: [
    "@openmapx/command-palette",
    "@openmapx/core",
    "@openmapx/i18n",
    "@openmapx/integration-framework",
    "@openmapx/mangrove-client",
    "@openmapx/mangrove-react",
    "@openmapx/mobility-core",
    "@openmapx/noaa-coops-data",
    "@openmapx/ourairports-data",
    "@openmapx/place-ids",
    "@openmapx/poi-source-registry",
    "@openmapx/presets",
  ],
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
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default withNextIntl(nextConfig);
