import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

/**
 * An identifier for exactly this bundle of web code.
 *
 * The native shell reports it back in the handshake, so a shell and a page that
 * disagree about the protocol can be told apart from a shell and a page that
 * merely disagree about a feature. It is therefore fixed when the bundle is
 * built and inlined into it — a value read from the server at runtime would
 * change under a page that had not changed, which is the opposite of useful.
 */
function resolveBuildId(): string {
  if (process.env.NEXT_PUBLIC_BUILD_ID) return process.env.NEXT_PUBLIC_BUILD_ID;
  try {
    const commit = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
      cwd: import.meta.dirname,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (commit) return commit;
  } catch {
    // Not a checkout (a source tarball, a container build context). Fall
    // through: a per-build timestamp still distinguishes two bundles.
  }
  return `build-${Date.now().toString(36)}`;
}

// Security headers applied to every route.
//
// Content-Security-Policy is deliberately absent: it carries a per-request nonce
// and is set in `src/proxy.ts`. A static copy here would be a second policy, and
// browsers enforce both — so the two disagreeing produces failures that are very
// hard to attribute back to either.
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(self), geolocation=(self), interest-cohort=()",
  },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
];

// These documents either render cookie-derived identity/authorization state or
// carry one-time authentication parameters. The service worker is NetworkOnly
// for all navigations; this additionally prevents browser/shared HTTP caches
// from retaining a private response if the worker is absent or bypassed.
const privateNoStoreRouteSources = [
  "/admin/:path*",
  "/settings/:path*",
  "/mobile-auth",
  "/auth/:path*",
  "/delete-account",
] as const;
const privateNoStoreHeaders = [{ key: "Cache-Control", value: "private, no-store" }];
const privateRootResetCallbackRules = [
  {
    source: "/",
    has: [{ type: "query" as const, key: "token" }],
    headers: privateNoStoreHeaders,
  },
  {
    source: "/",
    has: [{ type: "query" as const, key: "error", value: "INVALID_TOKEN" }],
    headers: privateNoStoreHeaders,
  },
];

const nextConfig: NextConfig = {
  output: "standalone",
  // Inlined at build time on purpose; see resolveBuildId.
  env: { NEXT_PUBLIC_BUILD_ID: resolveBuildId() },
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
  // Turbopack derives this context alias from the workspace root. Keep the
  // equivalent webpack alias so the supported fallback compiler can validate
  // production builds too (and so dynamic `@integrations/${id}/...` imports
  // resolve to a real context instead of the nonexistent bare package).
  webpack(config) {
    const integrations = resolve(import.meta.dirname, "../../integrations");
    if (Array.isArray(config.resolve?.alias)) {
      config.resolve.alias.push({ name: "@integrations", alias: integrations });
    } else {
      config.resolve ??= {};
      config.resolve.alias = { ...config.resolve.alias, "@integrations": integrations };
    }
    return config;
  },
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      ...privateNoStoreRouteSources.map((source) => ({
        source,
        headers: privateNoStoreHeaders,
      })),
      ...privateRootResetCallbackRules,
    ];
  },
};

export default withNextIntl(nextConfig);
