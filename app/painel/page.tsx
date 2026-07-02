import { redirect } from "next/navigation";

// /painel nao tem tela propria — o painel do cliente comeca em /painel/pedidos.
// Sem esta pagina, /painel (so o layout existe) responde 404. O guard de usuario
// ativo roda no layout ANTES deste redirect.
export default function PainelIndexPage() {
  redirect("/painel/pedidos");
}
