import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  transpilePackages: ["@openmapx/core"],
  turbopack: {
    root: "../../",
  },
};

export default nextConfig;
