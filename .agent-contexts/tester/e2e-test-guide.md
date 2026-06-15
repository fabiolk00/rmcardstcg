# Tester Agent — Context

## Purpose
Verify features work end-to-end and edge cases are handled.
Manual E2E testing on dev server (no unit tests in MVP).

## E2E Flows to Test

### Flow 1: Catalog → Checkout → Payment → Email
Steps:
1. Open http://localhost:3000
2. Browse products, filter by category
3. Click product detail, verify stock shows
4. Add to cart (check localStorage or server session)
5. Proceed to checkout, fill shipping address
6. Apply coupon (if exists), verify discount
7. Choose payment method (PIX in sandbox)
8. Complete order
9. Verify:
   - Order created in DB (SELECT * FROM orders WHERE id = <your-order-id>)
   - Stock reserved: SELECT stock, reserved FROM products WHERE id = '<product-id>'
   - Email sent (check Resend logs or console)
   - Payment pending: SELECT payment_status FROM orders WHERE id = <order-id>
10. In Asaas sandbox, mark payment as paid
11. Verify webhook received: SELECT * FROM webhook_events WHERE provider = 'Asaas'
12. Verify stock committed: SELECT stock_committed FROM orders WHERE id = <order-id>
13. Verify payment email sent

### Flow 2: Admin CRUD → Audit Log
Steps:
1. Login as admin (ADMIN_EMAILS bootstrap)
2. Create product: POST /admin/produtos
3. Verify in DB:
   - Product created
   - AuditLog entry: SELECT * FROM audit_log WHERE entity_id = '<product-id>'
4. Edit product price: PUT /admin/produtos/[id]
5. Verify AuditLog has before/after JSONB snapshots
6. Inactivate product: DELETE /admin/produtos/[id]
7. Verify is_active = false

### Flow 3: Webhook Anti-Replay
Steps:
1. Manually trigger webhook twice with same event_id
2. Check WebhookEvent table: should have 1 entry with both received_at and processed_at
3. Verify Order payment_status updated only once

### Flow 4: Stock Reconciliation (pg_cron)
Steps:
1. Create order with PIX, set due_date to past
2. Manually call: GET /api/internal/reconcile-orders (with x-cron-secret header)
3. Verify in DB:
   - Order payment_status = 'cancelled'
   - Product reserved decreased
4. Check CloudWatch logs if deployed

## Edge Cases to Test

- [ ] Network retry: Refresh checkout page during payment (idempotency)
- [ ] Race condition: Create 2 orders for same product → verify stock math
- [ ] Coupon limits: Try redeeming expired coupon → expect error
- [ ] Coupon per-user: Redeem same coupon twice on different orders
- [ ] Stock oversell: Manually set reserved > stock → should have CHECK error
- [ ] Missing webhook secret: Call /api/internal/reconcile-orders without header → 500
- [ ] Malformed Clerk webhook: Send bad Svix signature → 400
- [ ] Asaas duplicate event: Send webhook twice with same event_id → no duplicate order
- [ ] PIX expiration: Order past due_date but payment_status still pending → cron expires it
- [ ] Cascade delete: Delete order → verify OrderItems deleted, AuditLog preserved

## Tools & Debugging

### Browser Network Tab
1. Open DevTools → Network tab
2. Perform action (checkout, webhook, etc.)
3. Check requests/responses:
   - Is checkout endpoint called once? (idempotency)
   - Does webhook show 200 OK?
   - Are emails queued?

### Database Queries (psql)
```sql
-- Stock state
SELECT id, name, stock, reserved, (stock - reserved) as available FROM products;

-- Pending orders
SELECT id, payment_status, stock_reserved, stock_committed, due_date 
FROM orders WHERE payment_status = 'pending' ORDER BY created_at DESC;

-- Audit trail
SELECT action, entity_id, before, after, actor_email 
FROM audit_log ORDER BY created_at DESC LIMIT 20;

-- Webhooks pending
SELECT provider, event_id, type, received_at, processed_at 
FROM webhook_events WHERE processed_at IS NULL;

-- Coupon usage
SELECT c.code, cr.order_id, cr.discount_cents 
FROM coupon_redemptions cr
JOIN coupons c ON cr.coupon_id = c.id
ORDER BY cr.created_at DESC;
```

### Logs
- Next.js dev server: Check terminal for errors
- Prisma: Set DEBUG=prisma:* && pnpm dev (verbose SQL)
- Clerk: Dashboard > Integrations > Webhooks (delivery history)
- Asaas: Dashboard > Webhooks (delivery logs)

## Test Report Template

After testing feature:
```
## FEATURE: [F#] Name
## DATE: 2025-06-XX
## STATUS: PASS | FAIL

### Flows Tested
- [ ] Flow 1 (Catalog → Checkout → Payment)
- [ ] Flow 2 (Admin CRUD → Audit)
- [ ] Flow 3 (Webhook Anti-Replay)

### Edge Cases
- [ ] Idempotency (checkout retry)
- [ ] Stock oversell prevention
- [ ] Coupon limits enforced
- [ ] Webhook deduplication

### Issues Found
[List any bugs or unexpected behavior]

### Notes
[Additional observations]
```

See: .planning/claude-progress.txt for next feature to test
See: .planning/feature_list.json for priorities
