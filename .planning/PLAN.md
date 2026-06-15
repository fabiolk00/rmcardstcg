# Phase Plan: Hardening (V2)

**Phase**: Hardening MVP  
**Status**: In Progress  
**Duration**: 7-8 hours (estimated)  
**Start**: 2025-06-15

## Objective

Complete hardening features for production-ready MVP:
- Stock reconciliation automation
- Coupon system with validation
- Staging deployment
- Security audit

## Feature Roadmap

### F14: Stock Reconciliation + pg_cron (1-1.5h)
Expire PIX pending orders after vencimento, libera estoque

**Tasks**:
1. /api/internal/reconcile-orders endpoint
   - Verifica dueDate < now()
   - Updates paymentStatus = cancelled
   - Libera reserved stock (atomicamente)
2. Test with DB queries
3. Manual testing

**Acceptance Criteria**:
- Endpoint authenticates via CRON_RECONCILE_SECRET
- Pending orders expire correctly
- Stock reserved is freed
- AuditLog captures transition

### F15: Coupon System (2.5h)
Discount coupons with percent/fixed, limits, validity period

**Tasks**:
1. API endpoints (POST/PUT/GET/DELETE /admin/cupons)
2. Validation logic:
   - min_subtotal_cents check
   - max_redemptions global limit
   - per_user_limit check
   - Validity period enforcement
   - Code case-insensitive
3. Redemption endpoint: POST /checkout with coupon_code
4. Discount calculation in order total

**Acceptance Criteria**:
- All CRUD endpoints work
- Validation enforced
- Discount applied to order.total
- Redemption idempotent per order
- Coupon not reused after limit
- AuditLog for coupon changes

### F16: Staging Deployment (1h)
Deploy to Vercel staging, test E2E flows

**Tasks**:
1. Create Vercel staging environment
2. Set env vars
3. Run db:migrate on staging
4. E2E test: catalog → checkout → payment → email
5. Verify webhooks work

**Acceptance Criteria**:
- Staging env is live
- Env vars configured
- E2E flow works start-to-finish
- Webhooks trigger and process
- No critical errors in logs

### F17: Security Audit (1.5h)
Review code for security, compliance, performance

**Tasks**:
1. Code review:
   - SQL injection checks
   - Auth bypass tests
   - Race conditions
   - Monetary errors
2. Webhook validation
3. Database constraints verification

**Acceptance Criteria**:
- No HIGH severity issues
- Webhooks validated
- Database constraints correct
- Performance acceptable

## Definition of Done (per feature)

- Code implemented
- Manual E2E tested
- Code reviewed
- AuditLog entries verified
- Database state correct
- Git commits atomic
- Documentation updated
- No blocking issues

## Next Phase (Production)

- F18: Load testing
- F19: Monitoring + Alerting
- F21: Production deployment

See: .planning/claude-progress.txt for session updates
See: .planning/feature_list.json for priorities
