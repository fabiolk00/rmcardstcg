import { PageLoader } from "@/components/ui/PageLoader";

// Carregamento ao navegar entre paginas da loja (mantem Topbar/Footer; so o
// conteudo mostra o spinner enquanto a rota nova faz fetch).
export default function Loading() {
  return <PageLoader />;
}
