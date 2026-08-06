import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

import { getState, isOpen, recordFailure, recordSuccess, reset } from "@/lib/services/superfrete/circuitBreaker";

// threshold=3, window=5min, recovery=5min — ver circuitBreaker.ts (constantes
// internas, nao exportadas: testamos o comportamento observavel via isOpen/getState).
const RECOVERY_MS = 5 * 60_000;
const FAILURE_WINDOW_MS = 5 * 60_000;

describe("superfrete circuit breaker", () => {
  beforeEach(() => {
    reset();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-06T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("comeca fechado (CLOSED): isOpen() false sem nenhum evento", () => {
    expect(isOpen()).toBe(false);
    expect(getState()).toMatchObject({ state: "closed", failureCount: 0 });
  });

  it("permanece fechado com menos falhas que o limiar", () => {
    recordFailure();
    recordFailure();
    expect(isOpen()).toBe(false);
    expect(getState().failureCount).toBe(2);
  });

  it("abre (OPEN) na 3a falha consecutiva dentro da janela", () => {
    recordFailure();
    recordFailure();
    recordFailure();
    expect(isOpen()).toBe(true);
    expect(getState().state).toBe("open");
    expect(getState().failureCount).toBe(3);
  });

  it("uma chamada bem-sucedida entre falhas zera a sequencia (nao abre)", () => {
    recordFailure();
    recordFailure();
    recordSuccess();
    recordFailure();
    recordFailure();
    expect(isOpen()).toBe(false);
    expect(getState().failureCount).toBe(2);
  });

  it("falha fora da janela de observacao reinicia a contagem em vez de acumular", () => {
    recordFailure();
    recordFailure();
    vi.advanceTimersByTime(FAILURE_WINDOW_MS + 1_000);
    recordFailure(); // 3a falha, mas tarde demais p/ contar com as 2 primeiras
    expect(isOpen()).toBe(false);
    expect(getState().failureCount).toBe(1);
  });

  it("permanece OPEN antes do fim da janela de recovery", () => {
    recordFailure();
    recordFailure();
    recordFailure();
    vi.advanceTimersByTime(RECOVERY_MS - 1_000);
    expect(isOpen()).toBe(true);
  });

  it("promove OPEN -> HALF_OPEN (isOpen()=false) apos a janela de recovery", () => {
    recordFailure();
    recordFailure();
    recordFailure();
    vi.advanceTimersByTime(RECOVERY_MS + 1_000);
    expect(isOpen()).toBe(false); // half_open: deixa a proxima tentativa passar
    expect(getState().state).toBe("half_open");
  });

  it("sucesso em HALF_OPEN fecha o circuito (CLOSED) e zera falhas", () => {
    recordFailure();
    recordFailure();
    recordFailure();
    vi.advanceTimersByTime(RECOVERY_MS + 1_000);
    expect(isOpen()).toBe(false); // entra em half_open
    recordSuccess();
    expect(getState()).toMatchObject({ state: "closed", failureCount: 0 });
    expect(isOpen()).toBe(false);
  });

  it("falha em HALF_OPEN reabre (OPEN) e reinicia o relogio de recovery", () => {
    recordFailure();
    recordFailure();
    recordFailure();
    vi.advanceTimersByTime(RECOVERY_MS + 1_000);
    expect(isOpen()).toBe(false); // half_open
    recordFailure(); // tentativa de recuperacao falhou
    expect(getState().state).toBe("open");
    expect(isOpen()).toBe(true);
    // Precisa esperar RECOVERY_MS de novo a partir de AGORA, nao do open original.
    vi.advanceTimersByTime(RECOVERY_MS - 1_000);
    expect(isOpen()).toBe(true);
    vi.advanceTimersByTime(2_000);
    expect(isOpen()).toBe(false);
  });

  it("getState() reporta nextRetryAt so quando OPEN", () => {
    expect(getState().nextRetryAt).toBeNull();
    recordFailure();
    recordFailure();
    recordFailure();
    expect(getState().nextRetryAt).toBe(new Date(Date.now() + RECOVERY_MS).toISOString());
  });

  it("reset() volta ao estado inicial mesmo com o circuito aberto", () => {
    recordFailure();
    recordFailure();
    recordFailure();
    expect(isOpen()).toBe(true);
    reset();
    expect(isOpen()).toBe(false);
    expect(getState()).toMatchObject({ state: "closed", failureCount: 0, lastFailureAt: null });
  });
});
