import { describe, expect, it } from "vitest";

import { checkRateLimit, createMemoryStore } from "../../lib/security/rateLimit";

describe("rate limit — janela deslizante", () => {
  it("permite até o limite e bloqueia o excedente na janela", async () => {
    const store = createMemoryStore();
    const opts = { limit: 3, windowMs: 60_000 };
    const allowed: boolean[] = [];
    for (let i = 0; i < 5; i += 1) allowed.push((await checkRateLimit("k", opts, store)).allowed);
    expect(allowed).toEqual([true, true, true, false, false]);
  });

  it("isola chaves diferentes", async () => {
    const store = createMemoryStore();
    const opts = { limit: 1, windowMs: 60_000 };
    expect((await checkRateLimit("a", opts, store)).allowed).toBe(true);
    expect((await checkRateLimit("a", opts, store)).allowed).toBe(false);
    expect((await checkRateLimit("b", opts, store)).allowed).toBe(true);
  });

  it("libera após a janela expirar", async () => {
    const store = createMemoryStore();
    const opts = { limit: 1, windowMs: 20 };
    expect((await checkRateLimit("k", opts, store)).allowed).toBe(true);
    expect((await checkRateLimit("k", opts, store)).allowed).toBe(false);
    await new Promise((r) => setTimeout(r, 30));
    expect((await checkRateLimit("k", opts, store)).allowed).toBe(true);
  });
});
