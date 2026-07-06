// Hook de boot do Next (register() roda uma vez por instancia de servidor, por
// runtime). Aqui: injetar o RateLimitStore COMPARTILHADO (Postgres) em prod, para
// o rate limiting valer entre as instancias serverless da Vercel (o default em
// memoria e por-instancia — inutil sob autoscale). Ver lib/security/rateLimit.ts.
export async function register() {
  // Guardas (positivas, p/ o bundler podar lib/db do grafo Edge estaticamente):
  // - NEXT_RUNTIME==='nodejs': Prisma/node-postgres NAO rodam no Edge (o middleware
  //   do Clerk vive em proxy.ts, que e Edge; register() tambem roda no runtime edge).
  // - NODE_ENV==='production': dev local (`next dev`) e a suite de testes mantem o
  //   store em memoria (os testes unit injetam createMemoryStore; o de concorrencia
  //   injeta o proprio store Postgres).
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.NODE_ENV === "production") {
    // Import DINAMICO: mantem pg/Prisma fora do bundle Edge e do import estatico.
    const { prisma } = await import("./lib/db");
    const { createPostgresRateLimitStore } = await import("./lib/security/pgRateLimitStore");
    const { setRateLimitStore } = await import("./lib/security/rateLimit");

    setRateLimitStore(createPostgresRateLimitStore(prisma));
  }
}
