/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    // RFMS Orders exports run 1.5–11 MB; the server-action default is 1 MB,
    // which silently rejected every real upload on the Ops Reports importer.
    serverActions: { bodySizeLimit: "25mb" },
  },
};

export default nextConfig;
