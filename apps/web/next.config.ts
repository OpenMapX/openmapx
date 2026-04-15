import { resolve } from "node:path";
import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const nextConfig: NextConfig = {
  output: "standalone",
  transpilePackages: ["@openmapx/core", "@openmapx/i18n"],
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  turbopack: {
    root: resolve(import.meta.dirname, "../.."),
  },
};

export default withNextIntl(nextConfig);
