import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Pin the tracing root to this project (a stray ~/package-lock.json was being
  // mis-detected as the workspace root, which can break file tracing on deploy).
  outputFileTracingRoot: __dirname,
};

export default nextConfig;
