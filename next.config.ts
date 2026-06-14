import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // MVP: sem otimizacao de imagem (evita config de remotePatterns/SVG agora).
  // Revisitar no hardening quando houver fotos reais de produto.
  images: { unoptimized: true },
};

export default nextConfig;
