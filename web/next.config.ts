import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // This app lives inside the career-watch repo alongside the Electron app's
  // own package-lock.json, which otherwise makes Turbopack guess the wrong
  // workspace root - it's a self-contained npm project, not a workspace
  // member, so its root is just this directory.
  turbopack: {
    root: path.join(__dirname),
  },
};

export default nextConfig;
