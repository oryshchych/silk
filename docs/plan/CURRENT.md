# CURRENT.md: working state

> Memory between sessions. State lives here and in git, not in context.
> **The agent updates this file as the last action of every session.**

## Current phase

**Phase 5, "admin: orders and customers": all 5 acceptance criteria verified by execution** (2026-11-26,
about 3 hours 15 minutes, 7 PRs, 1 review round each (2 pushes on #80)). Two caveats: the Nova Poshta adapter is verified only against
a local fake (Q49), and a "report" is the accountant's CSV (the reports screen is phase 10). Phase 6
(SEO) starts in a NEW session. Standing rules (`AGENTS.md` section 0): English technical text; one phase per session.

Infra: staging `https://staging.damazla.com` (basic auth), Hetzner CAX11, Dokploy. Next 16.4.6.

## Done (phase 5, merged PRs)

- #72 orders list, card, workflow, cancel with a comment, notes, transfer receipt (per-role DTO)
- #73 edit items with recalculation, admin refund (request id makes a partial refund idempotent)
- #74 Nova Poshta waybill (migration 0013, print route, buyer email); #75 customers, tags, CSV exports
- #77 refund sweep job, withdraw and resolve; #78 migration 0014 (Q42), orders behind a reservation (Q44)
- #80 user management for the owner (Q41); this docs PR holds the report and queue entries
- On `main`: `pnpm test:int` 688 tests in 41 files; smoke-web covers orders, customers, exports, users

## Next step

1. Owner hands: Q40, Q45, Q13, Q2, Q3, Q32, Q24, Q8, Q19, Q1 and the new Q49 (carrier key and `np_sender`).
2. Phase 6 (SEO) in a NEW session; it starts on the standing go-ahead (`docs/AUTONOMOUS_MODE.md`).

## Acceptance criteria

- [x] Waybill created, stored, email sent, tracking link: `waybill.int.test.ts` (29), `waybill-email.int.test.ts`,
  `orders-waybill.int.test.ts` (real adapter over HTTP against the fake). NOT run against the real API (Q49)
- [x] Editing a paid order recalculates the total and writes history: `orders-edit.int.test.ts` (14)
- [x] Refund through the provider API changes `payment_status`, visible in the report: `orders-refund-edit.int.test.ts`
  (real `MonoProvider` over a socket); the accountant CSV carries received and refunded (`customers-admin.int.test.ts`)
- [x] Customer card shows sizes derived from purchases: `customers-admin.int.test.ts` (units per size, cancelled ignored)
- [x] A list of 10 000 orders opens in under 500 ms: `orders-admin.int.test.ts` and `customers-admin.int.test.ts`
  assert it at the read layer (page rendering is not timed)

## Not built or not verified

- Adding a product line to an order, re-pricing shipping after an edit (Q52); carrier cancel of a waybill (Q50)
- Refund status lookup at the provider (Q53); forced password change (Q55); a component click test tool (Q51)
- Real carrier and provider runs (Q49, Q13); the stock screen role test for the page itself (read layer tested)

## Caveats

- Local smoke shows storefront and checkout FAILs on a stale dev database; CI is authoritative
- Flaky candidates under full-suite load (`NOTES.md`): an auth timing test, the category-cycle race test

## Deviations from the plan
- Skeleton jump `pending`/`confirmed` to `shipped` stays in core; the admin path enforces the steps (Q54)
- Waybill adapter lives in `packages/payments/src/shipping`, not a new package; customers are derived from orders
- Added beyond the plan, from the reviews: refund sweep, user management (Q41), migration 0014 (Q42), Q44 list
- Owner queue entries added: Q48 to Q56
