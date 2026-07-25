import { resolve } from "node:path";
import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");
const developmentImageSources = process.env.NODE_ENV === "production" ? "" : " http:";

// Enforced now: object/base/frame/form hardening. Resource directives stay
// permissive because tiles and overlays load from many runtime-configured
// origins (self-hosted + external). A nonce-based strict `script-src` that
// would also block `javascript:`-URI XSS is a deferred follow-up — it needs
// per-request nonces (in proxy.ts) and browser verification of every map layer.
const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'self'",
  "form-action 'self'",
  `img-src 'self' data: blob: https:${developmentImageSources}`,
  "font-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "worker-src 'self' blob:",
  "connect-src 'self' https: http: ws: wss: data: blob:",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:",
].join("; ");

// Security headers applied to every route. CSP enforces object/base/frame/form
// hardening now; resource directives stay permissive (see comment above).
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(self), geolocation=(self), interest-cohort=()",
  },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
];

const nextConfig: NextConfig = {
  output: "standalone",
  // Every workspace package whose `main`/`exports` points at raw `.ts`/`.tsx`
  // source must be transpiled by Next. Without this the production build
  // ships TypeScript to the browser and explodes at parse time.
  transpilePackages: [
    "@openmapx/command-palette",
    "@openmapx/core",
    "@openmapx/ev-charge-planner",
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
