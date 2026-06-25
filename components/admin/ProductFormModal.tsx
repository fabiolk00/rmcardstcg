"use client";

import { useRef, useState } from "react";
import Image from "next/image";
import type { Product, Category } from "@/lib/data/types";
import { CATEGORIES } from "@/lib/data/types";
import { finalPriceCents } from "@/lib/data/pricing";
import { formatBRL } from "@/lib/utils/currency";
import { Modal } from "@/components/ui/Modal";
import { Icon } from "@/components/ui/Icon";
import { Spinner, SpinnerLabel } from "@/components/ui/Spinner";
import { uploadProductImageAction } from "@/app/admin/produtos/actions";
import { CATEGORY_PACKAGE } from "@/lib/services/superfrete/dimensions";
import styles from "./ProductFormModal.module.css";

const DESC_MAX = 300;
const PLACEHOLDER_IMAGE = "/products/placeholder.svg";
// Dica de UX no client; a validacao autoritativa de formato/tamanho e no servidor.
const ACCEPTED_IMAGE = "image/png,image/jpeg,image/webp,image/gif";
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

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
  isCarousel: boolean;
  /** Medidas do pacote para frete (Int; 0 = usa o default da categoria). */
  weightGrams: number;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
};

type Props = {
  product: Product;
  /**
   * Persistencia delegada ao pai (server action). Retorna erro p/ exibir, ou null em
   * sucesso. `original` carrega os valores editaveis que o form CARREGOU (client
   * baseline) p/ o diff de intencao do servidor; null em produto novo (nao ha original).
   */
  onSave: (
    id: string | null,
    payload: ProductFormPayload,
    original: ProductFormPayload | null,
  ) => Promise<string | null>;
  onClose: () => void;
};

