# RM Cards — Architecture Overview

## Project Objective
E-commerce platform for trading cards with hardened MVP focus:
- Transações seguras e idempotentes (sem duplicação de pedidos/cobranças)
- Gestão confiável de estoque (reserva atômica)
- Auditoria completa (trilha imutável)
- Webhooks anti-replay (Asaas, Clerk)
- Automação (pg_cron reconciliação)

## Tech Stack
- **Frontend/Backend**: Next.js 15 (App Router) + TypeScript + React 19
- **Database**: PostgreSQL via Prisma ORM (Supabase in prod)
- **Auth**: Clerk + Svix webhooks
- **Payments**: Asaas API (sandbox mode)
- **Email**: Resend (mock-first, no-op without API key)
- **Automation**: pg_cron (PostgreSQL job scheduler)
- **Package Manager**: pnpm 10.32.1+

## Key Architecture Decisions

### 1. Idempotência de Checkout
**Problem**: Retry de network duplica pedido/cobrança
**Solution**: `checkoutKey` (hash do carrinho) é @unique → mesmo carrinho = mesma Order

### 2. Ciclo de Reserva de Estoque (Two-Phase)
**Problem**: Stock overselling em operações concorrentes
**Solution**:
- `stockReserved` = true no checkout (bloqueia estoque)
- `stockCommitted` = true no pagamento (baixa definitivo)
- Available = stock - reserved

### 3. Webhook Anti-Replay
**Problem**: Webhook duplicado (retry do Asaas)
**Solution**: `asaasPaymentId` @unique + WebhookEvent ledger

### 4. Auditoria em Transação
**Problem**: Mutação sem trilha
**Solution**: AuditLog na MESMA transação (Prisma $transaction)

### 5. Monetary Integrity (INT Centavos)
**Rule**: Nunca float. Tudo em Int (centavos).
- priceCents, subtotalCents, discountCents, shippingCents, totalCents

### 6. Snapshots Imutáveis
**Problem**: Produto muda de preço depois do pedido
**Solution**: OrderItem armazena productName, unitPriceCents (imutável)

### 7. pg_cron Reconciliação
**Problem**: PIX fica pending forever se webhook falhar
**Solution**: Job pg_cron noturno expira PIX após dueDate

## Data Model (8 Entities)

1. **User** — Clerk mirror (id, clerkUserId, email, name, role)
2. **Product** — Catalog (id, slug, sku, name, priceCents, stock, reserved)
3. **Order** — Pedido (id, userId, checkoutKey, asaasPaymentId, paymentStatus, dueDate, stockReserved, stockCommitted)
4. **OrderItem** — Snapshots (id, orderId, productId, productName, unitPriceCents, quantity)
5. **AuditLog** — Imutable trail (id, action, entityType, entityId, before/after JSONB, actor)
6. **Coupon** — Desconto (id, code, type, percentOff|valueCents, startsAt, expiresAt)
7. **CouponRedemption** — Usage (id, couponId, orderId @unique, discountCents)
8. **WebhookEvent** — Ledger (id, provider, eventId @unique, payload, processedAt)

## Naming Conventions
- **DB columns**: snake_case (price_cents, stock_reserved)
- **TypeScript**: camelCase (priceCents, stockReserved)
- **Mapping**: Via @map() in Prisma schema
- **Timestamps**: DateTime @db.Timestamptz(6)

## Feature Phases
- **F1**: Auth (Clerk) — DONE
- **F10**: Database Hardening — DONE
- **F13**: Email (Resend) — DONE
- **F14**: Stock Reconciliation — IN PROGRESS
- **F15**: Coupon System — UPCOMING
- **F16**: Staging Deployment — UPCOMING
- **F17**: Security Audit — UPCOMING
