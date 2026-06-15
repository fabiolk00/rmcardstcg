import { Webhook } from "svix";

import { NextResponse } from "next/server";

import { deleteUserByClerkId, upsertUserFromClerk } from "@/lib/data/users";
import { isAdminEmail } from "@/lib/services/clerk/roles";

// Prisma (driver adapter pg) exige runtime Node — nunca Edge.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Webhook do Clerk — mantem a tabela `users` em dia (F9).
 *
 * Seguranca: o Clerk assina via svix. Verificamos a assinatura com a
 * CLERK_WEBHOOK_SECRET (Svix signing secret do endpoint no painel) sobre o corpo
 * cru e os headers svix-*. Sem segredo -> 500 (misconfig; o Clerk reenfileira).
 *
 * Eventos tratados: user.created/updated -> upsert; user.deleted -> remove.
 * Outros eventos sao confirmados com 200 sem efeito.
 */

type ClerkEmail = { id: string; email_address: string };
type ClerkUserData = {
  id: string;
  email_addresses?: ClerkEmail[];
  primary_email_address_id?: string | null;
  first_name?: string | null;
  last_name?: string | null;
};
type ClerkEvent = { type: string; data: ClerkUserData };

function primaryEmail(data: ClerkUserData): string | null {
  const list = data.email_addresses ?? [];
  const primary = list.find((e) => e.id === data.primary_email_address_id);
  return (primary ?? list[0])?.email_address ?? null;
}

function fullName(data: ClerkUserData): string | null {
  const name = [data.first_name, data.last_name].filter(Boolean).join(" ").trim();
  return name || null;
}

export async function POST(req: Request) {
  const secret = process.env.CLERK_WEBHOOK_SECRET;
  if (!secret) {
    console.error("[clerk-webhook] CLERK_WEBHOOK_SECRET nao definido.");
    return NextResponse.json({ error: "webhook nao configurado" }, { status: 500 });
  }

  const svixId = req.headers.get("svix-id");
  const svixTimestamp = req.headers.get("svix-timestamp");
  const svixSignature = req.headers.get("svix-signature");
  if (!svixId || !svixTimestamp || !svixSignature) {
    return NextResponse.json({ error: "headers svix ausentes" }, { status: 400 });
  }

  // A verificacao svix usa o corpo CRU (nao pode ser o objeto ja parseado).
  const payload = await req.text();
  let evt: ClerkEvent;
  try {
    evt = new Webhook(secret).verify(payload, {
      "svix-id": svixId,
      "svix-timestamp": svixTimestamp,
      "svix-signature": svixSignature,
    }) as ClerkEvent;
  } catch {
    return NextResponse.json({ error: "assinatura invalida" }, { status: 401 });
  }

  try {
    switch (evt.type) {
      case "user.created":
      case "user.updated": {
        const email = primaryEmail(evt.data);
        if (!email) {
          console.warn(`[clerk-webhook] ${evt.type} sem e-mail (user ${evt.data.id}).`);
          return NextResponse.json({ received: true, skipped: "no_email" });
        }
        await upsertUserFromClerk({
          clerkUserId: evt.data.id,
          email,
          name: fullName(evt.data),
          emailIsAdmin: isAdminEmail(email),
        });
        return NextResponse.json({ received: true, type: evt.type });
      }
      case "user.deleted": {
        await deleteUserByClerkId(evt.data.id);
        return NextResponse.json({ received: true, type: evt.type });
      }
      default:
        return NextResponse.json({ received: true, ignored: evt.type });
    }
  } catch (err) {
    // Erro transitorio (ex.: banco): 500 para o Clerk reenviar.
    console.error(
      "[clerk-webhook] falha ao sincronizar:",
      err instanceof Error ? err.message : err,
    );
    return NextResponse.json({ error: "falha interna" }, { status: 500 });
  }
}
