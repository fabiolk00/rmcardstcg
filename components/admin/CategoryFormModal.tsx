"use client";

import { useState } from "react";
import type { Category } from "@/lib/data/categories";
import type { CategoryFormPayload } from "@/app/admin/categorias/actions";
import { Modal } from "@/components/ui/Modal";
import { SpinnerLabel } from "@/components/ui/Spinner";
import styles from "./CategoryFormModal.module.css";

type Props = {
  /** null => criando; Category => editando. */
  category: Category | null;
  pending: boolean;
  onClose: () => void;
  onSave: (id: string | null, payload: CategoryFormPayload) => void;
};

// Espelha os limites de lib/data/categories.ts (normalizeCategoryInput).
const NAME_MIN = 2;
const NAME_MAX = 100;
const DESC_MAX = 500;

export function CategoryFormModal({ category, pending, onClose, onSave }: Props) {
  const isNew = category === null;
  const [name, setName] = useState(category?.name ?? "");
  const [description, setDescription] = useState(category?.description ?? "");
  const [error, setError] = useState<string | null>(null);

  const trimmedName = name.trim();
  const nameValid = trimmedName.length >= NAME_MIN && trimmedName.length <= NAME_MAX;
  const descValid = description.trim().length <= DESC_MAX;
  const canSave = nameValid && descValid && !pending;

  const submit = () => {
    setError(null);
    if (!nameValid) {
      setError(`O nome deve ter entre ${NAME_MIN} e ${NAME_MAX} caracteres.`);
      return;
    }
    if (!descValid) {
      setError(`A descrição excede ${DESC_MAX} caracteres.`);
      return;
    }

    const payload: CategoryFormPayload = {
      name: trimmedName,
      description: description.trim() ? description.trim() : null,
    };
    onSave(isNew ? null : category.id, payload);
  };

  return (
    <Modal
      title={isNew ? "Nova categoria" : "Editar categoria"}
      sub={isNew ? undefined : category.name}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={styles.secondary} onClick={onClose}>
            Cancelar
          </button>
          <button type="button" className={styles.primary} onClick={submit} disabled={!canSave}>
            {pending ? <SpinnerLabel size={14}>Salvando…</SpinnerLabel> : "Salvar"}
          </button>
        </>
      }
    >
      <div className={styles.grid}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="cat-name">
            Nome
          </label>
          <input
            id="cat-name"
            className={styles.input}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Ex.: Coleção Especial"
            maxLength={NAME_MAX}
            required
          />
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="cat-desc">
            Descrição
          </label>
          <textarea
            id="cat-desc"
            className={styles.textarea}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Opcional"
            maxLength={DESC_MAX}
          />
          <span className={styles.hint}>
            {description.trim().length}/{DESC_MAX}
          </span>
        </div>

        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
