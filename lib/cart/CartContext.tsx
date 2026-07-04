"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { CartLine, CartProduct } from "./totals";

const STORAGE_KEY = "rmcards.cart.v1";

type CartContextValue = {
  lines: CartLine[];
  count: number;
  hydrated: boolean;
  /**
   * Adiciona com CHECK de estoque: ok=false quando o produto esta esgotado ou
   * o carrinho ja tem todo o estoque disponivel (nada e adicionado).
   */
  add: (product: CartProduct, quantity?: number) => { ok: boolean };
  setQuantity: (productId: string, quantity: number) => void;
  remove: (productId: string) => void;
  clear: () => void;
  /**
   * Resultado da ultima TENTATIVA de adicionar (nome + timestamp + ok) —
   * alimenta o feedback de UI (toast do painel): ok=true "adicionado ao
   * carrinho"; ok=false "produto indisponivel". `at` diferencia cliques
   * repetidos no mesmo produto. Nao persiste no localStorage.
   */
  lastAdded: { name: string; at: number; ok: boolean } | null;
};

const CartContext = createContext<CartContextValue | null>(null);

const clampToStock = (quantity: number, stock: number) => Math.max(1, Math.min(quantity, stock));

const isValidLine = (l: unknown): l is CartLine => {
  if (!l || typeof l !== "object") return false;
  const line = l as Partial<CartLine>;
  return (
    typeof line.product?.id === "string" && typeof line.quantity === "number" && line.quantity >= 1
  );
};

export function CartProvider({ children }: { children: React.ReactNode }) {
  const [lines, setLines] = useState<CartLine[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [lastAdded, setLastAdded] = useState<{ name: string; at: number; ok: boolean } | null>(
    null,
  );

  // Espelho sincrono de `lines` para o add() DECIDIR (tem estoque? ja esta no
  // limite?) sem depender do timing do updater do React. O clamp dentro do
  // updater continua como defesa — o carrinho nunca excede o estoque.
  const linesRef = useRef<CartLine[]>(lines);
  useEffect(() => {
    linesRef.current = lines;
  }, [lines]);

  // Carrega do localStorage apos montar (evita mismatch de hidratacao).
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed: unknown = JSON.parse(raw);
        // eslint-disable-next-line react-hooks/set-state-in-effect -- hidratacao client-only do localStorage (SSR nao le no render)
        if (Array.isArray(parsed)) setLines(parsed.filter(isValidLine));
      }
    } catch {
      // ignora storage corrompido/indisponivel
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(lines));
    } catch {
      // ignora quota/indisponibilidade
    }
  }, [lines, hydrated]);

  const add = useCallback((product: CartProduct, quantity = 1) => {
    // CHECK de estoque ANTES de adicionar: esgotado (limite <= 0) ou carrinho
    // ja no limite do disponivel => nao adiciona e sinaliza indisponivel.
    const limit = product.available ?? product.stock;
    const current = linesRef.current.find((l) => l.product.id === product.id)?.quantity ?? 0;
    const ok = limit > 0 && current < limit;

    if (ok) {
      setLines((prev) => {
        const existing = prev.find((l) => l.product.id === product.id);
        if (existing) {
          return prev.map((l) =>
            l.product.id === product.id
              ? {
                  ...l,
                  quantity: clampToStock(l.quantity + quantity, product.available ?? product.stock),
                }
              : l,
          );
        }
        return [
          ...prev,
          { product, quantity: clampToStock(quantity, product.available ?? product.stock) },
        ];
      });
    }
    setLastAdded({ name: product.name, at: Date.now(), ok });
    return { ok };
  }, []);

  const setQuantity = useCallback((productId: string, quantity: number) => {
    setLines((prev) =>
      prev.map((l) =>
        l.product.id === productId
          ? { ...l, quantity: clampToStock(quantity, l.product.available ?? l.product.stock) }
          : l,
      ),
    );
  }, []);

  const remove = useCallback((productId: string) => {
    setLines((prev) => prev.filter((l) => l.product.id !== productId));
  }, []);

  const clear = useCallback(() => setLines([]), []);

  const value = useMemo<CartContextValue>(() => {
    const count = lines.reduce((sum, l) => sum + l.quantity, 0);
    return { lines, count, hydrated, add, setQuantity, remove, clear, lastAdded };
  }, [lines, hydrated, add, setQuantity, remove, clear, lastAdded]);

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartContextValue {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error("useCart deve ser usado dentro de <CartProvider>");
  return ctx;
}
