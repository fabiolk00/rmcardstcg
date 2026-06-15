import { Webhook } from "svix";

import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { deleteUserByClerkId, upsertUserFromClerk } from "@/lib/data/users";
import {
  CLERK_PROVIDER,
  isWebhookEventProcessed,
  markWebhookEventProcessed,
  recordWebhookEvent,
} from "@/lib/data/webhookEvents";
import { isAdminEmail } from "@/lib/services/clerk/roles";

// Prisma (driver adapter pg) exige runtime Node — nunca Edge.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Webhook do Clerk — mantem a tabela `users` em dia (F9).
 *
 * Seguranca: o Clerk assina via svix; verificamos a assinatura com a
 * CLERK_WEBHOOK_SECRET sobre o corpo cru + headers svix-*.
 *
 * Idempotencia (H3): ledger webhook_events (provider='clerk', event_id = svix-id,
 * estavel por entrega) + o efeito (upsert/delete) na MESMA transacao. Reenvio com
 * o mesmo svix-id (apos processed_at) vira no-op 2xx; crash entre registrar e
 * aplicar nao perde o efeito (reprocessa enquanto processed_at IS NULL).
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
    // Ledger + efeito + mark-processed na MESMA transacao (H3).
    const outcome = await prisma.$transaction(
      async (tx) => {
        const { firstTime } = await recordWebhookEvent(tx, {
          provider: CLERK_PROVIDER,
          eventId: svixId,
          type: evt.type,
          payload: JSON.parse(payload) as never,
        });
        if (!firstTime && (await isWebhookEventProcessed(tx, CLERK_PROVIDER, svixId))) {
          return { duplicate: true as const };
        }

        let applied: "upserted" | "deleted" | "skipped_no_email" | "ignored" = "ignored";
        switch (evt.type) {
          case "user.created":
          case "user.updated": {
            const email = primaryEmail(evt.data);
            if (!email) {
              applied = "skipped_no_email";
              break;
            }
            await upsertUserFromClerk(
              {
                clerkUserId: evt.data.id,
                email,
                name: fullName(evt.data),
                emailIsAdmin: isAdminEmail(email),
              },
              tx,
            );
            applied = "upserted";
            break;
          }
          case "user.deleted": {
            await deleteUserByClerkId(evt.data.id, tx);
            applied = "deleted";
            break;
          }
          default:
            applied = "ignored";
        }

        await markWebhookEventProcessed(tx, CLERK_PROVIDER, svixId);
        return { duplicate: false as const, applied };
      },
      { timeout: 15000, maxWait: 5000 },
    );

    if (outcome.duplicate) {
      console.info(`[clerk-webhook] evento ${svixId} ja processado (reenvio).`);
      return NextResponse.json({ received: true, duplicate: true });
    }
    if (outcome.applied === "skipped_no_email") {
      console.warn(`[clerk-webhook] ${evt.type} sem e-mail (user ${evt.data.id}).`);
      return NextResponse.json({ received: true, skipped: "no_email" });
    }
    return NextResponse.json({ received: true, type: evt.type });
  } catch (err) {
    // Erro transitorio: 500 p/ o Clerk reenviar. Ledger + efeito sao a MESMA
    // transacao (rollback), entao o reenvio reprocessa com seguranca.
    console.error(
      "[clerk-webhook] falha ao sincronizar:",
      err instanceof Error ? err.message : err,
    );
    return NextResponse.json({ error: "falha interna" }, { status: 500 });
  }
}