export function ProductFormModal({ product, onSave, onClose }: Props) {
  const isNew = product.id === "";
  // Snapshot dos campos editaveis no momento em que o form abriu (o modal remonta por
  // edicao, entao este lazy-init captura exatamente o produto sendo editado). Enviado
  // como `original` no save p/ o servidor diffar contra o que ESTE editor carregou —
  // evitando reescrever um campo intocado com valor stale (lost update concorrente).
  const [original] = useState<ProductFormPayload>(() => ({
    name: product.name,
    category: product.category,
    sku: product.sku,
    priceCents: product.priceCents,
    discountPct: product.discountPct,
    stock: product.stock,
    badge: product.badge,
    imageUrl: product.imageUrl,
    description: product.description,
    isCarousel: product.isCarousel,
    weightGrams: product.weightGrams,
    lengthCm: product.lengthCm,
    widthCm: product.widthCm,
    heightCm: product.heightCm,
  }));
  const [name, setName] = useState(product.name);
  const [category, setCategory] = useState<Category>(product.category);
  const [sku, setSku] = useState(product.sku);
  const [description, setDescription] = useState(product.description);
  const [priceReais, setPriceReais] = useState(isNew ? "" : (product.priceCents / 100).toFixed(2));
  const [discountPct, setDiscountPct] = useState(product.discountPct);
  const [stock, setStock] = useState(String(product.stock));
  const [imageUrl, setImageUrl] = useState(product.imageUrl);
  const [isCarousel, setIsCarousel] = useState(product.isCarousel);
  // Medidas para frete (string no input; 0 no produto -> vazio -> usa default da categoria).
  const dimStr = (v: number) => (v > 0 ? String(v) : "");
  const [weightGrams, setWeightGrams] = useState(dimStr(product.weightGrams));
  const [lengthCm, setLengthCm] = useState(dimStr(product.lengthCm));
  const [widthCm, setWidthCm] = useState(dimStr(product.widthCm));
  const [heightCm, setHeightCm] = useState(dimStr(product.heightCm));
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const priceCents = Math.round((parseFloat(priceReais.replace(",", ".")) || 0) * 100);
  const stockNum = Math.max(0, Math.trunc(Number(stock) || 0));
  const toInt = (s: string) => Math.max(0, Math.trunc(Number(s) || 0));
  const pkgDefault = CATEGORY_PACKAGE[category];
  const final = finalPriceCents({ priceCents, discountPct });
  const descOver = description.length > DESC_MAX;
  const hasCustomImage = imageUrl.trim() !== "" && imageUrl !== PLACEHOLDER_IMAGE;
  const canSave =
    !saving && !uploading && name.trim() !== "" && sku.trim() !== "" && priceCents > 0 && !descOver;

  // Seleciona um arquivo -> valida no client (UX) -> sobe pro Supabase via server
  // action -> grava a URL publica em imageUrl. O save normal persiste imageUrl.
  const onPickImage = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // permite re-selecionar o mesmo arquivo
    if (!file) return;

    if (!ACCEPTED_IMAGE.split(",").includes(file.type)) {
      setError("Formato inválido. Use PNG, JPG, WEBP ou GIF.");
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setError("Imagem muito grande (máx. 4 MB).");
      return;
    }

    setError(null);
    setUploading(true);
    const fd = new FormData();
    fd.append("file", file);
    const res = await uploadProductImageAction(fd);
    setUploading(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setImageUrl(res.data);
  };

  const submit = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    const err = await onSave(
      isNew ? null : product.id,
      {
        name: name.trim(),
        category,
        sku: sku.trim(),
        priceCents,
        discountPct,
        stock: stockNum,
        badge: product.badge,
        imageUrl: imageUrl.trim() || "/products/placeholder.svg",
        description: description.trim(),
        isCarousel,
        weightGrams: toInt(weightGrams),
        lengthCm: toInt(lengthCm),
        widthCm: toInt(widthCm),
        heightCm: toInt(heightCm),
      },
      isNew ? null : original,
    );
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
            {saving ? <SpinnerLabel size={14}>Salvando…</SpinnerLabel> : "Salvar"}
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
          <span className={styles.label}>Imagem</span>
          <div className={styles.imageRow}>
            <span className={styles.imagePreview}>
              <Image
                src={imageUrl.trim() || PLACEHOLDER_IMAGE}
                alt=""
                width={72}
                height={72}
                className={styles.imageThumb}
              />
            </span>
            <div className={styles.imageActions}>
              <input
                ref={fileRef}
                type="file"
                accept={ACCEPTED_IMAGE}
                className={styles.fileInput}
                onChange={onPickImage}
                aria-label="Enviar imagem do produto"
              />
              <button
                type="button"
                className={styles.uploadBtn}
                onClick={() => fileRef.current?.click()}
                disabled={uploading || saving}
              >
                {uploading ? <Spinner size={14} /> : <Icon name="box" size={14} />}
                {uploading ? "Enviando…" : hasCustomImage ? "Trocar imagem" : "Enviar imagem"}
              </button>
              <span className={styles.imageHint}>PNG, JPG, WEBP ou GIF até 4 MB.</span>
            </div>
          </div>
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

        <label className={`${styles.carouselField} ${styles.full}`} htmlFor="pf-carousel">
          <span className={styles.carouselText}>
            <span className={styles.label}>Carrossel?</span>
            <span className={styles.carouselHint}>
              Exibir este produto na vitrine “Em destaque” da home.
            </span>
          </span>
          <input
            id="pf-carousel"
            type="checkbox"
            className={styles.carouselCheck}
            checked={isCarousel}
            onChange={(e) => setIsCarousel(e.target.checked)}
          />
        </label>

        <div className={`${styles.field} ${styles.full}`}>
          <span className={styles.label}>Embalagem para frete</span>
          <p className={styles.pkgHint}>
            Em branco usa o padrão de “{category}”: {pkgDefault.weightGrams} g ·{" "}
            {pkgDefault.lengthCm}×{pkgDefault.widthCm}×{pkgDefault.heightCm} cm.
          </p>
          <div className={styles.pkgGrid}>
            <span className={styles.pkgItem}>
              <span className={styles.pkgLabel}>Peso (g)</span>
              <input
                className={styles.input}
                type="number"
                min="0"
                step="1"
                inputMode="numeric"
                value={weightGrams}
                onChange={(e) => setWeightGrams(e.target.value)}
                placeholder={String(pkgDefault.weightGrams)}
                aria-label="Peso para frete em gramas"
              />
            </span>
            <span className={styles.pkgItem}>
              <span className={styles.pkgLabel}>Compr. (cm)</span>
              <input
                className={styles.input}
                type="number"
                min="0"
                step="1"
                inputMode="numeric"
                value={lengthCm}
                onChange={(e) => setLengthCm(e.target.value)}
                placeholder={String(pkgDefault.lengthCm)}
                aria-label="Comprimento em cm"
              />
            </span>
            <span className={styles.pkgItem}>
              <span className={styles.pkgLabel}>Largura (cm)</span>
              <input
                className={styles.input}
                type="number"
                min="0"
                step="1"
                inputMode="numeric"
                value={widthCm}
                onChange={(e) => setWidthCm(e.target.value)}
                placeholder={String(pkgDefault.widthCm)}
                aria-label="Largura em cm"
              />
            </span>
            <span className={styles.pkgItem}>
              <span className={styles.pkgLabel}>Altura (cm)</span>
              <input
                className={styles.input}
                type="number"
                min="0"
                step="1"
                inputMode="numeric"
                value={heightCm}
                onChange={(e) => setHeightCm(e.target.value)}
                placeholder={String(pkgDefault.heightCm)}
                aria-label="Altura em cm"
              />
            </span>
          </div>
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
