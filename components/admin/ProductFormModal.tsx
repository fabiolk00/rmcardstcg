"use client";

import { useState } from "react";
import type { Product, Category } from "@/lib/data/types";
import { CATEGORIES } from "@/lib/data/types";
import { finalPriceCents } from "@/lib/data/pricing";
import { formatBRL } from "@/lib/utils/currency";
import { Modal } from "@/components/ui/Modal";
import styles from "./ProductFormModal.module.css";

const DESC_MAX = 300;

/** Payload cru enviado ao servidor (a validacao/slug definitivos sao no server). */
export type ProductFormPayload = {
  name: string;
  category: Category;
  sku: string;
  priceCents: number;
  discountPct: number;
  stock: number;
  badge: string | null;
  imageUrl: string;
  description: string;
};

type Props = {
  product: Product;
  /** Persistencia delegada ao pai (server action). Retorna erro p/ exibir, ou null em sucesso. */
  onSave: (id: string | null, payload: ProductFormPayload) => Promise<string | null>;
  onClose: () => void;
};

export function ProductFormModal({ product, onSave, onClose }: Props) {
  const isNew = product.id === "";
  const [name, setName] = useState(product.name);
  const [category, setCategory] = useState<Category>(product.category);
  const [sku, setSku] = useState(product.sku);
  const [description, setDescription] = useState(product.description);
  const [priceReais, setPriceReais] = useState(isNew ? "" : (product.priceCents / 100).toFixed(2));
  const [discountPct, setDiscountPct] = useState(product.discountPct);
  const [stock, setStock] = useState(String(product.stock));
  const [imageUrl, setImageUrl] = useState(product.imageUrl);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const priceCents = Math.round((parseFloat(priceReais.replace(",", ".")) || 0) * 100);
  const stockNum = Math.max(0, Math.trunc(Number(stock) || 0));
  const final = finalPriceCents({ priceCents, discountPct });
  const descOver = description.length > DESC_MAX;
  const canSave = !saving && name.trim() !== "" && sku.trim() !== "" && priceCents > 0 && !descOver;

  const submit = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    const err = await onSave(isNew ? null : product.id, {
      name: name.trim(),
      category,
      sku: sku.trim(),
      priceCents,
      discountPct,
      stock: stockNum,
      badge: product.badge,
      imageUrl: imageUrl.trim() || "/products/placeholder.svg",
      description: description.trim(),
    });
    setSaving(false);
    if (err) setError(err);
  };

  return (
    <Modal
      title={isNew ? "Novo produto" : "Editar produto"}
      sub={isNew ? undefined : product.id}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={styles.secondary} onClick={onClose} disabled={saving}>
            Cancelar
          </button>
          <button type="button" className={styles.primary} onClick={submit} disabled={!canSave}>
            {saving ? "Salvando…" : "Salvar"}
          </button>
        </>
      }
    >
      <div className={styles.grid}>
        <div className={`${styles.field} ${styles.full}`}>
          <label className={styles.label} htmlFor="pf-name">
            Título
          </label>
          <input
            id="pf-name"
            className={styles.input}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Nome do produto"
            required
          />
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="pf-cat">
            Categoria
          </label>
          <select
            id="pf-cat"
            className={styles.select}
            value={category}
            onChange={(e) => setCategory(e.target.value as Category)}
          >
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="pf-sku">
            SKU
          </label>
          <input
            id="pf-sku"
            className={styles.input}
            value={sku}
            onChange={(e) => setSku(e.target.value)}
            placeholder="Ex.: BB-SCAR"
            required
          />
        </div>

        <div className={`${styles.field} ${styles.full}`}>
          <label className={styles.label} htmlFor="pf-img">
            Imagem (URL)
          </label>
          <input
            id="pf-img"
            className={styles.input}
            value={imageUrl}
            onChange={(e) => setImageUrl(e.target.value)}
            placeholder="/products/placeholder.svg"
          />
        </div>

        <div className={`${styles.field} ${styles.full}`}>
          <label className={styles.label} htmlFor="pf-desc">
            Descrição
          </label>
          <textarea
            id="pf-desc"
            className={styles.textarea}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <span className={`${styles.counter} ${descOver ? styles.counterOver : ""}`}>
            {description.length}/{DESC_MAX}
          </span>
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="pf-price">
            Preço base (R$)
          </label>
          <input
            id="pf-price"
            className={styles.input}
            type="text"
            inputMode="decimal"
            value={priceReais}
            onChange={(e) => setPriceReais(e.target.value)}
            placeholder="0,00"
            required
          />
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="pf-stock">
            Estoque
          </label>
          <input
            id="pf-stock"
            className={styles.input}
            type="number"
            min="0"
            step="1"
            inputMode="numeric"
            value={stock}
            onChange={(e) => setStock(e.target.value)}
            placeholder="0"
          />
        </div>

        <div className={styles.field}>
          <div className={styles.discRow}>
            <label className={styles.label} htmlFor="pf-disc">
              Desconto
            </label>
            <span className={styles.discVal}>{discountPct}%</span>
          </div>
          <input
            id="pf-disc"
            className={styles.slider}
            type="range"
            min="0"
            max="80"
            step="1"
            value={discountPct}
            onChange={(e) => setDiscountPct(Number(e.target.value))}
            aria-valuenow={discountPct}
            aria-valuemin={0}
            aria-valuemax={80}
            aria-valuetext={`${discountPct}% de desconto`}
          />
        </div>

        <div className={`${styles.finalCard} ${styles.full}`}>
          <span className={styles.finalLabel}>Preço final</span>
          <span>
            {discountPct > 0 && priceCents > 0 && (
              <span className={`${styles.finalStrike} tnum`}>{formatBRL(priceCents)}</span>
            )}
            <span className={`${styles.finalValue} tnum`}>{formatBRL(final)}</span>
          </span>
        </div>

        {error && (
          <p className={`${styles.full} ${styles.counterOver}`} role="alert">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
