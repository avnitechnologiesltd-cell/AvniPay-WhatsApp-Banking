/** @type {import('next').NextConfig} */
const nextConfig = {
  // A single container on the Bank's VM, so the image carries its own server
  // rather than the whole workspace's node_modules.
  output: "standalone",
  outputFileTracingRoot: new URL("../../", import.meta.url).pathname,
  reactStrictMode: true,
  poweredByHeader: false,
};

export default nextConfig;
