import { SignUp } from "@clerk/nextjs";
import { AuthShell } from "@/components/layout/AuthShell";
import { AuthPlaceholder } from "@/components/layout/AuthPlaceholder";
import { isClerkConfigured } from "@/lib/services/clerk/config";

export default function CriarContaPage() {
  return (
    <AuthShell>
      {isClerkConfigured() ? <SignUp /> : <AuthPlaceholder mode="criar-conta" />}
    </AuthShell>
  );
}
