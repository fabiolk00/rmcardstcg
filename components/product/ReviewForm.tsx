"use client";

import Link from "next/link";
import { useState } from "react";
import { submitReviewAction } from "@/app/(storefront)/produto/[slug]/actions";
import styles from "./ReviewForm.module.css";

const BODY_MIN = 10;
const STARS = [1, 2, 3, 4, 5] as const;

/**
 * Formulario de avaliacao (vitrine). Gated por `canReview` (com Clerk ativo, so
 * autenticado; mock-first libera). Validacao de COMPONENTE (rating 1-5, nome, corpo
 * min 10) com feedback inline; o servidor revalida tudo de novo (camadas).
 */
export function ReviewForm({ slug, canReview }: { slug: string; canReview: boolean }) {
  const [open, setOpen] = useState(false);
  const [rating, setRating] = useState(0);
  const [hover, setHover] = useState(0);
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  if (!canReview) {
    return (
      <div className={styles.gate}>
        <span>Entre na sua conta para avaliar este produto.</span>
        <Link href="/entrar" className={styles.loginLink}>
          Entrar
        </Link>
      </div>
    );
  }

  if (done) {
    return (
      <div className={styles.done} role="status">
        Avaliação enviada! Ela aparecerá após a moderação. Obrigado 🙌
      </div>
    );
  }

  if (!open) {
    return (
      <button type="button" className={styles.openBtn} onClick={() => setOpen(true)}>
        Escrever avaliação
      </button>
    );
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (rating < 1) {
      setError("Escolha uma nota de 1 a 5 estrelas.");
      return;
    }
    if (name.trim().length < 2) {
      setError("Informe seu nome.");
      return;
    }
    if (body.trim().length < BODY_MIN) {
      setError(`A avaliação deve ter ao menos ${BODY_MIN} caracteres.`);
      return;
    }

    setSubmitting(true);
    const res = await submitReviewAction({
      slug,
      rating,
      title: title.trim() || null,
      body: body.trim(),
      authorName: name.trim(),
    });
    setSubmitting(false);
    if (res.ok) setDone(true);
    else setError(res.error);
  }

  const activeStars = hover || rating;

  return (
    <form className={styles.form} onSubmit={onSubmit} noValidate>
      <div className={styles.field}>
        <span className={styles.label}>Sua nota</span>
        <div className={styles.starInput} role="radiogroup" aria-label="Nota">
          {STARS.map((s) => {
            const on = activeStars >= s;
            return (
              <button
                key={s}
                type="button"
                className={styles.starBtn}
                aria-label={`${s} ${s === 1 ? "estrela" : "estrelas"}`}
                aria-pressed={rating === s}
                onMouseEnter={() => setHover(s)}
                onMouseLeave={() => setHover(0)}
                onFocus={() => setHover(s)}
                onBlur={() => setHover(0)}
                onClick={() => setRating(s)}
              >
                <svg
                  width="28"
                  height="28"
                  viewBox="0 0 24 24"
                  fill={on ? "currentColor" : "none"}
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                </svg>
              </button>
            );
          })}
        </div>
      </div>

      <label className={styles.field}>
        <span className={styles.label}>Seu nome</span>
        <input
          className={styles.input}
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={80}
          autoComplete="name"
        />
      </label>

      <label className={styles.field}>
        <span className={styles.label}>Título (opcional)</span>
        <input
          className={styles.input}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={120}
          placeholder="Resumo da sua experiência"
        />
      </label>

      <label className={styles.field}>
        <span className={styles.label}>Sua avaliação</span>
        <textarea
          className={styles.textarea}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={4}
          maxLength={2000}
          placeholder="Conte o que achou do produto (mín. 10 caracteres)."
        />
      </label>

      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

      <div className={styles.actions}>
        <button type="submit" className={styles.submit} disabled={submitting}>
          {submitting ? "Enviando…" : "Enviar avaliação"}
        </button>
        <button type="button" className={styles.cancel} onClick={() => setOpen(false)}>
          Cancelar
        </button>
      </div>
    </form>
  );
}
