"use client";

import { useState } from "react";

import type { CustomerProfile } from "@/lib/data/profile";
import { SpinnerLabel } from "@/components/ui/Spinner";
import { saveMyProfile, type ProfileFormInput } from "./actions";
import styles from "./conta.module.css";

// UFs para o select de estado (mesma lista do CheckoutView).
const UFS = [
  "AC",
  "AL",
  "AP",
  "AM",
  "BA",
  "CE",
  "DF",
  "ES",
  "GO",
  "MA",
  "MT",
  "MS",
  "MG",
  "PA",
  "PB",
  "PR",
  "PE",
  "PI",
  "RJ",
  "RN",
  "RS",
  "RO",
  "RR",
  "SC",
  "SP",
  "SE",
  "TO",
] as const;

type Form = {
  name: string;
  email: string;
  phone: string;
  cpfCnpj: string;
  cep: string;
  street: string;
  number: string;
  complement: string;
  district: string;
  city: string;
  state: string;
};

/** Mascara de exibicao do CEP: NNNNN-NNN (o server persiste so os 8 digitos). */
function formatCep(value: string): string {
  const digits = value.replace(/\D/g, "").slice(0, 8);
  return digits.length > 5 ? `${digits.slice(0, 5)}-${digits.slice(5)}` : digits;
}

function toForm(profile: CustomerProfile | null): Form {
  return {
    name: profile?.name ?? "",
    email: profile?.email ?? "",
    phone: profile?.phone ?? "",
    cpfCnpj: profile?.cpfCnpj ?? "",
    cep: formatCep(profile?.cep ?? ""),
    street: profile?.street ?? "",
    number: profile?.number ?? "",
    complement: profile?.complement ?? "",
    district: profile?.district ?? "",
    city: profile?.city ?? "",
    state: profile?.state ?? "",
  };
}

/**
 * Formulario de perfil/endereco do cliente. Os dados chegam pela server page
 * (sem fetch client-side); estados de salvando/sucesso/erro na propria tela.
 * A validacao de verdade e server-side (saveMyProfile); aqui so o pre-check
 * de obrigatorios, como no CheckoutView.
 */
export function ContaForm({ initialProfile }: { initialProfile: CustomerProfile | null }) {
  const [form, setForm] = useState<Form>(() => toForm(initialProfile));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const set = (key: keyof Form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    setForm((f) => ({ ...f, [key]: e.target.value }));
    setSaved(false);
  };

  const onCepChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setForm((f) => ({ ...f, cep: formatCep(e.target.value) }));
    setSaved(false);
  };

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);

    const required: [keyof Form, string][] = [
      ["name", "Informe o nome."],
      ["phone", "Informe o telefone."],
      ["cep", "Informe o CEP."],
      ["street", "Informe o endereço."],
      ["city", "Informe a cidade."],
      ["state", "Informe o estado."],
    ];
    for (const [key, msg] of required) {
      if (!form[key].trim()) {
        setError(msg);
        return;
      }
    }

    setSaving(true);
    const input: ProfileFormInput = { ...form };
    const res = await saveMyProfile(input);
    setSaving(false);

    if (!res.ok) {
      setError(res.error);
      return;
    }
    setSaved(true);
  }

  return (
    <form className={styles.form} onSubmit={onSubmit} noValidate>
      <h2 className={styles.sectionTitle}>Dados de contato</h2>
      <div className={styles.grid}>
        <Field className={styles.full} label="Nome completo">
          <input
            className={styles.input}
            value={form.name}
            onChange={set("name")}
            autoComplete="name"
          />
        </Field>
        <Field label="E-mail (opcional)">
          <input
            className={styles.input}
            type="email"
            value={form.email}
            onChange={set("email")}
            autoComplete="email"
          />
        </Field>
        <Field label="Telefone">
          <input
            className={styles.input}
            value={form.phone}
            onChange={set("phone")}
            placeholder="(41) 99999-9999"
            autoComplete="tel"
          />
        </Field>
        <Field label="CPF/CNPJ (opcional)">
          <input
            className={styles.input}
            value={form.cpfCnpj}
            onChange={set("cpfCnpj")}
            placeholder="000.000.000-00"
          />
        </Field>
      </div>

      <h2 className={styles.sectionTitle}>Endereço de entrega</h2>
      <div className={styles.grid}>
        <Field label="CEP">
          <input
            className={styles.input}
            value={form.cep}
            onChange={onCepChange}
            placeholder="80000-000"
            autoComplete="postal-code"
          />
        </Field>
        <Field label="Cidade">
          <input
            className={styles.input}
            value={form.city}
            onChange={set("city")}
            autoComplete="address-level2"
          />
        </Field>
        <Field className={styles.full} label="Endereço (rua)">
          <input
            className={styles.input}
            value={form.street}
            onChange={set("street")}
            autoComplete="street-address"
          />
        </Field>
        <Field label="Número (opcional)">
          <input className={styles.input} value={form.number} onChange={set("number")} />
        </Field>
        <Field label="Complemento (opcional)">
          <input className={styles.input} value={form.complement} onChange={set("complement")} />
        </Field>
        <Field label="Bairro (opcional)">
          <input className={styles.input} value={form.district} onChange={set("district")} />
        </Field>
        <Field label="Estado (UF)">
          <select
            className={styles.select}
            value={form.state}
            onChange={set("state")}
            autoComplete="address-level1"
          >
            <option value="">—</option>
            {UFS.map((uf) => (
              <option key={uf} value={uf}>
                {uf}
              </option>
            ))}
          </select>
        </Field>
      </div>

      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {saved && (
        <p className={styles.success} role="status">
          Perfil salvo. Ele preenche automaticamente o seu próximo checkout.
        </p>
      )}

      <button type="submit" className={styles.submit} disabled={saving}>
        {saving ? <SpinnerLabel>Salvando…</SpinnerLabel> : "Salvar perfil"}
      </button>
    </form>
  );
}

function Field({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <label className={`${styles.field} ${className ?? ""}`}>
      <span className={styles.label}>{label}</span>
      {children}
    </label>
  );
}
