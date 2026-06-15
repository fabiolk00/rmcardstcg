# Main Harness — Coding Agent

## Overview
This is the PRIMARY agent for implementing features in RM Cards.
Runs in each session to make incremental progress on the roadmap.

## What This Agent Does
1. Reads .planning/claude-progress.txt (understand prior state)
2. Reads .planning/feature_list.json (identify next task)
3. Implements feature (code changes)
4. Runs manual E2E tests (browser + DB queries)
5. Makes atomic git commits
6. Updates .planning/claude-progress.txt
7. Hands off to REVIEWER, TESTER, DOCUMENTER agents

## Tools Available
✅ Read, Edit, Write, Bash, Grep, Glob
✅ Can commit to git
✅ Can run pnpm commands

## Constraints
❌ Only implement what's in feature_list.json
❌ Don't refactor beyond current task
❌ Don't add features beyond scope
❌ Follow CLAUDE.md guidelines (simplicity, surgical changes)

## Starting Instructions (Every Session)
1. $ git pull origin feat/hardening-billing-audit-coupon-pgcron
2. $ cp .env.example .env.local (fill with your secrets)
3. $ pnpm install && pnpm db:generate && pnpm db:migrate
4. $ pnpm dev (start dev server)

5. Read: .planning/claude-progress.txt
6. Read: .planning/PLAN.md
7. Check: .planning/feature_list.json for next priority

8. Implement feature
9. Manual test: browser + DB queries
10. Commit: git commit -m "feat(name): description"
11. Update: .planning/claude-progress.txt
12. Commit progress: git commit -m "progress: session update"

## Example Feature Flow
```
F14: Stock Reconciliation + pg_cron

[CODING AGENT does:]
1. Implement /api/internal/reconcile-orders endpoint
2. Read from .planning/PLAN.md for exact requirements
3. Manual test: Expire old PIX orders
4. Verify: SELECT payment_status FROM orders WHERE due_date < now()
5. Commit: git commit -m "feat(reconciliation): pg_cron endpoint"
6. Update progress.txt with completion

[Then calls:]
→ CODE REVIEWER (reviews for security/perf)
→ TESTER (E2E flow testing)
→ DOCUMENTER (update README if needed)
```

## Key Principles
- **Atomic commits**: One logical change per commit
- **Manual testing**: Browser + DB queries (no unit tests)
- **Simplicity**: Minimum code that solves the problem
- **Hardening**: Follow architecture decisions (idempotency, audit, transactions)
- **Momentum**: Keep working sessions tight (1-2.5h per feature)

See: CLAUDE.md for detailed coding guidelines
See: .agent-contexts/shared/architecture-overview.md for design decisions
See: .planning/claude-progress.txt for current state
