import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // websocket client used by the broker live feed (server only)
  serverExternalPackages: ["ws"],
};

export default nextConfig;
