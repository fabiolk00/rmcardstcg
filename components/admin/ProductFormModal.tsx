"use client";

import { useState } from "react";
import type { Product, Category } from "@/lib/data/types";
import { CATEGORIES } from "@/lib/data/types";
import { finalPriceCents } from "@/lib/data/pricing";
import { formatBRL } from "@/lib/utils/currency";
import { Modal } from "@/components/ui/Modal";
import styles from "./ProductFormModal.module.css";

const DESC_MAX = 300;

// Marcas combinantes (acentos) U+0300–U+036F montadas por codigo (fonte ASCII).
const COMBINING = new RegExp(`[${String.fromCharCode(0x300)}-${String.fromCharCode(0x36f)}]`, "g");
const slugify = (s: string) =>
  s
    .normalize("NFD")
    .replace(COMBINING, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

type Props = {
  product: Product;
  onClose: () => void;
  onSave: (p: Product) => void;
};

export function ProductFormModal({ product, onClose, onSave }: Props) {
  const isNew = product.id === "";
  const [name, setName] = useState(product.name);
  const [category, setCategory] = useState<Category>(product.category);
  const [sku, setSku] = useState(product.sku);
  const [description, setDescription] = useState(product.description);
  const [priceReais, setPriceReais] = useState(isNew ? "" : (product.priceCents / 100).toFixed(2));
  const [discountPct, setDiscountPct] = useState(product.discountPct);
  const [imageUrl, setImageUrl] = useState(product.imageUrl);

  const priceCents = Math.round((parseFloat(priceReais.replace(",", ".")) || 0) * 100);
  const final = finalPriceCents({ priceCents, discountPct });
  const descOver = description.length > DESC_MAX;
  const canSave = name.trim() !== "" && sku.trim() !== "" && priceCents > 0 && !descOver;

  const submit = () => {
    if (!canSave) return;
    onSave({
      ...product,
      id: isNew ? crypto.randomUUID() : product.id,
      slug: slugify(name) || product.slug || crypto.randomUUID(),
      name: name.trim(),
      category,
      sku: sku.trim(),
      description: description.trim(),
      priceCents,
      discountPct,
      imageUrl: imageUrl.trim() || "/products/placeholder.svg",
      createdAt: isNew ? new Date().toISOString() : product.createdAt,
    });
  };

  return (
    <Modal
      title={isNew ? "Novo produto" : "Editar produto"}
      sub={isNew ? undefined : product.id}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={styles.secondary} onClick={onClose}>
            Cancelar
          </button>
          <button type="button" className={styles.primary} onClick={submit} disabled={!canSave}>
            Salvar
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
      </div>
    </Modal>
  );
}
