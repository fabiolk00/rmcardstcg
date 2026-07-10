import { beforeAll, describe, expect, it } from "vitest";

// Unit DB-free da logica pura de validacao/normalizacao de categoria (sem tocar
// Postgres, sem TEST_DATABASE_URL). Espelha o padrao de validacao de
// produtos/cupons: erros viram CategoryValidationError (pt-BR), nunca uma
// excecao generica.
//
// lib/data/categories.ts importa lib/db (Prisma) em nivel de modulo — o modulo
// so lanca se DATABASE_URL estiver AUSENTE (nao valida se e alcancavel; o Pool
// do adapter-pg e preguicoso e so conecta na 1a query). normalizeCategoryInput
// e pura e nunca faz I/O, entao um placeholder basta p/ o import carregar sem
// exigir Postgres real nem TEST_DATABASE_URL.
let normalizeCategoryInput: typeof import("@/lib/data/categories").normalizeCategoryInput;
let CategoryValidationError: typeof import("@/lib/data/categories").CategoryValidationError;

beforeAll(async () => {
  process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/db?sslmode=disable";
  ({ normalizeCategoryInput, CategoryValidationError } = await import("@/lib/data/categories"));
});

describe("normalizeCategoryInput", () => {
  it("rejeita nome vazio", () => {
    expect(() => normalizeCategoryInput({ name: "", description: null })).toThrow(
      CategoryValidationError,
    );
  });

  it("rejeita nome só com espaços", () => {
    expect(() => normalizeCategoryInput({ name: "   ", description: null })).toThrow(
      CategoryValidationError,
    );
  });

  it("faz trim do nome", () => {
    const result = normalizeCategoryInput({ name: "  Coleção Especial  ", description: null });
    expect(result.name).toBe("Coleção Especial");
  });

  it("rejeita nome menor que 2 caracteres", () => {
    expect(() => normalizeCategoryInput({ name: "A", description: null })).toThrow(
      CategoryValidationError,
    );
  });

  it("rejeita nome maior que 100 caracteres", () => {
    const tooLong = "A".repeat(101);
    expect(() => normalizeCategoryInput({ name: tooLong, description: null })).toThrow(
      CategoryValidationError,
    );
  });

  it("aceita nome no limite de 100 caracteres", () => {
    const atLimit = "A".repeat(100);
    const result = normalizeCategoryInput({ name: atLimit, description: null });
    expect(result.name).toBe(atLimit);
  });

  it("rejeita descrição maior que 500 caracteres", () => {
    const tooLong = "A".repeat(501);
    expect(() => normalizeCategoryInput({ name: "Categoria", description: tooLong })).toThrow(
      CategoryValidationError,
    );
  });

  it("aceita descrição no limite de 500 caracteres", () => {
    const atLimit = "A".repeat(500);
    const result = normalizeCategoryInput({ name: "Categoria", description: atLimit });
    expect(result.description).toBe(atLimit);
  });

  it("descrição vazia ou só espaços vira null", () => {
    expect(normalizeCategoryInput({ name: "Categoria", description: "" }).description).toBeNull();
    expect(normalizeCategoryInput({ name: "Categoria", description: "   " }).description).toBeNull();
    expect(normalizeCategoryInput({ name: "Categoria", description: null }).description).toBeNull();
  });

  it("faz trim da descrição", () => {
    const result = normalizeCategoryInput({ name: "Categoria", description: "  algo  " });
    expect(result.description).toBe("algo");
  });
});
