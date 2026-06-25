"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth, useSignUp } from "@clerk/nextjs";
import { Icon } from "@/components/ui/Icon";
import { GoogleIcon } from "./GoogleIcon";
import { clerkError } from "./clerkError";
import styles from "./AuthForm.module.css";

// Fluxo de cadastro custom usando a API de signals do Clerk (useSignUp -> signUp
// future resource): nome + e-mail + senha (com regras), depois verificacao por
// codigo de e-mail. Google em um clique. O markup reproduz a "segunda tela".
export function SignUpForm({ redirectUrl }: { redirectUrl: string }) {
  const { signUp } = useSignUp();
  const { isLoaded } = useAuth();
  const router = useRouter();

  const [step, setStep] = useState<"form" | "verify">("form");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const ruleLength = password.length >= 8;
  const ruleSpecial = /[^A-Za-z0-9]/.test(password);
  const canSubmit =
    isLoaded &&
    !busy &&
    firstName.trim() !== "" &&
    email.trim() !== "" &&
    ruleLength &&
    ruleSpecial;

  async function handleGoogle() {
    if (!isLoaded || busy) return;
    setError("");
    setBusy(true);
    const { error: err } = await signUp.sso({
      strategy: "oauth_google",
      redirectUrl,
      redirectCallbackUrl: `${window.location.origin}/sso-callback`,
    });
    if (err) {
      setError(clerkError(err));
      setBusy(false);
    }
  }

  async function handleSignUp(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setError("");
    setBusy(true);
    const created = await signUp.create({ emailAddress: email, password, firstName, lastName });
    if (created.error) {
      setError(clerkError(created.error));
      setBusy(false);
      return;
    }
    const sent = await signUp.verifications.sendEmailCode();
    if (sent.error) {
      setError(clerkError(sent.error));
      setBusy(false);
      return;
    }
    setBusy(false);
    setStep("verify");
  }

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    if (!isLoaded || busy) return;
    setError("");
    setBusy(true);
    const verified = await signUp.verifications.verifyEmailCode({ code });
    if (verified.error) {
      setError(clerkError(verified.error));
      setBusy(false);
      return;
    }
    const { error: finErr } = await signUp.finalize({ navigate: () => router.push(redirectUrl) });
    if (finErr) {
      setError(clerkError(finErr));
      setBusy(false);
    }
  }

  if (step === "verify") {
    return (
      <form className={styles.form} onSubmit={handleVerify}>
        <h1 className={styles.heading}>Verifique seu e-mail</h1>
        <p className={styles.subheading}>
          Enviamos um código para <strong>{email}</strong>.
        </p>

        {error && <p className={styles.error}>{error}</p>}

        <div className={styles.field}>
          <label className={styles.label} htmlFor="verify-code">
            Código de verificação
          </label>
          <input
            id="verify-code"
            className={styles.input}
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="Digite o código"
            value={code}
            onChange={(ev) => setCode(ev.target.value)}
            required
          />
        </div>

        <button className={styles.submit} type="submit" disabled={!isLoaded || busy}>
          {busy ? "Confirmando…" : "Confirmar e entrar"}
        </button>

        <button
          type="button"
          className={styles.back}
          onClick={() => {
            setStep("form");
            setError("");
          }}
        >
          Voltar
        </button>
      </form>
    );
  }

  return (
    <form className={styles.form} onSubmit={handleSignUp}>
      <h1 className={styles.heading}>Criar conta</h1>

      {error && <p className={styles.error}>{error}</p>}

      <div className={styles.social}>
        <button
          type="button"
          className={styles.googleBtn}
          onClick={handleGoogle}
          disabled={!isLoaded || busy}
        >
          <GoogleIcon size={18} />
          Continuar com Google
        </button>
      </div>

      <div className={styles.divider}>
        <span className={styles.dividerText}>ou</span>
      </div>

      <div className={styles.row}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="signup-first">
            Primeiro nome
          </label>
          <input
            id="signup-first"
            className={styles.input}
            type="text"
            autoComplete="given-name"
            placeholder="Primeiro nome"
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
            required
          />
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="signup-last">
            Sobrenome
          </label>
          <input
            id="signup-last"
            className={styles.input}
            type="text"
            autoComplete="family-name"
            placeholder="Sobrenome"
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
          />
        </div>
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="signup-email">
          E-mail
        </label>
        <input
          id="signup-email"
          className={styles.input}
          type="email"
          autoComplete="email"
          placeholder="Digite seu e-mail"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="signup-password">
          Senha
        </label>
        <div className={styles.passwordWrap}>
          <input
            id="signup-password"
            className={styles.input}
            type={showPw ? "text" : "password"}
            autoComplete="new-password"
            placeholder="Digite sua senha"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          <button
            type="button"
            className={styles.eyeBtn}
            onClick={() => setShowPw((s) => !s)}
            aria-label={showPw ? "Ocultar senha" : "Mostrar senha"}
          >
            <Icon name={showPw ? "eyeOff" : "eye"} size={18} />
          </button>
        </div>
      </div>

      <ul className={styles.rules}>
        <li className={`${styles.rule} ${ruleLength ? styles.ruleOk : ""}`}>
          <span className={styles.ruleIcon}>
            <Icon name="check" size={10} />
          </span>
          Mínimo de 8 caracteres
        </li>
        <li className={`${styles.rule} ${ruleSpecial ? styles.ruleOk : ""}`}>
          <span className={styles.ruleIcon}>
            <Icon name="check" size={10} />
          </span>
          Pelo menos 1 caractere especial
        </li>
      </ul>

      {/* Alvo do Smart CAPTCHA do Clerk (protecao anti-bot no cadastro) */}
      <div id="clerk-captcha" className={styles.captcha} />

      <button className={styles.submit} type="submit" disabled={!canSubmit}>
        <Icon name="arrow" size={16} />
        {busy ? "Criando conta…" : "Continuar"}
      </button>
    </form>
  );
}
