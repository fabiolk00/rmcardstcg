"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth, useSignIn } from "@clerk/nextjs";
import { Icon } from "@/components/ui/Icon";
import { GoogleIcon } from "./GoogleIcon";
import { clerkError } from "./clerkError";
import styles from "./AuthForm.module.css";

type Step = "signIn" | "resetRequest" | "resetConfirm";

// Fluxo de login custom usando a API de signals do Clerk (useSignIn -> signIn
// future resource). Senha + Google + "esqueci a senha" (codigo por e-mail -> nova
// senha). O markup e proprio, entao casa com o design; o Clerk so move o estado.
export function SignInForm({ redirectUrl }: { redirectUrl: string }) {
  const { signIn } = useSignIn();
  const { isLoaded } = useAuth();
  const router = useRouter();

  const [step, setStep] = useState<Step>("signIn");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const ready = isLoaded && !busy;

  async function handleGoogle() {
    if (!ready) return;
    setError("");
    setBusy(true);
    try {
      const { error: err } = await signIn.sso({
        strategy: "oauth_google",
        redirectUrl,
        redirectCallbackUrl: `${window.location.origin}/sso-callback`,
      });
      if (err) {
        setError(clerkError(err));
        setBusy(false);
      }
    } catch (err) {
      setError(clerkError(err));
      setBusy(false);
    }
  }

  // Depois que um fator e verificado sem erro, o signIn.status decide o proximo
  // passo. finalize() SO funciona com status 'complete' (cria a sessao); chamar
  // fora disso lanca "cannot finalize sign-in without created session". Este
  // resolver roteia cada status em vez de finalizar as cegas.
  async function finishSignIn() {
    if (signIn.status === "complete") {
      const { error: finErr } = await signIn.finalize({ navigate: () => router.push(redirectUrl) });
      if (finErr) {
        setError(clerkError(finErr));
        setBusy(false);
      }
      return;
    }
    // Ja havia uma sessao ativa para esta conta — nao cria outra; segue ao destino.
    if (signIn.existingSession) {
      router.push(redirectUrl);
      return;
    }
    if (signIn.status === "needs_new_password") {
      setStep("resetRequest");
      setError("Por segurança, redefina sua senha para continuar.");
      setBusy(false);
      return;
    }
    // needs_second_factor / needs_client_trust / etc.: este app nao tem UI de MFA.
    setError("Sua conta exige uma verificação extra que ainda não está disponível por aqui. Fale com o suporte.");
    setBusy(false);
  }

  async function handleSignIn(e: React.FormEvent) {
    e.preventDefault();
    if (!ready) return;
    setError("");
    setBusy(true);
    try {
      const { error: err } = await signIn.password({ identifier: email, password });
      if (err) {
        setError(clerkError(err));
        setBusy(false);
        return;
      }
      await finishSignIn();
    } catch (err) {
      // Sem try/catch, um throw (ex.: challenge anti-bot sem alvo) deixava o botao
      // travado em "Entrando..." pra sempre, sem mensagem. Agora sempre solta.
      setError(clerkError(err));
      setBusy(false);
    }
  }

  async function handleResetRequest(e: React.FormEvent) {
    e.preventDefault();
    if (!ready) return;
    setError("");
    setBusy(true);
    try {
      const created = await signIn.create({ identifier: email });
      if (created.error) {
        setError(clerkError(created.error));
        setBusy(false);
        return;
      }
      const sent = await signIn.resetPasswordEmailCode.sendCode();
      if (sent.error) {
        setError(clerkError(sent.error));
        setBusy(false);
        return;
      }
      setBusy(false);
      setStep("resetConfirm");
    } catch (err) {
      setError(clerkError(err));
      setBusy(false);
    }
  }

  async function handleResetConfirm(e: React.FormEvent) {
    e.preventDefault();
    if (!ready) return;
    setError("");
    setBusy(true);
    try {
      const verified = await signIn.resetPasswordEmailCode.verifyCode({ code });
      if (verified.error) {
        setError(clerkError(verified.error));
        setBusy(false);
        return;
      }
      const submitted = await signIn.resetPasswordEmailCode.submitPassword({ password: newPassword });
      if (submitted.error) {
        setError(clerkError(submitted.error));
        setBusy(false);
        return;
      }
      await finishSignIn();
    } catch (err) {
      setError(clerkError(err));
      setBusy(false);
    }
  }

  if (step === "resetRequest" || step === "resetConfirm") {
    return (
      <form
        className={styles.form}
        onSubmit={step === "resetRequest" ? handleResetRequest : handleResetConfirm}
      >
        <h1 className={styles.heading}>Redefinir senha</h1>
        <p className={styles.subheading}>
          {step === "resetRequest"
            ? "Informe seu e-mail e enviaremos um código de redefinição."
            : "Digite o código que enviamos e escolha uma nova senha."}
        </p>

        {error && <p className={styles.error}>{error}</p>}

        {step === "resetRequest" ? (
          <div className={styles.field}>
            <label className={styles.label} htmlFor="reset-email">
              E-mail
            </label>
            <input
              id="reset-email"
              className={styles.input}
              type="email"
              autoComplete="email"
              placeholder="Digite seu e-mail"
              value={email}
              onChange={(ev) => setEmail(ev.target.value)}
              required
            />
          </div>
        ) : (
          <>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="reset-code">
                Código de verificação
              </label>
              <input
                id="reset-code"
                className={styles.input}
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="Digite o código"
                value={code}
                onChange={(ev) => setCode(ev.target.value)}
                required
              />
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="reset-newpw">
                Nova senha
              </label>
              <div className={styles.passwordWrap}>
                <input
                  id="reset-newpw"
                  className={styles.input}
                  type={showPw ? "text" : "password"}
                  autoComplete="new-password"
                  placeholder="Digite a nova senha"
                  value={newPassword}
                  onChange={(ev) => setNewPassword(ev.target.value)}
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
          </>
        )}

        {/* Mesmo alvo anti-bot do fluxo de login: signIn.create() (reset) tambem
            pode disparar o challenge na instancia de producao. */}
        <div id="clerk-captcha" className={styles.captcha} />

        <button className={styles.submit} type="submit" disabled={!ready}>
          {busy ? "Aguarde…" : step === "resetRequest" ? "Enviar código" : "Redefinir senha"}
        </button>

        <button
          type="button"
          className={styles.back}
          onClick={() => {
            setStep("signIn");
            setError("");
          }}
        >
          Voltar para o login
        </button>
      </form>
    );
  }

  return (
    <form className={styles.form} onSubmit={handleSignIn}>
      <h1 className={styles.heading}>Bem-vindo de volta.</h1>

      {error && <p className={styles.error}>{error}</p>}

      <div className={styles.social}>
        <button type="button" className={styles.googleBtn} onClick={handleGoogle} disabled={!ready}>
          <GoogleIcon size={18} />
          Continuar com Google
        </button>
      </div>

      <div className={styles.divider}>
        <span className={styles.dividerText}>ou</span>
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="signin-email">
          E-mail
        </label>
        <input
          id="signin-email"
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
        <label className={styles.label} htmlFor="signin-password">
          Senha
        </label>
        <div className={styles.passwordWrap}>
          <input
            id="signin-password"
            className={styles.input}
            type={showPw ? "text" : "password"}
            autoComplete="current-password"
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

      <button
        type="button"
        className={styles.forgot}
        onClick={() => {
          setStep("resetRequest");
          setError("");
        }}
      >
        Esqueceu sua senha?
      </button>

      {/* Alvo do Smart CAPTCHA do Clerk (protecao anti-bot). Sem ele, quando a
          instancia de PRODUCAO dispara o challenge, o signIn.password() fica
          pendente pra sempre e o botao trava em "Entrando..." (em dev/localhost
          a protecao e ignorada, por isso so quebra remoto). Espelha o SignUpForm. */}
      <div id="clerk-captcha" className={styles.captcha} />

      <button className={styles.submit} type="submit" disabled={!ready}>
        <Icon name="arrow" size={16} />
        {busy ? "Entrando…" : "Continuar"}
      </button>

      <p className={styles.legal}>
        Ao continuar, você concorda com os{" "}
        <Link href="/termos-de-uso" className={styles.legalLink} target="_blank" rel="noopener noreferrer">
          Termos de uso
        </Link>{" "}
        e a{" "}
        <Link
          href="/politica-de-privacidade"
          className={styles.legalLink}
          target="_blank"
          rel="noopener noreferrer"
        >
          Política de privacidade
        </Link>
        .
      </p>
    </form>
  );
}
