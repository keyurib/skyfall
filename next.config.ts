import type { NextConfig } from "next";
import { wgslTurbopackRule } from "@vgpu/wgsl/next";

// Turbopack prepares every .wgsl import at build time (resolving its import graph),
// so the browser bundle carries prepared shaders, not the WGSL parser.
const nextConfig: NextConfig = {
  // Fully static: one client-rendered page, deployed as Cloudflare Workers static assets.
  output: "export",
  reactStrictMode: true,
  turbopack: {
    rules: {
      "*.wgsl": wgslTurbopackRule({ minify: true }),
    },
  },
};

export default nextConfig;
