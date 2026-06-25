import { PageLoader } from "@/components/ui/PageLoader";

// Fallback de carregamento de qualquer rota de topo (auth, pos-login, etc.).
export default function Loading() {
  return <PageLoader />;
}
