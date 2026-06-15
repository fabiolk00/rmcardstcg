"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { CartLine, CartProduct } from "./totals";

const STORAGE_KEY = "rmcards.cart.v1";

type CartContextValue = {
  lines: CartLine[];
  count: number;
  hydrated: boolean;
  add: (product: CartProduct, quantity?: number) => void;
  setQuantity: (productId: string, quantity: number) => void;
  remove: (productId: string) => void;
  clear: () => void;
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

  // Carrega do localStorage apos montar (evita mismatch de hidratacao).
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed: unknown = JSON.parse(raw);
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
    setLines((prev) => {
      const existing = prev.find((l) => l.product.id === product.id);
      if (existing) {
        return prev.map((l) =>
          l.product.id === product.id
            ? { ...l, quantity: clampToStock(l.quantity + quantity, product.stock) }
            : l,
        );
      }
      return [...prev, { product, quantity: clampToStock(quantity, product.stock) }];
    });
  }, []);

  const setQuantity = useCallback((productId: string, quantity: number) => {
    setLines((prev) =>
      prev.map((l) =>
        l.product.id === productId
          ? { ...l, quantity: clampToStock(quantity, l.product.stock) }
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
    return { lines, count, hydrated, add, setQuantity, remove, clear };
  }, [lines, hydrated, add, setQuantity, remove, clear]);

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartContextValue {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error("useCart deve ser usado dentro de <CartProvider>");
  return ctx;
}
