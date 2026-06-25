import { redirect } from "next/navigation";
import { isClerkConfigured } from "@/lib/services/clerk/config";
import { SSOCallback } from "./SSOCallback";

// Retorno do OAuth (Google): o Clerk finaliza o handshake no cliente e manda para
// /pos-login (roteador por role). Sem Clerk configurado, nao ha o que finalizar.
export default function SSOCallbackPage() {
  if (!isClerkConfigured()) redirect("/");
  return <SSOCallback />;
}
