import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 允许局域网 IP 访问 dev 资源（HMR、chunk 等）
  // Next.js 16 默认阻止非 localhost 的 origin 访问，手机访问会挂
  allowedDevOrigins: ["192.168.5.13", "172.19.240.172"],
};

export default nextConfig;
