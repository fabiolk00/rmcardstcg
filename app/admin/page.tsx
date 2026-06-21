import { redirect } from "next/navigation";

// /admin nao tem tela propria — o painel comeca em /admin/produtos. Sem esta
// pagina, /admin (so o layout existe) responde 404. O guard de role roda no
// layout ANTES deste redirect, entao a rota continua fail-closed.
export default function AdminIndexPage() {
  redirect("/admin/produtos");
}
