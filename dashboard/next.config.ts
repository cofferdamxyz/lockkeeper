import type { NextConfig } from "next";

// Static export: the Lockkeeper Worker serves ./out as static assets, so one origin and one deploy.
const nextConfig: NextConfig = {
  output: "export",
  images: { unoptimized: true },
  trailingSlash: true,
};

export default nextConfig;
