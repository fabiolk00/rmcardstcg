# RM Cards — Project Overview

**Version**: 1.0-MVP  
**Status**: In Progress (Hardening Phase)  
**Last Updated**: 2025-06-15

## Project Goal

Build a **hardened MVP e-commerce platform** for trading cards with:
- Transações seguras e idempotentes
- Gestão confiável de estoque
- Auditoria completa
- Webhooks anti-replay
- Automação de reconciliação

## Milestones

### ✅ Milestone 1: Core (DONE)
- F1: Authentication (Clerk)
- F10: Database Hardening (Idempotency, Stock Reserve)
- F13: Email (Resend)
- F20: Documentation

### 🔄 Milestone 2: Hardening (IN PROGRESS)
- F14: Stock Reconciliation + pg_cron
- F15: Coupon System
- F16: Staging Deployment
- F17: Security Audit

### ⏳ Milestone 3: Production (UPCOMING)
- F18: Load testing
- F19: Monitoring/Alerting
- F21: Production deployment

## Tech Stack Decision

Framework: Next.js 15 (Full-stack, App Router)
Database: PostgreSQL (ACID, constraints)
ORM: Prisma (Type-safe, migrations)
Auth: Clerk (OAuth, Magic Links)
Payments: Asaas (PIX support)
Email: Resend (Transactional)
Automation: pg_cron (Database scheduler)

## Architecture Principles

### 1. Idempotency First
- checkoutKey (@unique) prevents duplicate charges
- asaasPaymentId (@unique) prevents duplicate payments
- All mutations safe to retry

### 2. Two-Phase Stock Reserve
- Checkout: stockReserved = true (blocks stock)
- Payment: stockCommitted = true (finalizes)

### 3. Immutable Audit Log
- Every mutation writes to AuditLog in same transaction
- Snapshots stored as JSONB before/after

### 4. Monetary Integrity
- All money as INT (centavos)
- Never floats

### 5. Webhook Reliability
- Webhooks are idempotent
- pg_cron reconciles failures nightly

## Success Criteria

- No duplicate orders from network retries
- Stock never oversells
- Complete audit trail of admin actions
- Webhooks processed exactly-once
- PIX expires reliably
- Coupons respected their limits
- Security audit finds no HIGH severity issues

See: README.md for full documentation
See: .agent-contexts/shared/ for architecture details
