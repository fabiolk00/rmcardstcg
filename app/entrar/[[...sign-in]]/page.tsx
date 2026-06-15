import { SignIn } from "@clerk/nextjs";
import { AuthShell } from "@/components/layout/AuthShell";
import { AuthPlaceholder } from "@/components/layout/AuthPlaceholder";
import { isClerkConfigured } from "@/lib/services/clerk/config";

export default function EntrarPage() {
  return (
    <AuthShell>{isClerkConfigured() ? <SignIn /> : <AuthPlaceholder mode="entrar" />}</AuthShell>
  );
}
