/**
 * Circuit breaker do fallback de frete — evita fazer o checkout esperar o
 * orcamento inteiro de timeout/retry (client.ts, ~18-19s no pior caso desde o
 * ajuste de timeoutMs para 9s) por uma cotacao que, sob instabilidade
 * CONTINUADA do SuperFrete, provavelmente cai no flat de qualquer jeito.
 *
 * Estado em memoria POR INSTANCIA — mesmo padrao do throttle de alerta em
 * ../resend/index.ts:154-155 (variavel de modulo, sem lock/storage
 * compartilhado). Isso tem uma consequencia deliberada: nao e coordenado
 * entre instancias serverless, entao sob trafego distribuido cada instancia
 * abre seu proprio circuito de forma independente (mais lento pra reagir que
 * um circuito compartilhado, mas nao precisa de infra nova — como o resto do
 * mock-first do projeto).
 *
 * NAO diagnostica a causa (timeout nosso vs. 504 real do provedor) — os dois
 * contam como falha igualmente. O circuito protege a LATENCIA do cliente
 * durante uma instabilidade prolongada; o client.ts continua sendo a defesa
 * por chamada individual (timeout + retry).
 */

type CircuitState = "closed" | "open" | "half_open";

/** Falhas consecutivas (dentro da janela) para abrir o circuito. */
const FAILURE_THRESHOLD = 3;
/**
 * Janela de observacao: falhas mais espacadas que isso entre si nao se somam
 * — uma falha isolada horas depois de outra nao deveria contar como
 * "sequencia". Reinicia a contagem em vez de abrir o circuito por acumulo
 * lento e nao-representativo de instabilidade real.
 */
const FAILURE_WINDOW_MS = 5 * 60_000;
/** Tempo com o circuito OPEN antes de permitir uma tentativa de recuperacao (HALF_OPEN). */
const RECOVERY_MS = 5 * 60_000;

let state: CircuitState = "closed";
let failureCount = 0;
let firstFailureAt: number | null = null;
let lastFailureAt: number | null = null;
let openedAt: number | null = null;

export type CircuitSnapshot = {
  state: CircuitState;
  failureCount: number;
  lastFailureAt: string | null;
  /** ISO-8601 de quando o circuito libera a proxima tentativa; null se nao esta OPEN. */
  nextRetryAt: string | null;
};

function snapshot(): CircuitSnapshot {
  return {
    state,
    failureCount,
    lastFailureAt: lastFailureAt !== null ? new Date(lastFailureAt).toISOString() : null,
    nextRetryAt:
      state === "open" && openedAt !== null ? new Date(openedAt + RECOVERY_MS).toISOString() : null,
  };
}

/**
 * true quando o circuito esta bloqueando chamadas (OPEN). Efeito colateral
 * (checagem preguicosa, sem timer): promove OPEN -> HALF_OPEN quando
 * RECOVERY_MS ja passou desde a abertura — a proxima chamada dessa instancia
 * vira a tentativa de recuperacao.
 */
export function isOpen(): boolean {
  if (state === "open" && openedAt !== null && Date.now() - openedAt >= RECOVERY_MS) {
    state = "half_open";
  }
  return state === "open";
}

/**
 * Registra sucesso (cotacao respondeu, com ou sem opcao disponivel — o que
 * importa aqui e que o provedor respondeu, nao o resultado de negocio).
 * Fecha o circuito e zera a sequencia de falhas. Loga recuperacao só quando
 * estava OPEN/HALF_OPEN (fechar um circuito ja fechado nao e evento).
 */
export function recordSuccess(): void {
  const wasRecovering = state !== "closed";
  state = "closed";
  failureCount = 0;
  firstFailureAt = null;
  openedAt = null;
  if (wasRecovering) {
    console.info("[superfrete] circuit_closed_recovery", {
      service: "superfrete",
      timestamp: new Date().toISOString(),
    });
  }
}

/**
 * Registra falha do provedor (timeout nosso OU erro/5xx real deles — ver
 * client.ts). Falha fora da FAILURE_WINDOW_MS reinicia a sequencia. Ao
 * atingir o limiar em CLOSED, abre o circuito. Uma falha durante a tentativa
 * de recuperacao (HALF_OPEN) reabre e reinicia o relogio de RECOVERY_MS.
 */
export function recordFailure(): void {
  const now = Date.now();
  if (firstFailureAt === null || now - firstFailureAt > FAILURE_WINDOW_MS) {
    firstFailureAt = now;
    failureCount = 0;
  }
  failureCount += 1;
  lastFailureAt = now;

  if (state === "half_open") {
    state = "open";
    openedAt = now;
    console.error("[superfrete] circuit_open", {
      service: "superfrete",
      timestamp: new Date().toISOString(),
      failureCount,
      reason: "half_open_retry_failed",
      nextRetryAt: new Date(now + RECOVERY_MS).toISOString(),
    });
    return;
  }

  if (state === "closed" && failureCount >= FAILURE_THRESHOLD) {
    state = "open";
    openedAt = now;
    console.error("[superfrete] circuit_open", {
      service: "superfrete",
      timestamp: new Date().toISOString(),
      failureCount,
      reason: "threshold_reached",
      nextRetryAt: new Date(now + RECOVERY_MS).toISOString(),
    });
  }
}

/** Snapshot pra logging/observabilidade (nao usado pra decisao de isOpen()). */
export function getState(): CircuitSnapshot {
  return snapshot();
}

/**
 * Reset manual — volta ao estado inicial (CLOSED, sem historico). Um deploy
 * ja reseta isso implicitamente (state e em memoria, instancia nova comeca
 * limpa); exportado para teste e para uma rota/acao de ops que queira forcar
 * o circuito a fechar sem esperar RECOVERY_MS.
 */
export function reset(): void {
  state = "closed";
  failureCount = 0;
  firstFailureAt = null;
  lastFailureAt = null;
  openedAt = null;
}
