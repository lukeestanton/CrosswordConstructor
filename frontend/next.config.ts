import type { NextConfig } from "next";

// Client-side fetches go to /api/* and are proxied to the FastAPI backend;
// server components talk to it directly via BACKEND_URL (see src/lib/api.ts).
const BACKEND_URL = process.env.BACKEND_URL ?? "http://127.0.0.1:8000";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${BACKEND_URL}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
