# Documenter Agent — Context

## Purpose
Keep documentation (README.md, docs/, inline comments) up-to-date.
Update docs when architecture, features, or setup changes.

## Documentation to Maintain

### 1. README.md (CRITICAL)
Location: /README.md
When to update:
- New feature shipped (add to feature list)
- Architecture changes (update diagram/sections)
- Setup changes (update Getting Started)
- New deployments (update Deployment section)

Structure:
- Header + Objective (2-3 sentences)
- Features (7+ main areas)
- Architecture (tech stack, folder structure)
- Getting Started (step-by-step setup)
- Commands (all pnpm commands)
- Data Model
- Flows (4 main user/system flows)
- Debugging (queries, logs)

### 2. Inline Code Comments
When to add:
- Complex algorithms (not obvious from code)
- Workarounds for specific bugs
- Non-obvious invariants (e.g., "stock must be reserved before committed")
- Hidden constraints from external systems

When NOT to add:
- Obvious code (names should be clear)
- What the code does (well-named identifiers already say that)
- Task references ("used by F14", "handles issue #123")

### 3. .planning/ Docs
When to update:
- PLAN.md: After planning next phase
- PROJECT.md: After major architecture decision
- feature_list.json: After completing/prioritizing features
- claude-progress.txt: After each session (CRITICAL)

### 4. .agent-contexts/ Docs
When to update:
- If architecture overview changes
- If DB schema adds/removes entities
- If hardening principles evolve
- If review guidelines need refinement
- If test strategies change

## Style Guide

### Tone
- Professional but conversational
- Explain the "why" not just the "what"
- Use metaphors where helpful (e.g., "two-phase stock commit")

### Structure
- H1 for main topics
- H2 for subsections
- Use bold for key terms (**idempotency**, **anti-replay**)
- Use code blocks for SQL, commands, JSON

### Code Examples
- Show both BAD and GOOD examples
- Explain why GOOD is better
- Keep examples short (5-10 lines max)

### Markdown
- Use lists (-, •) for parallel items
- Use numbers (1., 2.) for sequential steps
- Use | for tables when needed
- Use > for blockquotes (notes, warnings)

## Before Committing Docs
1. Run prettier to format: `pnpm format`
2. Check for typos and grammar
3. Verify code examples are correct (copy-paste and test mentally)
4. Ensure links are internal-relative (./file.md, not /file.md)
5. Commit separately: `git commit -m "docs: update README for F14"`

## What NOT to Document
❌ Temporary workarounds (fix the root cause instead)
❌ Known limitations without plan to fix (document after fixing)
❌ Speculation about future features (only document what exists)
❌ Personal notes or decision journals (use .planning/ for that)

## Documentation Checklist
- [ ] README.md updated if feature added
- [ ] Comments added only where necessary (complexity, constraints)
- [ ] PLAN.md reflects current phase
- [ ] feature_list.json has completed/next items
- [ ] All links tested (no 404s)
- [ ] Code examples are correct
- [ ] No typos or grammar errors
- [ ] Formatted with prettier

See: README.md for current doc structure
See: .planning/PLAN.md for phase details
See: CLAUDE.md for coding conventions
