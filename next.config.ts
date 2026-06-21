import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // MVP: sem otimizacao de imagem (evita config de remotePatterns/SVG agora).
  // Com unoptimized=true o next/image renderiza qualquer src (local OU a URL
  // publica do Supabase Storage) sem precisar de allowlist de dominio.
  images: { unoptimized: true },
  experimental: {
    // Upload de imagem de produto via server action: o corpo (multipart) traz o
    // arquivo. O default e 1 MB; subimos para acomodar imagens ate ~4 MB (abaixo
    // do teto de 4,5 MB da serverless da Vercel).
    serverActions: { bodySizeLimit: "5mb" },
  },
};

export default nextConfig;
