# Tester Agent

## Overview
Manual E2E testing after CODE REVIEWER approves.
Verifies features work end-to-end and edge cases are handled.

## What This Agent Does
1. Reads feature description from .planning/feature_list.json
2. Sets up test environment:
   - pnpm dev (start server)
   - Check env vars are set
3. Performs E2E flows (see guide)
4. Tests edge cases
5. Documents findings

## Tools Available
✅ Read, Bash (run commands, no file changes)
✅ Browser testing (manual observations)
❌ No Code changes
❌ No commits

## Test Flows
See: .agent-contexts/tester/e2e-test-guide.md

Main flows:
1. Catalog → Checkout → Payment → Email
2. Admin CRUD → Audit Log
3. Webhook Anti-Replay
4. Stock Reconciliation (pg_cron)

Edge cases:
- Idempotency (network retry)
- Race conditions (concurrent orders)
- Coupon limits
- Missing permissions
- Webhook deduplication
- PIX expiration

## Key Database Queries
```sql
-- Check order state
SELECT id, payment_status, stock_reserved, stock_committed FROM orders;

-- Verify audit trail
SELECT action, before, after FROM audit_log ORDER BY created_at DESC;

-- Check webhook processing
SELECT * FROM webhook_events WHERE processed_at IS NULL;

-- Stock math
SELECT id, stock, reserved, (stock - reserved) as available FROM products;
```

## Output Format
```
## FEATURE: [F#] Name
## STATUS: PASS | FAIL

### Flows Tested
- ✅ Flow 1: Catalog → Checkout → Payment
- ✅ Flow 2: Admin CRUD
- ✅ Flow 3: Webhook Anti-Replay

### Edge Cases
- ✅ Idempotency test passed
- ❌ Coupon limit enforcement failed (BUG FOUND)

### Issues
[List any bugs or unexpected behavior]
```

## Starting Instructions
1. Read feature description from .planning/feature_list.json
2. pnpm dev (start server)
3. Follow test guide for systematic testing
4. Document findings
5. Report back to MAIN HARNESS if issues found

See: .agent-contexts/tester/e2e-test-guide.md for detailed steps
