import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // PDF.js loads its parser worker from disk in Node route handlers.
  serverExternalPackages: ["pdfjs-dist"],
};

export default nextConfig;
