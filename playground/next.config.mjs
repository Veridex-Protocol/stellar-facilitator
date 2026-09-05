/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: "standalone",
  transpilePackages: ["@stellar/stellar-sdk", "@x402/stellar", "@x402/core"],
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        buffer: "buffer/",
        crypto: false,
        stream: false,
      };
    }
    return config;
  },
};

export default nextConfig;
