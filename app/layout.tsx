import type { Metadata } from "next";
import { Suspense } from "react";
import { ClerkProvider } from "@clerk/nextjs";
import { isClerkConfigured } from "@/lib/services/clerk/config";
import { clerkAppearance } from "@/lib/services/clerk/appearance";
import { clerkLocalization } from "@/lib/services/clerk/localization";
import { RouteProgress } from "@/components/layout/RouteProgress";
import "./globals.css";

export const metadata: Metadata = {
  title: "RM Cards — Pokémon TCG",
  description: "Loja de cartas e produtos Pokémon TCG.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const tree = (
    <html lang="pt-BR">
      <body>
        <Suspense fallback={null}>
          <RouteProgress />
        </Suspense>
        {children}
      </body>
    </html>
  );

  // Mock-first: sem Clerk configurado, o app roda sem o provider.
  if (!isClerkConfigured()) return tree;

  return (
    <ClerkProvider appearance={clerkAppearance} localization={clerkLocalization}>
      {tree}
    </ClerkProvider>
  );
}
