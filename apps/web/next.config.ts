import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@openmapx/core"],
  turbopack: {
    root: "../../",
  },
};

export default nextConfig;
